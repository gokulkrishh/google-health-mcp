#!/usr/bin/env node
import { createHash, timingSafeEqual } from "node:crypto";
import { createServer as createHttpServer } from "node:http";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { HealthClient } from "./api.js";
import { runAuthFlow } from "./auth.js";
import { createServer } from "./tools.js";

const USAGE = `google-health-mcp <command>

  auth            Sign in with Google and save a refresh token
  whoami          Check the saved sign-in by calling users/me/identity
  serve           Run the MCP server over stdio (Claude Desktop, Claude Code)
  serve --http    Run over Streamable HTTP at /mcp (Grok remote MCP). Needs MCP_HTTP_TOKEN.
`;

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

async function serveHttp(): Promise<void> {
  const token = process.env.MCP_HTTP_TOKEN ?? "";
  if (token.length < 32) {
    console.error("Refusing to start: set MCP_HTTP_TOKEN to a random secret of at least 32 characters (e.g. `openssl rand -hex 32`).");
    process.exit(1);
  }
  const expected = digest(token);
  const host = process.env.MCP_HTTP_HOST ?? "127.0.0.1";
  if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") {
    console.error(`Listening on ${host}. Only expose this behind HTTPS (your host's TLS or a tunnel).`);
  }
  const port = Number(process.env.MCP_HTTP_PORT ?? process.env.PORT ?? 8787);
  const client = new HealthClient();

  const http = createHttpServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/healthz") return void res.writeHead(200, { "content-type": "text/plain" }).end("ok");
    if (url.pathname !== "/mcp") return void res.writeHead(404).end();
    const presented = url.searchParams.get("key") ?? (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
    if (!timingSafeEqual(digest(presented), expected)) {
      return void res.writeHead(401, { "www-authenticate": "Bearer" }).end();
    }
    if (req.method !== "POST") return void res.writeHead(405, { allow: "POST" }).end();

    const server = createServer(client);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (err) {
      console.error("MCP request failed:", err);
      if (!res.headersSent) res.writeHead(500).end();
    }
  });

  http.on("error", (err: NodeJS.ErrnoException) => {
    console.error(err.code === "EADDRINUSE" ? `Port ${port} is already in use. Set MCP_HTTP_PORT to another port.` : err.message);
    process.exit(1);
  });
  http.listen(port, host, () => {
    console.error(`google-health-mcp listening on http://${host}:${port}/mcp`);
    if (host === "127.0.0.1") console.error("Only reachable from this machine. Put a tunnel in front of it for Grok (see README).");
  });
}

async function main(): Promise<void> {
  const [command = "serve", ...flags] = process.argv.slice(2);
  switch (command) {
    case "auth":
      await runAuthFlow();
      console.error("\nChecking the account link…");
      console.error(JSON.stringify(await new HealthClient().identity(), null, 2));
      return;
    case "whoami":
      console.log(JSON.stringify(await new HealthClient().identity(), null, 2));
      return;
    case "serve":
      if (flags.includes("--http")) return serveHttp();
      await createServer().connect(new StdioServerTransport());
      return;
    default:
      console.error(USAGE);
      process.exit(command === "help" || command === "--help" ? 0 : 1);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
