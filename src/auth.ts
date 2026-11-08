import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { get as blobGet, put as blobPut } from "@vercel/blob";

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPE_PREFIX = "https://www.googleapis.com/auth/googlehealth.";

const SCOPES = {
  activity: "activity_and_fitness.readonly",
  metrics: "health_metrics_and_measurements.readonly",
  sleep: "sleep.readonly",
  profile: "profile.readonly",
  settings: "settings.readonly",
  ecg: "ecg.readonly",
  irn: "irn.readonly",
  location: "location.readonly",
} as const;

type ScopeName = keyof typeof SCOPES;
const DEFAULT_SCOPES: ScopeName[] = ["activity", "metrics", "sleep", "profile", "settings", "location", "ecg"];

export const HOME = process.env.GOOGLE_HEALTH_MCP_HOME ?? join(homedir(), ".config", "google-health-mcp");
const CREDENTIALS_PATH = process.env.GOOGLE_HEALTH_CREDENTIALS ?? join(HOME, "credentials.json");
const TOKEN_PATH = join(HOME, "token.json");
const PORT = Number(process.env.GOOGLE_HEALTH_OAUTH_PORT ?? 8765);
export const REDIRECT_URI = `http://127.0.0.1:${PORT}/oauth2callback`;

const BLOB_PATH = "google-health-mcp/sign-in.json";
const USE_BLOB = Boolean(process.env.BLOB_STORE_ID || process.env.BLOB_READ_WRITE_TOKEN);

export class AuthError extends Error {}

interface Client {
  clientId: string;
  clientSecret: string;
}

interface StoredToken {
  refresh_token: string;
  access_token?: string;
  expiry_date?: number;
  scope?: string;
}

/** The fixed public origin of a hosted deploy, used for the web sign-in redirect URI. */
export function publicBaseUrl(): string | undefined {
  const explicit = process.env.PUBLIC_BASE_URL;
  if (explicit) return explicit.replace(/\/+$/, "");
  const vercel = process.env.VERCEL_PROJECT_PRODUCTION_URL;
  return vercel ? `https://${vercel}` : undefined;
}

/** What a deploy still needs before browser sign-in can work. */
export function missingSetup(): { googleClient: boolean; blobStore: boolean } {
  const hasEnvClient = Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
  const hosted = Boolean(process.env.VERCEL);
  return {
    googleClient: !hasEnvClient && (hosted || !existsSync(CREDENTIALS_PATH)),
    blobStore: hosted && !USE_BLOB,
  };
}

/** Full scope URLs requested at sign-in, for display on the setup page. */
export function requestedScopeIds(): string[] {
  return requestedScopes();
}

export function signInHint(): string {
  const base = publicBaseUrl();
  return base ? `Open ${base}/auth in your browser to sign in.` : "Run `google-health-mcp auth` on your computer.";
}

function loadClient(): Client {
  const envId = process.env.GOOGLE_CLIENT_ID;
  const envSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (envId && envSecret) return { clientId: envId, clientSecret: envSecret };

  if (process.env.VERCEL) {
    throw new AuthError("Google OAuth client is not configured. Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in Vercel (Settings → Environment Variables), then redeploy.");
  }
  if (!existsSync(CREDENTIALS_PATH)) {
    throw new AuthError(
      "No OAuth client found. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET (required on hosted deploys such as Vercel), " +
        `or on your computer save the client JSON from Google Cloud Console to ${CREDENTIALS_PATH}.`,
    );
  }
  const raw = JSON.parse(readFileSync(CREDENTIALS_PATH, "utf8"));
  const section = raw.web ?? raw.installed;
  if (!section?.client_id || !section?.client_secret) {
    throw new AuthError(`${CREDENTIALS_PATH} has no "web" or "installed" client_id/client_secret.`);
  }
  return { clientId: section.client_id, clientSecret: section.client_secret };
}

function requestedScopes(): string[] {
  const names = process.env.GOOGLE_HEALTH_SCOPES?.split(",").map((s) => s.trim()).filter(Boolean) ?? DEFAULT_SCOPES;
  return names.map((name) => {
    if (!(name in SCOPES)) throw new AuthError(`Unknown scope "${name}". Use any of: ${Object.keys(SCOPES).join(", ")}.`);
    return SCOPE_PREFIX + SCOPES[name as ScopeName];
  });
}

