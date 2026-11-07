import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";

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
const DEFAULT_SCOPES: ScopeName[] = ["activity", "metrics", "sleep", "profile", "settings"];

export const HOME = process.env.GOOGLE_HEALTH_MCP_HOME ?? join(homedir(), ".config", "google-health-mcp");
const CREDENTIALS_PATH = process.env.GOOGLE_HEALTH_CREDENTIALS ?? join(HOME, "credentials.json");
const TOKEN_PATH = join(HOME, "token.json");
const PORT = Number(process.env.GOOGLE_HEALTH_OAUTH_PORT ?? 8765);
export const REDIRECT_URI = `http://127.0.0.1:${PORT}/oauth2callback`;

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

function loadClient(): Client {
  const envId = process.env.GOOGLE_CLIENT_ID;
  const envSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (envId && envSecret) return { clientId: envId, clientSecret: envSecret };

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

function readToken(): StoredToken | undefined {
  if (!existsSync(TOKEN_PATH)) return undefined;
  try {
    return JSON.parse(readFileSync(TOKEN_PATH, "utf8")) as StoredToken;
  } catch {
    throw new AuthError(`${TOKEN_PATH} is unreadable. Run \`google-health-mcp auth\` again.`);
  }
}

function writeToken(token: StoredToken): void {
  mkdirSync(HOME, { recursive: true, mode: 0o700 });
  const tmp = `${TOKEN_PATH}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(token, null, 2), { mode: 0o600 });
  renameSync(tmp, TOKEN_PATH);
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
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    if (body.error === "invalid_grant") {
      throw new AuthError(
        "Google rejected the saved refresh token (it expired or was revoked). Apps in Testing mode get tokens that expire after 7 days. " +
          "Run `google-health-mcp auth` again.",
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

  private async refresh(forceRefresh: boolean): Promise<string> {
    const envRefreshToken = process.env.GOOGLE_REFRESH_TOKEN;
    const stored = envRefreshToken ? { refresh_token: envRefreshToken } : readToken();
    if (!stored?.refresh_token) {
      throw new AuthError("Not signed in to Google Health yet. Run `google-health-mcp auth` on your computer, or on a hosted deploy set GOOGLE_REFRESH_TOKEN, GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.");
    }
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
    if (!envRefreshToken) writeToken({ ...stored, access_token: token, expiry_date: expiresAt });
    this.cached = { token, expiresAt };
    return token;
  }
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

/** Interactive OAuth flow: opens the browser, receives the code on the loopback redirect, and saves the refresh token. */
export async function runAuthFlow(): Promise<void> {
  const client = loadClient();
  const scopes = requestedScopes();
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const state = randomBytes(16).toString("base64url");

  const url = new URL(AUTH_URL);
  url.search = new URLSearchParams({
    client_id: client.clientId,
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    scope: scopes.join(" "),
    access_type: "offline",
    prompt: "consent",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  }).toString();

  console.error(`Redirect URI (must be listed on your OAuth client): ${REDIRECT_URI}`);
  console.error(`\nOpening your browser. If it does not open, visit:\n${url}\n`);
  const codePromise = waitForCode(state);
  openBrowser(url.toString());
  const code = await codePromise;

  const body = await postToken({
    grant_type: "authorization_code",
    code,
    code_verifier: verifier,
    redirect_uri: REDIRECT_URI,
    client_id: client.clientId,
    client_secret: client.clientSecret,
  });
  if (!body.refresh_token) {
    throw new AuthError("Google did not return a refresh token. Remove the app at https://myaccount.google.com/connections and run auth again.");
  }
  writeToken({
    refresh_token: String(body.refresh_token),
    access_token: accessTokenFrom(body),
    expiry_date: Date.now() + Number(body.expires_in ?? 3600) * 1000,
    scope: String(body.scope ?? ""),
  });
  console.error(`Saved token to ${TOKEN_PATH}`);
  console.error(`Granted scopes: ${String(body.scope ?? "").replaceAll(SCOPE_PREFIX, "")}`);
}
