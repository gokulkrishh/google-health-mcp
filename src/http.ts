import type { IncomingMessage, ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { HealthClient } from "./api.js";
import { completeSignIn, missingSetup, publicBaseUrl, requestedScopeIds, startSignIn } from "./auth.js";
import { OAuthSigner, createOAuthRoutes } from "./oauth.js";
import { createServer } from "./tools.js";
import { escapeHtml, readForm, sameSecret, sendPage } from "./web.js";

export const MIN_TOKEN_LENGTH = 32;
const MCP_PATHS = new Set(["/mcp", "/api/mcp"]);
const SIGN_IN_COOKIE = "__Host-gh_signin";
const SIGN_IN_TTL_SECONDS = 600;

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

const SCOPE_LABELS: Record<string, string> = {
  "activity_and_fitness.readonly": "Activity & fitness",
  "health_metrics_and_measurements.readonly": "Heart, SpO2 & body",
  "sleep.readonly": "Sleep",
  "profile.readonly": "Profile",
  "settings.readonly": "Settings",
  "location.readonly": "GPS routes",
  "ecg.readonly": "ECG",
  "irn.readonly": "Irregular rhythm alerts",
};

const SIGN_IN_FORM = `<p>Connect this server to the Google account your Fitbit syncs with. You only need to do this once.</p>
<form method="post" action="/auth"><label for="key">Access token (<code>MCP_HTTP_TOKEN</code>)</label><input id="key" type="password" name="key" autocomplete="current-password" required autofocus><button type="submit">Continue with Google</button></form>
<p class="note">Your token stays on this server. <a href="/">Back to the guide</a></p>`;

/**
 * Stateless Streamable HTTP handler shared by `serve --http` and the Vercel function.
 * MCP clients authenticate with OAuth (see oauth.ts), `Authorization: Bearer <MCP_HTTP_TOKEN>` or `?key=<MCP_HTTP_TOKEN>`.
 * `/auth` and `/oauth2callback` let the owner sign in to Google from a browser, with no local setup.
 */
export function createMcpHttpHandler(rawToken = process.env.MCP_HTTP_TOKEN ?? "") {
  const token = rawToken.trim();
  const matches = (candidate: string | null | undefined) => !!candidate?.trim() && sameSecret(candidate.trim(), token);
  const client = new HealthClient();
  const base = publicBaseUrl();
  const oauth = base && token.length >= MIN_TOKEN_LENGTH ? createOAuthRoutes(base, token, new OAuthSigner(token)) : undefined;

  async function handleSignInStart(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const missing = missingSetup();
    if (missing.googleClient || missing.blobStore) return sendPage(res, 200, "Finish setup", setupPage(missing));
    if (req.method === "GET") return sendPage(res, 200, "Connect Google Health", SIGN_IN_FORM);
    if (req.method !== "POST") return void res.writeHead(405, { allow: "GET, POST" }).end();
    const form = await readForm(req);
    if (!matches(form.get("key"))) return sendPage(res, 401, "Connect Google Health", `<p class="error">That access token is not right.</p>${SIGN_IN_FORM}`);
    if (!base) return sendPage(res, 500, "Not configured", "<p>Set <code>PUBLIC_BASE_URL</code> to this server's public https origin.</p>");
    const { url, state, verifier } = startSignIn(`${base}/oauth2callback`);
    const cookie = Buffer.from(JSON.stringify({ state, verifier })).toString("base64url");
    res.writeHead(303, { location: url, "set-cookie": signInCookie(cookie, SIGN_IN_TTL_SECONDS), "cache-control": "no-store" }).end();
  }

  async function handleSignInCallback(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const clear = { "set-cookie": signInCookie("", 0) };
    const restart = '<a class="button" href="/#sign-in">Start sign-in again</a>';
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

    if (!base) return sendPage(res, 500, "Not configured", "<p>Set <code>PUBLIC_BASE_URL</code>.</p>", clear);
    const { scopes } = await completeSignIn(code, saved.verifier, `${base}/oauth2callback`);
    client.resetAuth();
    let problem = "";
    try {
      await client.identity();
    } catch (err) {
      problem = err instanceof Error ? err.message : String(err);
    }
    const chips = scopes
      .split(/\s+/)
      .filter(Boolean)
      .map((s) => `<span class="chip">${escapeHtml(SCOPE_LABELS[s] ?? s)}</span>`)
      .join("");
    const icon = problem
      ? '<div class="status"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#f5a524" stroke-width="2.2" aria-hidden="true"><path d="M12 8v5M12 16.5v.5"/></svg></div>'
      : '<div class="status"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#22c55e" stroke-width="2.4" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg></div>';
    const message = problem
      ? `<p>Signed in, but Google Health said: ${escapeHtml(problem)}</p>`
      : "<p>Your Google Health account is linked. AI apps you connect to this server can now read this data:</p>";
    sendPage(res, 200, problem ? "Almost there" : "Connected", `${icon}${message}<div class="chips">${chips}</div><a class="button" href="/#connect-app">Connect an AI app</a>`, clear);
  }

  async function handleMcp(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const headerToken = req.headers.authorization?.replace(/^Bearer\s+/i, "").trim();
    const authorized = matches(headerToken) || matches(url.searchParams.get("key")) || Boolean(oauth?.isAccessToken(headerToken));
    if (!authorized) {
      const challenge = oauth ? { "www-authenticate": oauth.unauthorizedHeader } : {};
      return void res.writeHead(401, { "content-type": "text/plain", ...challenge }).end("Invalid or missing MCP access token.");
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
      url.pathname === "/auth"
        ? handleSignInStart
        : url.pathname === "/oauth2callback"
          ? handleSignInCallback
          : MCP_PATHS.has(url.pathname)
            ? handleMcp
            : oauth?.routes[url.pathname];
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