function readTokenFile(): StoredToken | undefined {
  if (!existsSync(TOKEN_PATH)) return undefined;
  try {
    return JSON.parse(readFileSync(TOKEN_PATH, "utf8")) as StoredToken;
  } catch {
    throw new AuthError(`${TOKEN_PATH} is unreadable. Run \`google-health-mcp auth\` again.`);
  }
}

function writeTokenFile(token: StoredToken): void {
  mkdirSync(HOME, { recursive: true, mode: 0o700 });
  const tmp = `${TOKEN_PATH}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(token, null, 2), { mode: 0o600 });
  renameSync(tmp, TOKEN_PATH);
}

async function readTokenBlob(): Promise<StoredToken | undefined> {
  let result;
  try {
    result = await blobGet(BLOB_PATH, { access: "private", useCache: false });
  } catch (err) {
    throw new AuthError(`Could not read the saved Google sign-in from Vercel Blob: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (result?.statusCode !== 200 || !result.stream) return undefined;
  return JSON.parse(await new Response(result.stream).text()) as StoredToken;
}

type TokenSource = "blob" | "env" | "file";

/** Precedence: a web sign-in saved in Blob, then GOOGLE_REFRESH_TOKEN, then the local token file. */
async function loadStoredToken(): Promise<{ token: StoredToken; source: TokenSource } | undefined> {
  if (USE_BLOB) {
    const token = await readTokenBlob();
    if (token?.refresh_token) return { token, source: "blob" };
  }
  const envRefreshToken = process.env.GOOGLE_REFRESH_TOKEN;
  if (envRefreshToken) return { token: { refresh_token: envRefreshToken }, source: "env" };
  const file = readTokenFile();
  return file?.refresh_token ? { token: file, source: "file" } : undefined;
}

async function saveRefreshToken(token: StoredToken): Promise<string> {
  if (USE_BLOB) {
    await blobPut(BLOB_PATH, JSON.stringify({ refresh_token: token.refresh_token, scope: token.scope }), {
      access: "private",
      allowOverwrite: true,
      contentType: "application/json",
    });
    return "Vercel Blob";
  }
  writeTokenFile(token);
  return TOKEN_PATH;
}

function accessTokenFrom(body: Record<string, unknown>): string {
  if (typeof body.access_token !== "string") throw new AuthError("Google's token response had no access_token.");
  return body.access_token;
}

async function postToken(params: Record<string, string>): Promise<Record<string, unknown>> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
    signal: AbortSignal.timeout(30_000),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    if (body.error === "invalid_grant") {
      throw new AuthError(
        "Google rejected the saved sign-in (it expired or was revoked). Apps in Testing mode get sign-ins that expire after 7 days. " + signInHint(),
      );
    }
    throw new AuthError(`Token request failed: ${body.error ?? res.status} ${body.error_description ?? ""}`.trim());
  }
  return body;
}

/** Holds the access token in memory and refreshes it from the stored refresh token on demand. */
export class TokenManager {
  private cached?: { token: string; expiresAt: number };
  private inFlight?: Promise<string>;

  async getAccessToken(forceRefresh = false): Promise<string> {
    if (!forceRefresh && this.cached && this.cached.expiresAt - Date.now() > 60_000) return this.cached.token;
    if (forceRefresh) return this.refresh(true);
    this.inFlight ??= this.refresh(false).finally(() => (this.inFlight = undefined));
    return this.inFlight;
  }

  /** Drops the cached access token so the next call picks up a new sign-in. */
  reset(): void {
    this.cached = undefined;
  }

  private async refresh(forceRefresh: boolean): Promise<string> {
    const loaded = await loadStoredToken();
    if (!loaded) throw new AuthError(`Not signed in to Google Health yet. ${signInHint()}`);
    const { token: stored, source } = loaded;
    if (!forceRefresh && stored.access_token && stored.expiry_date && stored.expiry_date - Date.now() > 60_000) {
      this.cached = { token: stored.access_token, expiresAt: stored.expiry_date };
      return stored.access_token;
    }

    const client = loadClient();
    const body = await postToken({
      grant_type: "refresh_token",
      refresh_token: stored.refresh_token,
      client_id: client.clientId,
      client_secret: client.clientSecret,
    });
    const token = accessTokenFrom(body);
    const expiresAt = Date.now() + Number(body.expires_in ?? 3600) * 1000;
    if (source === "file") writeTokenFile({ ...stored, access_token: token, expiry_date: expiresAt });
    this.cached = { token, expiresAt };
    return token;
  }
}

