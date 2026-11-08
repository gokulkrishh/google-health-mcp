# AGENTS.md

Read-only MCP server that exposes one person's Fitbit / Pixel Watch data from the **Google Health API v4** (`https://health.googleapis.com/v4/users/me/...`) to MCP clients such as Claude, ChatGPT and Grok. Single user, single Google account. TypeScript, Node 20+, `@modelcontextprotocol/sdk`, `zod`, `@vercel/blob`.

## Layout

| File | Owns |
|---|---|
| `src/dataTypes.ts` | The data type registry (`DATA_TYPES`): id, time kind, list/rollup support, scope. Builds list filters and rollup request bodies and enforces API limits. Everything else derives from it. |
| `src/tools.ts` | The 8 MCP tools. Tool enums come from the registry. |
| `src/tcx.ts` | Parses a workout's TCX export into a route summary and thinned GPS points. |
| `src/api.ts` | REST client. Retries once on 401 with a forced token refresh, maps Google errors to plain messages. |
| `src/auth.ts` | Google OAuth (PKCE), the refresh token store, and the terminal sign-in (`auth` command). |
| `src/http.ts` | Stateless Streamable HTTP handler: `/mcp`, `/healthz`, and browser sign-in at `/auth` and `/oauth2callback`. Shared by the CLI and Vercel. |
| `src/index.ts` | CLI: `auth`, `whoami`, `serve` (stdio), `serve --http`. |
| `skills/google-health-insights/` | Skill that teaches AI clients to use the tools and interpret the data. `.claude/skills/` links to it. Keep field names in sync with the API. |
| `api/mcp.js`, `vercel.json`, `public/` | Vercel function entry (imports `dist/`), rewrites, static landing page. |

## Rules that keep it safe

- Only request `googlehealth.*.readonly` scopes. Never add write tools.
- Never log, return or render a refresh token, access token or `MCP_HTTP_TOKEN`. Escape anything echoed into HTML.
- `/mcp` requires `MCP_HTTP_TOKEN` as a Bearer header or `?key=`, compared with `timingSafeEqual` on SHA-256 digests. `/auth` takes it from a POST form, never the URL.
- Browser sign-in keeps the PKCE verifier and state in the `__Host-gh_signin` cookie (HttpOnly, Secure, SameSite=Lax, 10 min). The redirect URI comes from `PUBLIC_BASE_URL` or `VERCEL_PROJECT_PRODUCTION_URL`, never the Host header.
- Refresh token precedence: private Vercel Blob (`google-health-mcp/sign-in.json`), then `GOOGLE_REFRESH_TOKEN`, then `~/.config/google-health-mcp/token.json`. It is re-read on every refresh, so a new sign-in applies without a redeploy.
- Write to stderr only in stdio mode; stdout is the MCP channel.

## API facts that are easy to get wrong

- The ground truth is the discovery document: `https://health.googleapis.com/$discovery/rest?version=v4`. Check field names and limits there, not from memory.
- Filter fields use the snake_case data type id (`daily_heart_rate_variability.date`). Sleep filters on `civil_end_time`. ECG only supports `start_time >=`.
- Rollup range is at most 14 days for `heart-rate`, `active-minutes`, `total-calories` and `calories-in-heart-rate-zone`, and 90 days otherwise. Sleep and exercise list pages max out at 25.
- There is no `nutrition.readonly` scope, so food and water data are not readable.
- GPS routes come from `exportExerciseTcx` with `?alt=media` (raw TCX) and need both `activity_and_fitness` and `location` scopes.

## Working on it

- `npm test` runs `tsc` and the unit tests in `src/*.test.ts`. Run it before every commit.
- To check HTTP behaviour, run `MCP_HTTP_TOKEN=$(openssl rand -hex 32) node dist/index.js serve --http` and POST JSON-RPC (`tools/list`) to `http://127.0.0.1:8787/mcp` with the Bearer header.
- Pushing to `main` deploys production on Vercel through the GitHub integration. Treat every push as a production deploy.
- Secrets live in Vercel environment variables and the Blob store. Never commit `.env*`, `credentials.json` or `token.json`.
