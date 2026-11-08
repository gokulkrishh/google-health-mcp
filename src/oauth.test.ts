import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { OAuthSigner, isAllowedRedirectUri, redirectMatches } from "./oauth.js";

const OWNER_TOKEN = randomBytes(32).toString("hex");
const REDIRECT = "http://localhost:9999/callback";
let server: Server;
let base = "";

before(async () => {
  server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.PUBLIC_BASE_URL = base;
  const { createMcpHttpHandler } = await import("./http.js");
  server.on("request", createMcpHttpHandler(OWNER_TOKEN));
});

after(() => server.close());

const form = (fields: Record<string, string>) => ({
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams(fields).toString(),
  redirect: "manual" as const,
});

const listTools = (authorization?: string) =>
  fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(authorization ? { authorization } : {}) },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });

async function register(redirectUris: string[], clientName = "Test App") {
  return fetch(`${base}/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ redirect_uris: redirectUris, client_name: clientName }) });
}

test("an MCP client can register, get the owner's approval, and call tools with OAuth", async () => {
  const metadata = (await (await fetch(`${base}/.well-known/oauth-protected-resource`)).json()) as { resource: string; authorization_servers: string[] };
  assert.equal(metadata.resource, `${base}/mcp`);
  assert.deepEqual(metadata.authorization_servers, [base]);

  const unauthenticated = await listTools();
  assert.equal(unauthenticated.status, 401);
  assert.match(unauthenticated.headers.get("www-authenticate") ?? "", /resource_metadata="[^"]+\/\.well-known\/oauth-protected-resource"/);

  const registered = await register([REDIRECT]);
  assert.equal(registered.status, 201);
  const { client_id: clientId } = (await registered.json()) as { client_id: string };

  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const authorizeFields = { response_type: "code", client_id: clientId, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: "S256", state: "xyz" };

  const consent = await fetch(`${base}/authorize?${new URLSearchParams(authorizeFields)}`);
  const consentHtml = await consent.text();
  assert.equal(consent.status, 200);
  assert.match(consentHtml, /returns to <b>localhost:9999<\/b>/);
  assert.match(consentHtml, /Test App/);
  assert.match(consentHtml, /type="password"/);

  const wrongKey = await fetch(`${base}/authorize`, form({ ...authorizeFields, key: "not-the-token" }));
  assert.equal(wrongKey.status, 401);

  const approved = await fetch(`${base}/authorize`, form({ ...authorizeFields, key: OWNER_TOKEN }));
  assert.equal(approved.status, 302);
  const back = new URL(approved.headers.get("location") ?? "");
  assert.equal(`${back.origin}${back.pathname}`, REDIRECT);
  assert.equal(back.searchParams.get("state"), "xyz");
  assert.equal(back.searchParams.get("iss"), base);
  const code = back.searchParams.get("code") ?? "";

  const badVerifier = await fetch(`${base}/token`, form({ grant_type: "authorization_code", client_id: clientId, code, redirect_uri: REDIRECT, code_verifier: randomBytes(32).toString("base64url") }));
  assert.equal(badVerifier.status, 400);

  const exchanged = await fetch(`${base}/token`, form({ grant_type: "authorization_code", client_id: clientId, code, redirect_uri: REDIRECT, code_verifier: verifier }));
  assert.equal(exchanged.status, 200);
  const tokens = (await exchanged.json()) as { access_token: string; refresh_token: string; token_type: string };
  assert.equal(tokens.token_type, "Bearer");

  assert.equal((await listTools(`Bearer ${tokens.access_token}`)).status, 200);
  assert.equal((await listTools(`Bearer ${tokens.access_token.slice(0, -2)}xx`)).status, 401);
  assert.equal((await listTools(`Bearer ${tokens.refresh_token}`)).status, 401, "a refresh token is not an access token");

  const refreshed = await fetch(`${base}/token`, form({ grant_type: "refresh_token", client_id: clientId, refresh_token: tokens.refresh_token }));
  assert.equal(refreshed.status, 200);
  const { access_token: renewed } = (await refreshed.json()) as { access_token: string };
  assert.equal((await listTools(`Bearer ${renewed}`)).status, 200);
});

test("authorization refuses unsafe or unregistered return addresses", async () => {
  assert.equal((await register(["http://evil.example/callback"])).status, 400);
  assert.equal((await register(["javascript:alert(1)"])).status, 400);

  const { client_id: clientId } = (await (await register([REDIRECT])).json()) as { client_id: string };
  const otherRedirect = await fetch(
    `${base}/authorize?${new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: "https://attacker.example/cb", code_challenge: "x".repeat(43), code_challenge_method: "S256" })}`,
    { redirect: "manual" },
  );
  assert.equal(otherRedirect.status, 400);
  assert.equal(otherRedirect.headers.get("location"), null);

  const forged = await fetch(`${base}/authorize?${new URLSearchParams({ response_type: "code", client_id: "forged.client", redirect_uri: REDIRECT, code_challenge: "x".repeat(43), code_challenge_method: "S256" })}`);
  assert.equal(forged.status, 400);
});

test("the access token still works directly as a Bearer header", async () => {
  assert.equal((await listTools(`Bearer ${OWNER_TOKEN}`)).status, 200);
});

test("changing MCP_HTTP_TOKEN invalidates every OAuth token", () => {
  const before = new OAuthSigner("a".repeat(64));
  const afterRotation = new OAuthSigner("b".repeat(64));
  const access = before.sign({ k: "access", c: "client", exp: Math.floor(Date.now() / 1000) + 60, j: "n" });
  assert.ok(before.verify(access, "access"));
  assert.equal(afterRotation.verify(access, "access"), undefined);
  assert.equal(before.verify(access, "refresh"), undefined);
});

test("loopback return addresses match on any port, others only exactly", () => {
  assert.ok(redirectMatches(["http://127.0.0.1:1234/callback"], "http://127.0.0.1:5678/callback"));
  assert.equal(redirectMatches(["http://127.0.0.1:1234/callback"], "http://127.0.0.1:5678/other"), false);
  assert.equal(redirectMatches(["https://claude.ai/api/mcp/auth_callback"], "https://claude.ai/api/mcp/auth_callback2"), false);
});

test("redirect URIs must be https or http on loopback", () => {
  assert.ok(isAllowedRedirectUri("https://claude.ai/api/mcp/auth_callback"));
  assert.ok(isAllowedRedirectUri("http://127.0.0.1:33418/callback"));
  assert.equal(isAllowedRedirectUri("http://example.com/cb"), false);
  assert.equal(isAllowedRedirectUri("https://user:pass@example.com/cb"), false);
});
