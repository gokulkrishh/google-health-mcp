#!/usr/bin/env node
import { createServer as createHttpServer } from "node:http";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { HealthClient } from "./api.js";
import { runAuthFlow } from "./auth.js";
import { MIN_TOKEN_LENGTH, createMcpHttpHandler } from "./http.js";
import { createServer } from "./tools.js";

const USAGE = `google-health-mcp <command>

  auth            Sign in with Google and save a refresh token
  whoami          Check the saved sign-in by calling users/me/identity
  serve           Run the MCP server over stdio (Claude Desktop, Claude Code)
  serve --http    Run over Streamable HTTP at /mcp (claude.ai, ChatGPT, Grok). Needs MCP_HTTP_TOKEN.
`;

async function serveHttp(): Promise<void> {
  if ((process.env.MCP_HTTP_TOKEN ?? "").length < MIN_TOKEN_LENGTH) {
    console.error(`Refusing to start: set MCP_HTTP_TOKEN to a random secret of at least ${MIN_TOKEN_LENGTH} characters (e.g. \`openssl rand -hex 32\`).`);
    process.exit(1);
  }
  const host = process.env.MCP_HTTP_HOST ?? "127.0.0.1";
  if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") {
    console.error(`Listening on ${host}. Only expose this behind HTTPS (your host's TLS or a tunnel).`);
  }
  const port = Number(process.env.MCP_HTTP_PORT ?? process.env.PORT ?? 8787);
  const http = createHttpServer(createMcpHttpHandler());

  http.on("error", (err: NodeJS.ErrnoException) => {
    console.error(err.code === "EADDRINUSE" ? `Port ${port} is already in use. Set MCP_HTTP_PORT to another port.` : err.message);
    process.exit(1);
  });
  http.listen(port, host, () => {
    console.error(`google-health-mcp listening on http://${host}:${port}/mcp`);
    if (host === "127.0.0.1") console.error("Only reachable from this machine. Put a tunnel in front of it for remote clients (see README).");
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
