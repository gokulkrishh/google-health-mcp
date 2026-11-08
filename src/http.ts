import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { HealthClient } from "./api.js";
import { completeSignIn, missingSetup, publicBaseUrl, requestedScopeIds, startSignIn } from "./auth.js";
import { createServer } from "./tools.js";

export const MIN_TOKEN_LENGTH = 32;
const MCP_PATHS = new Set(["/mcp", "/api/mcp"]);
const SIGN_IN_COOKIE = "__Host-gh_signin";
const SIGN_IN_TTL_SECONDS = 600;
const MAX_FORM_BYTES = 4096;

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

function sameSecret(a: string, b: string): boolean {
  return timingSafeEqual(digest(a), digest(b));
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function sendPage(res: ServerResponse, status: number, title: string, bodyHtml: string, headers: Record<string, string | string[]> = {}): void {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-frame-options": "DENY", ...headers });
  res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${escapeHtml(title)}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;color:#222;background:#fff}input,button{font:inherit;padding:.5rem;width:100%;box-sizing:border-box;margin:.25rem 0}code{background:#f2f2f2;padding:.1em .3em;border-radius:4px;overflow-wrap:anywhere}code.pick{user-select:all;cursor:pointer}ol ol{margin:.4rem 0}li{margin:.35rem 0}@media (prefers-color-scheme:dark){body{color:#ddd;background:#111}code{background:#222}}</style>
</head><body><h1>${escapeHtml(title)}</h1>${bodyHtml}</body></html>`);
}

async function readForm(req: IncomingMessage): Promise<URLSearchParams> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_FORM_BYTES) throw new Error("Form too large.");
    chunks.push(chunk as Buffer);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

function readCookie(req: IncomingMessage, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return undefined;
}

function signInCookie(value: string, maxAge: number): string {
  return `${SIGN_IN_COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

function setupPage(missing: { googleClient: boolean; blobStore: boolean }): string {
  const base = publicBaseUrl();
  const redirect = escapeHtml(`${base ?? "https://YOUR-APP"}/oauth2callback`);
  const scopes = requestedScopeIds().map((s) => `<code>${escapeHtml(s.replace("https://www.googleapis.com/auth/", ""))}</code>`).join(", ");
  const steps: string[] = [];
  if (missing.blobStore) {
    steps.push("<li><b>Add a private Blob store.</b> In Vercel open <b>Storage → Create → Blob</b>, choose <b>Private</b> and connect it to this project.</li>");
  }
  if (missing.googleClient) {
    steps.push(`<li><b>Create a Google sign-in for this app</b> (about 5 minutes):<ol>
<li><a href="https://console.cloud.google.com/projectcreate" rel="noopener">Create a Google Cloud project</a> (any name).</li>
<li><a href="https://console.cloud.google.com/apis/library/health.googleapis.com" rel="noopener">Enable the Google Health API</a>.</li>
<li>In <a href="https://console.cloud.google.com/auth/overview" rel="noopener">Google Auth Platform</a>: fill in <b>Branding</b> (any app name, your email). Under <b>Audience</b> choose <b>External</b>, add your Gmail as a test user, then click <b>Publish app</b> so the sign-in doesn't expire every 7 days.</li>
<li>Under <b>Data Access</b>, add these scopes: ${scopes}.</li>
<li>Under <b>Clients</b>, create a <b>Web application</b> client with this redirect URI (click to select): <code class="pick">${redirect}</code></li>
</ol></li>
<li><b>Add the client to Vercel.</b> In <b>Settings → Environment Variables</b> add <code>GOOGLE_CLIENT_ID</code> and <code>GOOGLE_CLIENT_SECRET</code>, then <b>Deployments → Redeploy</b>.</li>`);
  }
  steps.push("<li>Reload this page and sign in with Google.</li>");
  return `<p>A few things are still needed before this server can read your Fitbit data.</p><ol>${steps.join("")}</ol><p><a href="/">Back to the guide</a></p>`;
}

const SIGN_IN_FORM = `<p>Enter your MCP access token (<code>MCP_HTTP_TOKEN</code>) to connect this server to your Google Health account.</p>
<form method="post" action="/auth"><input type="password" name="key" autocomplete="current-password" required aria-label="MCP access token"><button type="submit">Continue to Google sign-in</button></form>
<p><a href="/">Back to the setup guide</a></p>`;

/**
 * Stateless Streamable HTTP handler shared by `serve --http` and the Vercel function.
 * MCP clients authenticate with `Authorization: Bearer <MCP_HTTP_TOKEN>` or `?key=<MCP_HTTP_TOKEN>`.
 * `/auth` and `/oauth2callback` let the owner sign in to Google from a browser, with no local setup.
 */
export function createMcpHttpHandler(rawToken = process.env.MCP_HTTP_TOKEN ?? "") {
  const token = rawToken.trim();
  const matches = (candidate: string | null | undefined) => !!candidate?.trim() && sameSecret(candidate.trim(), token);
  const client = new HealthClient();

  async function handleSignInStart(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const missing = missingSetup();
    if (missing.googleClient || missing.blobStore) return sendPage(res, 200, "Finish setup", setupPage(missing));
    if (req.method === "GET") return sendPage(res, 200, "Connect Google Health", SIGN_IN_FORM);
    if (req.method !== "POST") return void res.writeHead(405, { allow: "GET, POST" }).end();
    const form = await readForm(req);
    if (!matches(form.get("key"))) return sendPage(res, 401, "Connect Google Health", `<p>That access token is not right.</p>${SIGN_IN_FORM}`);
    const base = publicBaseUrl();
    if (!base) return sendPage(res, 500, "Not configured", "<p>Set <code>PUBLIC_BASE_URL</code> to this server's public https origin.</p>");
    const { url, state, verifier } = startSignIn(`${base}/oauth2callback`);
    const cookie = Buffer.from(JSON.stringify({ state, verifier })).toString("base64url");
    res.writeHead(303, { location: url, "set-cookie": signInCookie(cookie, SIGN_IN_TTL_SECONDS), "cache-control": "no-store" }).end();
  }

  async function handleSignInCallback(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const clear = { "set-cookie": signInCookie("", 0) };
    const restart = '<p><a href="/auth">Start sign-in again</a>.</p>';
    let saved: { state?: unknown; verifier?: unknown } = {};
    try {
      saved = JSON.parse(Buffer.from(readCookie(req, SIGN_IN_COOKIE) ?? "", "base64url").toString("utf8"));
    } catch {}
    const state = url.searchParams.get("state") ?? "";
    if (typeof saved.state !== "string" || typeof saved.verifier !== "string" || !state || !sameSecret(state, saved.state)) {
      return sendPage(res, 400, "Sign-in expired", `<p>This sign-in session expired or was started in another browser.</p>${restart}`, clear);
    }
    const error = url.searchParams.get("error");
    if (error) return sendPage(res, 400, "Sign-in cancelled", `<p>Google returned: ${escapeHtml(error.replace(/[^\w.-]/g, ""))}.</p>${restart}`, clear);
    const code = url.searchParams.get("code");
    if (!code) return sendPage(res, 400, "Sign-in failed", `<p>No authorization code was received.</p>${restart}`, clear);

    const base = publicBaseUrl();
    if (!base) return sendPage(res, 500, "Not configured", "<p>Set <code>PUBLIC_BASE_URL</code>.</p>", clear);
    const { scopes } = await completeSignIn(code, saved.verifier, `${base}/oauth2callback`);
    client.resetAuth();
    let linkStatus = "<p>Your Google Health account is linked. MCP clients connected to this server can now read your data.</p>";
    try {
      await client.identity();
    } catch (err) {
      linkStatus = `<p>Signed in, but Google Health said: ${escapeHtml(err instanceof Error ? err.message : String(err))}</p>`;
    }
    sendPage(
      res,
      200,
      "Connected",
      `${linkStatus}<p>Granted access: <code>${escapeHtml(scopes)}</code></p><p><a href="/">Next: add this server to Claude, ChatGPT or another AI app</a></p>`,
      clear,
    );
  }

  async function handleMcp(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const headerToken = req.headers.authorization?.replace(/^Bearer\s+/i, "");
    if (!matches(headerToken) && !matches(url.searchParams.get("key"))) {
      return void res.writeHead(401, { "content-type": "text/plain" }).end("Invalid or missing MCP access token.");
    }
    if (req.method !== "POST") return void res.writeHead(405, { allow: "POST" }).end();

    const server = createServer(client);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res);
  }

  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/healthz") return void res.writeHead(200, { "content-type": "text/plain" }).end("ok");
    const route =
      url.pathname === "/auth" ? handleSignInStart : url.pathname === "/oauth2callback" ? handleSignInCallback : MCP_PATHS.has(url.pathname) ? handleMcp : undefined;
    if (!route) return void res.writeHead(404).end();
    if (token.length < MIN_TOKEN_LENGTH) {
      if (route === handleSignInStart) {
        return sendPage(res, 500, "Finish setup", `<p>Set <code>MCP_HTTP_TOKEN</code> in Vercel (<b>Settings → Environment Variables</b>) to a random password of at least ${MIN_TOKEN_LENGTH} characters, then redeploy.</p>`);
      }
      return void res.writeHead(500, { "content-type": "text/plain" }).end(`Server misconfigured: MCP_HTTP_TOKEN must be at least ${MIN_TOKEN_LENGTH} characters.`);
    }
    try {
      await route(req, res, url);
    } catch (err) {
      console.error(`Request to ${url.pathname} failed:`, err instanceof Error ? err.message : err);
      if (!res.headersSent) sendPage(res, 500, "Something went wrong", `<p>${escapeHtml(err instanceof Error ? err.message : String(err))}</p>`);
    }
  };
}
