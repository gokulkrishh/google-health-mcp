import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { HealthClient } from "./api.js";
import { createServer } from "./tools.js";

export const MIN_TOKEN_LENGTH = 32;
const MCP_PATHS = new Set(["/mcp", "/api/mcp"]);
const HEALTH_PATH = "/healthz";

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

/**
 * Stateless Streamable HTTP handler shared by `serve --http` and the Vercel function.
 * Clients authenticate with `Authorization: Bearer <MCP_HTTP_TOKEN>` or `?key=<MCP_HTTP_TOKEN>`.
 */
export function createMcpHttpHandler(rawToken = process.env.MCP_HTTP_TOKEN ?? "") {
  const token = rawToken.trim();
  const expected = digest(token);
  const matches = (candidate: string | null | undefined) => !!candidate?.trim() && timingSafeEqual(digest(candidate.trim()), expected);
  const client = new HealthClient();

  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === HEALTH_PATH) return void res.writeHead(200, { "content-type": "text/plain" }).end("ok");
    if (!MCP_PATHS.has(url.pathname)) return void res.writeHead(404).end();
    if (token.length < MIN_TOKEN_LENGTH) {
      return void res.writeHead(500, { "content-type": "text/plain" }).end(`Server misconfigured: MCP_HTTP_TOKEN must be at least ${MIN_TOKEN_LENGTH} characters.`);
    }

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
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (err) {
      console.error("MCP request failed:", err);
      if (!res.headersSent) res.writeHead(500).end();
    }
  };
}
