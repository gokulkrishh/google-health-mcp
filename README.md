# google-health-mcp

A read-only MCP server that gives Claude, ChatGPT, Grok or any other MCP client access to your Fitbit (Fitbit Air, Charge, Pixel Watch) data through the **Google Health API v4**, the replacement for the legacy Fitbit Web API that shuts down on 2 November 2026.

Run locally, your tokens stay on your machine in `~/.config/google-health-mcp/` (file mode 0600). The server only requests `.readonly` scopes, so it cannot change or delete anything in your account.

## Tools

| Tool | Use it for |
|---|---|
| `get_daily_summary` | "How did I do today / yesterday?" Steps, distance, calories, AZM, floors, resting HR, HRV, last night's sleep, workouts. |
| `get_daily_rollup` | Trends: steps per day this month, weekly distance, daily average heart rate (90-day max range, 14 for heart rate, active minutes and calories). |
| `get_rollup` | Hourly or per-N-minute buckets, e.g. heart rate during a workout. |
| `get_data_points` | Raw records: sleep sessions with stages, exercise sessions, weight, SpO2, HRV, ECG and more. |
| `get_user_info` | Profile, settings (units, time zone, goals), Google Health user ID. |
| `list_paired_devices` | Your devices with battery level and last sync time. |
| `list_data_types` | All 35 readable data types and which tools support each. |

**Not available yet:** food logs and water intake. Google Health API v4 only offers a `nutrition.writeonly` scope, so third-party apps cannot read nutrition data that the Fitbit app recorded.

## 1. One-time Google Cloud setup (about 10 minutes)

1. **Link your Fitbit to Google Health.** Open the Fitbit / Google Health app on your phone and sign in with the Google account you will use below. Finish any "move to Google account" prompt. Without this, the API returns `ACCOUNT_NOT_LINKED`.
2. Go to <https://console.cloud.google.com/> and create a project, e.g. `my-google-health-mcp`.
3. **APIs & Services → Library**, search for **Google Health API** (`health.googleapis.com`), click **Enable**.
4. **Google Auth Platform → Branding**: fill in an app name and your email.
5. **Audience**: user type **External**. Under **Test users**, add your own Gmail address.
6. **Data Access → Add or remove scopes**: filter by "Google Health API" and tick the `.readonly` scopes for activity_and_fitness, health_metrics_and_measurements, sleep, profile and settings. Save.
7. **Clients → Create client** → type **Web application**. Under **Authorized redirect URIs** add exactly:
   ```
   http://127.0.0.1:8765/oauth2callback
   ```
8. Download the client JSON and save it as `~/.config/google-health-mcp/credentials.json`:
   ```bash
   mkdir -p ~/.config/google-health-mcp && mv ~/Downloads/client_secret_*.json ~/.config/google-health-mcp/credentials.json
   ```

> **7-day sign-in limit.** While the app's publishing status is *Testing*, Google expires the refresh token after 7 days and you must run `auth` again. To avoid that, go to **Audience → Publish app**. For a personal app you can stay unverified; Google shows an "unverified app" warning on the consent screen, which you can click through for your own account.

## 2. Install and sign in

```bash
npm install
npm run build
npm run auth
```

`auth` opens your browser, you approve access, and it prints your Google Health identity to confirm the link works. Run `node dist/index.js whoami` any time to re-check.

Optional extra scopes (ECG, irregular rhythm notifications) can be requested like this:

```bash
GOOGLE_HEALTH_SCOPES=activity,metrics,sleep,profile,settings,ecg,irn npm run auth
```

## 3. Pick how to run it

| Mode | Command | Works with |
|---|---|---|
| **Local (stdio)** | `node dist/index.js serve` | Claude Desktop, Claude Code, Cursor, VS Code, Windsurf, any MCP client that launches a local command |
| **Remote (HTTPS)** | `node dist/index.js serve --http` behind a tunnel or a host | claude.ai (web, desktop and mobile), ChatGPT, Grok, any client that takes an MCP server URL |

Local mode is the most private: data goes straight from Google to the app on your Mac. Remote mode is needed for anything that runs in the cloud, including Claude mobile, ChatGPT and Grok.

## 4. Connect a local client

All local clients run the same command. Replace the path with where you cloned this repo. If `node` comes from nvm, use the full path printed by `which node`.

**Claude Desktop.** Settings → Developer → Edit Config, then add:

