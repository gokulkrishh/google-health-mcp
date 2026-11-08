import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { escapeHtml, readForm, readJson, sameSecret, sendJson, sendPage } from "./web.js";

/**
 * A stateless OAuth 2.1 authorization server for MCP clients (Claude, ChatGPT, Grok, Claude Code).
 * Client ids, codes and tokens are HMAC-signed claims keyed from MCP_HTTP_TOKEN, so nothing is
 * stored, and changing MCP_HTTP_TOKEN revokes every client at once.
 * The owner approves a client by typing MCP_HTTP_TOKEN into this server's own page.
 */

export const OAUTH_SCOPE = "health.read";
const CODE_TTL_SECONDS = 300;
const ACCESS_TTL_SECONDS = 3600;
const REFRESH_TTL_SECONDS = 90 * 86400;
const MAX_REDIRECT_URIS = 5;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

type Kind = "client" | "code" | "access" | "refresh";

interface ClientClaims {
  k: "client";
  r: string[];
  n: string;
}
interface CodeClaims {
  k: "code";
  c: string;
  r: string;
  ch: string;
  exp: number;
  j: string;
}
interface TokenClaims<K extends "access" | "refresh"> {
  k: K;
  c: string;
  exp: number;
  j: string;
}
type Claims = ClientClaims | CodeClaims | TokenClaims<"access"> | TokenClaims<"refresh">;
type ClaimsOf<K extends Kind> = Extract<Claims, { k: K }>;

const nowSeconds = () => Math.floor(Date.now() / 1000);
const nonce = () => randomBytes(9).toString("base64url");
const clientRef = (clientId: string) => createHash("sha256").update(clientId).digest("base64url").slice(0, 22);

export class OAuthSigner {
  private readonly key: Buffer;

  constructor(secret: string) {
    this.key = createHmac("sha256", "google-health-mcp/oauth/v1").update(secret).digest();
  }

  sign(claims: Claims): string {
    const body = Buffer.from(JSON.stringify(claims)).toString("base64url");
    return `${body}.${this.mac(body)}`;
  }

  verify<K extends Kind>(token: string | null | undefined, kind: K): ClaimsOf<K> | undefined {
    const [body, mac, extra] = (token ?? "").split(".");
    if (!body || !mac || extra !== undefined) return undefined;
    const expected = Buffer.from(this.mac(body));
    const given = Buffer.from(mac);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) return undefined;
    let claims: Claims;
    try {
      claims = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    } catch {
      return undefined;
    }
    if (claims.k !== kind) return undefined;
    if ("exp" in claims && claims.exp < nowSeconds()) return undefined;
    return claims as ClaimsOf<K>;
  }

  private mac(body: string): string {
    return createHmac("sha256", this.key).update(body).digest("base64url");
  }
}

/** https anywhere, or http only on the loopback interface (Claude Code and other local clients). */
export function isAllowedRedirectUri(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.hash || url.username || url.password) return false;
  return url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname));
}

/** Exact match, except loopback http URIs may use any port (RFC 8252, section 7.3). */
export function redirectMatches(registered: string[], given: string): boolean {
  if (registered.includes(given)) return true;
  let g: URL;
  try {
    g = new URL(given);
  } catch {
    return false;
  }
  if (g.protocol !== "http:" || !LOOPBACK_HOSTS.has(g.hostname)) return false;
  return registered.some((r) => {
    try {
      const u = new URL(r);
      return u.protocol === "http:" && u.hostname === g.hostname && u.pathname === g.pathname && u.search === g.search;
    } catch {
      return false;
    }
  });
}

export function pkceMatches(verifier: string, challenge: string): boolean {
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return false;
  return sameSecret(createHash("sha256").update(verifier).digest("base64url"), challenge);
}

interface AuthorizeParams {
  clientId: string;
  client: ClientClaims;
  redirectUri: string;
  codeChallenge: string;
  state: string;
}