export interface SignInStart {
  url: string;
  state: string;
  verifier: string;
}

/** Builds a Google authorization URL with PKCE (S256) and a random state for the given redirect URI. */
export function startSignIn(redirectUri: string): SignInStart {
  const client = loadClient();
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const state = randomBytes(16).toString("base64url");
  const url = new URL(AUTH_URL);
  url.search = new URLSearchParams({
    client_id: client.clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: requestedScopes().join(" "),
    access_type: "offline",
    prompt: "consent",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  }).toString();
  return { url: url.toString(), state, verifier };
}

/** Exchanges the authorization code and saves the refresh token. Returns where it was saved and the granted scopes. */
export async function completeSignIn(code: string, verifier: string, redirectUri: string): Promise<{ savedTo: string; scopes: string }> {
  const client = loadClient();
  const body = await postToken({
    grant_type: "authorization_code",
    code,
    code_verifier: verifier,
    redirect_uri: redirectUri,
    client_id: client.clientId,
    client_secret: client.clientSecret,
  });
  if (typeof body.refresh_token !== "string") {
    throw new AuthError("Google did not return a refresh token. Remove the app at https://myaccount.google.com/connections and sign in again.");
  }
  const scope = String(body.scope ?? "");
  const savedTo = await saveRefreshToken({
    refresh_token: body.refresh_token,
    access_token: accessTokenFrom(body),
    expiry_date: Date.now() + Number(body.expires_in ?? 3600) * 1000,
    scope,
  });
  return { savedTo, scopes: scope.replaceAll(SCOPE_PREFIX, "") };
}

function openBrowser(url: string): void {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  spawn(cmd, args, { stdio: "ignore", detached: true }).on("error", () => {}).unref();
}

function waitForCode(expectedState: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", REDIRECT_URI);
      if (url.pathname !== "/oauth2callback") {
        res.writeHead(404).end();
        return;
      }
      const page = (status: number, message: string) => {
        res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
        res.end(`<!doctype html><meta charset="utf-8"><title>Google Health MCP</title><body style="font:16px system-ui;padding:40px"><p>${message}</p></body>`);
      };
      const finish = (status: number, message: string, result: () => void) => {
        page(status, message);
        server.close();
        result();
      };
      if (url.searchParams.get("state") !== expectedState) return page(400, "This sign-in link is stale. Use the link from the latest auth run.");
      const error = url.searchParams.get("error");
      const code = url.searchParams.get("code");
      if (error) {
        const safe = error.replace(/[^\w.-]/g, "");
        return finish(400, `Sign-in failed: ${safe}. You can close this tab.`, () => reject(new AuthError(`Google returned: ${safe}`)));
      }
      if (!code) return finish(400, "No authorization code received.", () => reject(new AuthError("No authorization code.")));
      finish(200, "Google sign-in received. Close this tab and check the terminal for the result.", () => resolve(code));
    });
    server.on("error", (err: NodeJS.ErrnoException) =>
      reject(new AuthError(err.code === "EADDRINUSE" ? `Port ${PORT} is busy. Set GOOGLE_HEALTH_OAUTH_PORT to another port (and add the new redirect URI).` : err.message)),
    );
    server.listen(PORT, "127.0.0.1");
    setTimeout(() => {
      server.close();
      reject(new AuthError("Timed out after 5 minutes waiting for Google sign-in."));
    }, 300_000).unref();
  });
}

/** Terminal sign-in: opens the browser, receives the code on the loopback redirect, and saves the refresh token. */
export async function runAuthFlow(): Promise<void> {
  const { url, state, verifier } = startSignIn(REDIRECT_URI);
  console.error(`Redirect URI (must be listed on your OAuth client): ${REDIRECT_URI}`);
  console.error(`\nOpening your browser. If it does not open, visit:\n${url}\n`);
  const codePromise = waitForCode(state);
  openBrowser(url);
  const { savedTo, scopes } = await completeSignIn(await codePromise, verifier, REDIRECT_URI);
  console.error(`Saved sign-in to ${savedTo}`);
  console.error(`Granted scopes: ${scopes}`);
}