```json
{
  "mcpServers": {
    "google-health": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/google-health-mcp/dist/index.js", "serve"]
    }
  }
}
```

Restart Claude Desktop.

**Claude Code.**

```bash
claude mcp add google-health -s user -- node /ABSOLUTE/PATH/TO/google-health-mcp/dist/index.js serve
```

**Cursor, VS Code, Windsurf and other clients.** Add the same `command` and `args` to the client's MCP config (`~/.cursor/mcp.json`, `.vscode/mcp.json` under `servers`, and so on).

## 5. Run it remotely

Remote mode needs four things.

1. A secret for MCP clients: `export MCP_HTTP_TOKEN=$(openssl rand -hex 32)`. Anyone with this secret can read your health data.
2. A public HTTPS address: a tunnel from your Mac, or a hosting platform (see **Deploying**).
3. A published OAuth app (Google Auth Platform → Audience → **Publish app**). In Testing mode the Google sign-in dies every 7 days, which breaks a server you are not watching.
4. On a host, the Google sign-in as environment variables instead of files:

| Variable | Value |
|---|---|
| `GOOGLE_CLIENT_ID` | from your OAuth client |
| `GOOGLE_CLIENT_SECRET` | from your OAuth client |
| `GOOGLE_REFRESH_TOKEN` | output of `jq -r .refresh_token ~/.config/google-health-mcp/token.json` after `npm run auth` on your Mac |
| `MCP_HTTP_TOKEN` | the secret from step 1 |
| `MCP_HTTP_HOST` | `0.0.0.0` (hosts only; keep the default `127.0.0.1` with a tunnel) |

The port comes from `PORT` or `MCP_HTTP_PORT`, default `8787`. The endpoint is `/mcp`, and `/healthz` returns `ok` for uptime checks.

**Quick start with a tunnel from your Mac:**

```bash
MCP_HTTP_TOKEN=... npm run start:http
```

```bash
tailscale funnel 8787
```

or `cloudflared tunnel --url http://127.0.0.1:8787`. The tunnel prints your public `https://` address.

### How clients send the secret

The server accepts the secret in either form.

- **Header (preferred):** `Authorization: Bearer <MCP_HTTP_TOKEN>`, with server URL `https://YOUR-HOST/mcp`.
- **URL (for clients without a header field):** `https://YOUR-HOST/mcp?key=<MCP_HTTP_TOKEN>`. The secret then appears in browser history and any request logs, so use the header where you can.

## 6. Connect a remote client

**claude.ai (also shows up in Claude Desktop and the Claude mobile apps).** Settings → Connectors → **Add custom connector**. URL `https://YOUR-HOST/mcp`. Authentication **No sign in**. Under **Request headers** add `Authorization` = `Bearer <MCP_HTTP_TOKEN>`. Claude connects from Anthropic's cloud, so the address must be public.

**ChatGPT.** Settings → Apps & Connectors → Advanced → turn on **Developer mode**, then **Create** a connector. URL `https://YOUR-HOST/mcp?key=<MCP_HTTP_TOKEN>`, authentication **No authentication**. Developer mode needs a paid plan, and menu names move between releases.

**Grok app.** grok.com/connectors → **New Connector** → **Custom**. Use the header form if the form offers one, otherwise the `?key=` URL.

**Grok API (xAI Responses API).**

```bash
curl https://api.x.ai/v1/responses \
  -H "Authorization: Bearer $XAI_API_KEY" -H "Content-Type: application/json" \
  -d '{
    "model": "grok-4",
    "input": "How did I sleep last night and how many steps did I do yesterday?",
    "tools": [{
      "type": "mcp",
      "server_url": "https://YOUR-HOST/mcp",
      "server_label": "google_health",
      "authorization": "'"$MCP_HTTP_TOKEN"'"
    }]
  }'
```

`grok-4` is a placeholder for any current Grok model.

**Anything else.** Any client that speaks MCP Streamable HTTP works with the URL plus either the header or `?key=`.

## Deploying

The HTTP mode is stateless: each request is independent and the Google access token is refreshed in memory, so it runs on any Node 20+ host. Set the variables from step 5 and run `npm run build && node dist/index.js serve --http`.