export function createOAuthRoutes(base: string, ownerToken: string, signer: OAuthSigner) {
  const resource = `${base}/mcp`;
  const resourceMetadataUrl = `${base}/.well-known/oauth-protected-resource`;

  const protectedResource = {
    resource,
    authorization_servers: [base],
    scopes_supported: [OAUTH_SCOPE],
    bearer_methods_supported: ["header"],
    resource_name: "Google Health MCP",
  };
  const authorizationServer = {
    issuer: base,
    authorization_endpoint: `${base}/authorize`,
    token_endpoint: `${base}/token`,
    registration_endpoint: `${base}/register`,
    scopes_supported: [OAUTH_SCOPE],
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
  };

  function issueTokens(clientId: string) {
    const c = clientRef(clientId);
    const exp = nowSeconds();
    return {
      access_token: signer.sign({ k: "access", c, exp: exp + ACCESS_TTL_SECONDS, j: nonce() }),
      refresh_token: signer.sign({ k: "refresh", c, exp: exp + REFRESH_TTL_SECONDS, j: nonce() }),
      token_type: "Bearer",
      expires_in: ACCESS_TTL_SECONDS,
      scope: OAUTH_SCOPE,
    };
  }

  /** Validates an authorize request. Returns params, or an error page message when redirecting would be unsafe. */
  function parseAuthorize(get: (name: string) => string | null): AuthorizeParams | { error: string } {
    const clientId = get("client_id") ?? "";
    const client = signer.verify(clientId, "client");
    if (!client) return { error: "This app isn't registered with this server. Remove the connector and add it again." };
    const redirectUri = get("redirect_uri") ?? (client.r.length === 1 ? client.r[0]! : "");
    if (!redirectMatches(client.r, redirectUri)) return { error: "The app's return address doesn't match its registration." };
    if (get("response_type") !== "code" || get("code_challenge_method") !== "S256" || !get("code_challenge")) {
      return { error: "The app sent an incomplete sign-in request (it must use PKCE with S256)." };
    }
    const requested = get("resource");
    if (requested && requested.replace(/\/+$/, "") !== resource) return { error: "The app asked for a different server." };
    return { clientId, client, redirectUri, codeChallenge: get("code_challenge")!, state: get("state") ?? "" };
  }

  function consentPage(res: ServerResponse, p: AuthorizeParams, status = 200, problem = ""): void {
    const returnHost = new URL(p.redirectUri).host;
    const hidden = (name: string, value: string) => `<input type="hidden" name="${name}" value="${escapeHtml(value)}">`;
    sendPage(
      res,
      status,
      "Connect an app",
      `${problem ? `<p><b>${escapeHtml(problem)}</b></p>` : ""}
<p>An app that returns to <b>${escapeHtml(returnHost)}</b> wants read-only access to your Google Health data on this server. It calls itself "${escapeHtml(p.client.n)}".</p>
<p class="note">Claude returns to claude.ai, ChatGPT to chatgpt.com, Claude Code to localhost. If the address isn't the app you just used, close this page.</p>
<form method="post" action="/authorize">
${hidden("client_id", p.clientId)}${hidden("redirect_uri", p.redirectUri)}${hidden("code_challenge", p.codeChallenge)}${hidden("code_challenge_method", "S256")}${hidden("response_type", "code")}${hidden("state", p.state)}
<label for="key">Your access token (<code>MCP_HTTP_TOKEN</code>)</label>
<input id="key" type="password" name="key" autocomplete="current-password" required autofocus>
<button type="submit">Allow access</button>
</form>
<p class="note">Your token stays on this page; the app never sees it.</p>`,
    );
  }

  async function authorize(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    if (req.method === "GET") {
      const parsed = parseAuthorize((n) => url.searchParams.get(n));
      if ("error" in parsed) return sendPage(res, 400, "Can't connect this app", `<p>${escapeHtml(parsed.error)}</p>`);
      return consentPage(res, parsed);
    }
    if (req.method !== "POST") return void res.writeHead(405, { allow: "GET, POST" }).end();
    const form = await readForm(req);
    const parsed = parseAuthorize((n) => form.get(n));
    if ("error" in parsed) return sendPage(res, 400, "Can't connect this app", `<p>${escapeHtml(parsed.error)}</p>`);
    const key = form.get("key")?.trim() ?? "";
    if (!key || !sameSecret(key, ownerToken)) return consentPage(res, parsed, 401, "That access token is not right.");

    const code = signer.sign({ k: "code", c: clientRef(parsed.clientId), r: parsed.redirectUri, ch: parsed.codeChallenge, exp: nowSeconds() + CODE_TTL_SECONDS, j: nonce() });
    const back = new URL(parsed.redirectUri);
    back.searchParams.set("code", code);
    if (parsed.state) back.searchParams.set("state", parsed.state);
    back.searchParams.set("iss", base);
    res.writeHead(302, { location: back.toString(), "cache-control": "no-store" }).end();
  }

  async function token(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== "POST") return void res.writeHead(405, { allow: "POST" }).end();
    const form = await readForm(req);
    const fail = (error: string, description: string) => sendJson(res, 400, { error, error_description: description });
    const clientId = form.get("client_id") ?? "";
    if (!signer.verify(clientId, "client")) return fail("invalid_client", "Unknown client.");

    if (form.get("grant_type") === "authorization_code") {
      const code = signer.verify(form.get("code"), "code");
      if (!code || code.c !== clientRef(clientId)) return fail("invalid_grant", "The code is invalid or expired.");
      if (form.get("redirect_uri") && form.get("redirect_uri") !== code.r) return fail("invalid_grant", "redirect_uri does not match.");
      if (!pkceMatches(form.get("code_verifier") ?? "", code.ch)) return fail("invalid_grant", "PKCE verification failed.");
      return sendJson(res, 200, issueTokens(clientId));
    }
    if (form.get("grant_type") === "refresh_token") {
      const refresh = signer.verify(form.get("refresh_token"), "refresh");
      if (!refresh || refresh.c !== clientRef(clientId)) return fail("invalid_grant", "The refresh token is invalid or expired.");
      return sendJson(res, 200, issueTokens(clientId));
    }
    return fail("unsupported_grant_type", "Use authorization_code or refresh_token.");
  }

  async function register(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== "POST") return void res.writeHead(405, { allow: "POST" }).end();
    const body = (await readJson(req)) as { redirect_uris?: unknown; client_name?: unknown } | undefined;
    const uris = Array.isArray(body?.redirect_uris) ? body.redirect_uris.filter((u): u is string => typeof u === "string") : [];
    if (uris.length === 0 || uris.length > MAX_REDIRECT_URIS || !uris.every((u) => u.length <= 500 && isAllowedRedirectUri(u))) {
      return sendJson(res, 400, { error: "invalid_redirect_uri", error_description: "Provide 1 to 5 https (or http loopback) redirect URIs." });
    }
    const name = typeof body?.client_name === "string" && body.client_name.trim() ? body.client_name.trim().slice(0, 80) : "An AI app";
    const clientId = signer.sign({ k: "client", r: uris, n: name });
    sendJson(res, 201, {
      client_id: clientId,
      client_id_issued_at: nowSeconds(),
      client_name: name,
      redirect_uris: uris,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: OAUTH_SCOPE,
    });
  }

  const routes: Record<string, (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<void>> = {
    "/.well-known/oauth-protected-resource": async (_req, res) => sendJson(res, 200, protectedResource),
    "/.well-known/oauth-protected-resource/mcp": async (_req, res) => sendJson(res, 200, protectedResource),
    "/.well-known/oauth-authorization-server": async (_req, res) => sendJson(res, 200, authorizationServer),
    "/authorize": authorize,
    "/token": token,
    "/register": register,
  };

  return {
    routes,
    /** True for a valid, unexpired OAuth access token issued by this server. */
    isAccessToken: (value: string | undefined) => Boolean(signer.verify(value, "access")),
    unauthorizedHeader: `Bearer resource_metadata="${resourceMetadataUrl}", scope="${OAUTH_SCOPE}"`,
  };
}
