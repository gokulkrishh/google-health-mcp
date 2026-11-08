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

const PAGE_STYLE = `
:root{--bg:#000;--surface:#0a0a0a;--surface-2:#111113;--border:#1f1f1f;--border-strong:#2e2e2e;--fg:#ededed;--muted:#a1a1a1;--subtle:#6e6e6e;--red:#f87171;
--sans:"Geist",system-ui,-apple-system,"Segoe UI",sans-serif;--mono:"Geist Mono",ui-monospace,SFMono-Regular,Menlo,monospace}
*{box-sizing:border-box}html,body{margin:0;background:var(--bg);color:var(--fg)}
body{font:15px/1.6 var(--sans);-webkit-font-smoothing:antialiased;background:radial-gradient(60rem 30rem at 50% -10%,#16161a 0,var(--bg) 60%)}
.shell{min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:20px;padding:40px 16px}
.brand{display:flex;align-items:center;gap:10px;font-weight:600;letter-spacing:-.01em;color:var(--fg);text-decoration:none}
.card{width:100%;max-width:440px;background:var(--surface);border:1px solid var(--border-strong);border-radius:14px;padding:28px;box-shadow:0 30px 80px rgba(0,0,0,.6)}
h1{font-weight:500;font-size:22px;letter-spacing:-.02em;margin:0 0 12px}
p,li{color:var(--muted)}p{margin:0 0 14px}b,strong{color:var(--fg);font-weight:500}
a{color:var(--fg);text-decoration-color:var(--subtle);text-underline-offset:3px}
code{font-family:var(--mono);font-size:13px;background:var(--surface-2);border:1px solid var(--border);border-radius:5px;padding:1px 6px;color:var(--fg);overflow-wrap:anywhere}
code.pick{user-select:all;cursor:pointer;display:block;padding:8px 10px;margin-top:6px}
ol{padding-left:20px;margin:0 0 14px}ol ol{margin:8px 0}li{margin:6px 0}
label{display:block;font-size:13px;color:var(--muted);margin:16px 0 6px}
input{width:100%;height:44px;padding:0 14px;border-radius:10px;border:1px solid var(--border-strong);background:var(--bg);color:var(--fg);font:14px var(--mono);outline:none}
input:focus{border-color:var(--muted)}
button{width:100%;height:44px;margin-top:14px;border-radius:999px;border:1px solid var(--fg);background:var(--fg);color:#000;font:500 15px var(--sans);cursor:pointer}
button:hover{background:#fff}
.note{font-size:13px;color:var(--subtle);margin-top:14px}.error{color:var(--red)}
.foot{font-size:12px;color:var(--subtle);font-family:var(--mono)}
.chips{display:flex;flex-wrap:wrap;gap:8px;margin:4px 0 18px}.chip{border:1px solid var(--border-strong);background:var(--surface-2);border-radius:999px;padding:4px 10px;font-size:13px;color:var(--fg)}
a.button{display:flex;align-items:center;justify-content:center;height:44px;border-radius:999px;background:var(--fg);color:#000;font-weight:500;text-decoration:none;margin-top:6px}a.button:hover{background:#fff}
.status{width:40px;height:40px;border-radius:12px;display:grid;place-items:center;margin-bottom:16px;border:1px solid var(--border-strong);background:var(--surface-2)}`;

const BRAND_ICON = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="1" y="1" width="22" height="22" rx="6" stroke="#ededed" stroke-width="1.5"/><path d="M5 12.5h3.2l2-4.5 3.3 8 2-3.5H19" stroke="#ededed" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

export function sendPage(res: ServerResponse, status: number, title: string, bodyHtml: string, headers: Record<string, string | string[]> = {}): void {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-frame-options": "DENY", ...headers });
  res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><meta name="color-scheme" content="dark"><title>${escapeHtml(title)} · Google Health MCP</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600&family=Geist+Mono&display=swap" rel="stylesheet">
<style>${PAGE_STYLE}</style></head><body><main class="shell"><a class="brand" href="/">${BRAND_ICON}Google Health MCP</a><section class="card" role="dialog" aria-labelledby="t"><h1 id="t">${escapeHtml(title)}</h1>${bodyHtml}</section><p class="foot">Unofficial · read-only</p></main></body></html>`);
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