| Option | Cost | Notes |
|---|---|---|
| Your Mac + Tailscale Funnel or Cloudflare Tunnel | Free | Data never touches a third-party host. Only works while the Mac is awake. |
| Fly.io, Railway, Render | About $0 to $5 a month | Runs the server unchanged as a long-lived process. Render's free tier sleeps when idle. |
| Vercel | Free (Hobby) | Ready to go: `api/mcp.js` and `vercel.json` are in this repo. Steps below. |

### Deploy on Vercel (free)

1. Do steps 1 and 2 above on your computer and publish the OAuth app.
2. Link the repo to a project on your personal (Hobby) scope and add the secrets as sensitive variables. Each `env add` prompts for the value:

   ```bash
   npx vercel@latest link --project google-health-mcp
   ```

   ```bash
   openssl rand -hex 32 > ~/.config/google-health-mcp/mcp_http_token && chmod 600 ~/.config/google-health-mcp/mcp_http_token
   ```

   ```bash
   npx vercel@latest env add MCP_HTTP_TOKEN production --sensitive < ~/.config/google-health-mcp/mcp_http_token
   ```

   ```bash
   jq -r .refresh_token ~/.config/google-health-mcp/token.json | tr -d '\n' | npx vercel@latest env add GOOGLE_REFRESH_TOKEN production --sensitive
   ```

   ```bash
   npx vercel@latest env add GOOGLE_CLIENT_ID production --sensitive
   ```

   ```bash
   npx vercel@latest env add GOOGLE_CLIENT_SECRET production --sensitive
   ```

3. Deploy:

   ```bash
   npx vercel@latest deploy --prod
   ```

4. Your server URL is `https://YOUR-PROJECT.vercel.app/mcp`. Check `https://YOUR-PROJECT.vercel.app/healthz` returns `ok`.

When the project is linked to GitHub, every push to `main` redeploys production. After changing an environment variable, redeploy for it to take effect. Vercel's request logs record full URLs, so the `?key=` form leaves the secret in your (private) logs. Use the header form where the client allows it.

## Security notes

- Only `.readonly` Google scopes are requested. The server cannot change or delete your data.
- Rotate `MCP_HTTP_TOKEN` if it leaks: change the variable and update each connector.
- Revoke Google access any time at <https://myaccount.google.com/connections>.
- Never commit `credentials.json`, `token.json` or `.env`. The `.gitignore` already excludes them.

## Troubleshooting

| Message | Fix |
|---|---|
| `Not signed in to Google Health yet` | Run `npm run auth`. |
| `Google rejected the saved refresh token` | Testing-mode tokens last 7 days. Run `npm run auth` again, or publish the app (see above). |
| `has no Google Health profile yet` (`ACCOUNT_NOT_LINKED`) | Sign in to the Fitbit / Google Health phone app with the same Google account first. |
| `redirect_uri_mismatch` in the browser | The OAuth client must list exactly `http://127.0.0.1:8765/oauth2callback`. |
| `Port 8765 is busy` | Set `GOOGLE_HEALTH_OAUTH_PORT=8766` and add the matching redirect URI. |
| `Permission denied` on ECG or IRN | Re-run auth with the `ecg` / `irn` scopes listed above. |
| No data for today | The tracker has to sync to the phone app first. Open the app and pull to refresh. |

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `GOOGLE_HEALTH_MCP_HOME` | `~/.config/google-health-mcp` | Where `credentials.json` and `token.json` live |
| `GOOGLE_HEALTH_CREDENTIALS` | `$HOME/credentials.json` | Path to the downloaded OAuth client JSON |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | | Alternative to the credentials file |
| `GOOGLE_HEALTH_SCOPES` | `activity,metrics,sleep,profile,settings` | Scopes requested by `auth` |
| `GOOGLE_HEALTH_OAUTH_PORT` | `8765` | Loopback port for the sign-in redirect |
| `MCP_HTTP_TOKEN` | (required for `--http`) | Bearer secret, 32+ characters |
| `MCP_HTTP_HOST` / `MCP_HTTP_PORT` (or `PORT`) | `127.0.0.1` / `8787` | HTTP listen address |
| `GOOGLE_REFRESH_TOKEN` | | Use this refresh token instead of `token.json` (for hosted deploys) |

## Development

```bash
npm test
```

Runs the unit tests for the data type registry, filter builder and rollup request bodies. They check against the example filter strings in Google's v4 discovery document.

Unofficial project. Not affiliated with Google or Fitbit.
