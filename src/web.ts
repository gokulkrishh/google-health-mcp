import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

const MAX_BODY_BYTES = 8192;

export function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

export function sameSecret(a: string, b: string): boolean {
  return timingSafeEqual(digest(a), digest(b));
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

export function sendPage(res: ServerResponse, status: number, title: string, bodyHtml: string, headers: Record<string, string | string[]> = {}): void {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-frame-options": "DENY", ...headers });
  res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${escapeHtml(title)}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;color:#222;background:#fff}input,button{font:inherit;padding:.5rem;width:100%;box-sizing:border-box;margin:.25rem 0}code{background:#f2f2f2;padding:.1em .3em;border-radius:4px;overflow-wrap:anywhere}code.pick{user-select:all;cursor:pointer}ol ol{margin:.4rem 0}li{margin:.35rem 0}.note{color:#666;font-size:.9em}@media (prefers-color-scheme:dark){body{color:#ddd;background:#111}code{background:#222}.note{color:#999}}</style>
</head><body><h1>${escapeHtml(title)}</h1>${bodyHtml}</body></html>`);
}

export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...headers });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<string> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new Error("Request body too large.");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function readForm(req: IncomingMessage): Promise<URLSearchParams> {
  return new URLSearchParams(await readBody(req));
}

export async function readJson(req: IncomingMessage): Promise<unknown> {
  const text = await readBody(req);
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return undefined;
  }
}
