# google-health-mcp

Ask Claude, ChatGPT or Grok about your Fitbit data: "How did I sleep last night?", "Steps per day this month?", "Is my resting heart rate trending down?"

This is a read-only [MCP](https://modelcontextprotocol.io) server for the **Google Health API v4**, which replaced the Fitbit Web API on 2 November 2026. It works with any Fitbit or Pixel Watch that syncs to the Google Health (Fitbit) app. You deploy it once to Vercel (free), sign in with Google in your browser, and connect your AI apps to it. Nothing runs on your computer.

It only asks Google for read access, so it can never change or delete your data.

## What you need

- A Fitbit or Pixel Watch that syncs to the Fitbit / Google Health app, signed in with your Google account.
- A free [Vercel](https://vercel.com) account and a [GitHub](https://github.com) account.
- About 15 minutes.

## Setup

### 1. Deploy to Vercel

1. Fork or copy this repo to your GitHub account.
2. In Vercel, click **Add New → Project**, import the repo and click **Deploy**. Note your app's address, for example `https://my-health.vercel.app`. Below it is called `YOUR-APP`.
3. In the project, open **Storage → Create → Blob**, choose **Private**, and connect it to the project. This is where your Google sign-in is kept.
4. Open **Settings → Environment Variables** and add `MCP_HTTP_TOKEN` with a long random password (32+ characters; a password manager can generate one, or run `openssl rand -hex 32`). This is the key your AI apps use to reach your data. Save it in your password manager.

### 2. Create a Google sign-in for your app

1. Go to the [Google Cloud console](https://console.cloud.google.com/) and create a project (any name).
2. **APIs & Services → Library**: search for **Google Health API** and click **Enable**.
3. **Google Auth Platform → Branding**: enter an app name and your email.
4. **Audience**: choose **External**, add your Gmail address under **Test users**, then click **Publish app**. Publishing stops your sign-in from expiring every 7 days. Google will show an "unverified app" warning when you sign in; that is expected for a personal app.
5. **Data Access → Add or remove scopes**: filter by "Google Health API" and tick the `.readonly` scopes for `activity_and_fitness`, `health_metrics_and_measurements`, `sleep`, `profile` and `settings`. Save.
6. **Clients → Create client → Web application**. Under **Authorized redirect URIs** add `https://YOUR-APP/oauth2callback`. Create it.
7. Back in Vercel, add `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` from that client as environment variables, then go to **Deployments** and **Redeploy** the latest one.

### 3. Sign in

Open `https://YOUR-APP/auth`, paste your `MCP_HTTP_TOKEN`, and sign in with Google. You should see **Connected**.

If it says your account has no Google Health profile, open the Fitbit / Google Health phone app with the same Google account, finish any setup or "move to Google account" prompt, and sign in again.

### 4. Connect your AI app

Your server address is `https://YOUR-APP/mcp`.

| App | How |
|---|---|
| **Claude** (web, desktop, mobile) | Settings → Connectors → **Add custom connector**. URL `https://YOUR-APP/mcp`, authentication **No sign in**, and under **Request headers** add `Authorization` = `Bearer YOUR_MCP_HTTP_TOKEN`. |
| **ChatGPT** | Settings → Apps & Connectors → Advanced → turn on **Developer mode**, then create a connector. URL `https://YOUR-APP/mcp?key=YOUR_MCP_HTTP_TOKEN`, authentication **No authentication**. Needs a paid plan. |
| **Grok** | grok.com/connectors → **New Connector → Custom**. Use the header form if offered, otherwise the `?key=` URL. |
| **Claude Code** | `claude mcp add --transport http google-health https://YOUR-APP/mcp --header "Authorization: Bearer YOUR_MCP_HTTP_TOKEN"` |
| **Other MCP apps** | Streamable HTTP URL `https://YOUR-APP/mcp` with the `Authorization: Bearer` header, or the `?key=` URL. |

Menu names in these apps change often; look for "connectors" or "MCP servers". Prefer the header over `?key=` when an app allows it, because URLs end up in logs.

## What you can ask

| Tool | Answers |
|---|---|
| `get_daily_summary` | "How was my day?" Steps, distance, calories, Active Zone Minutes, floors, resting heart rate, HRV, last night's sleep, workouts. |
| `get_daily_rollup` | Trends per day or week: steps, distance, heart rate, weight (up to 90 days; 14 for heart rate, active minutes and calories). |
| `get_rollup` | Hour-by-hour or per-N-minute values, such as heart rate during a run. |
| `get_data_points` | Raw records: sleep stages, workouts, weight, SpO2, HRV, ECG and more. |
| `get_user_info` | Profile, units, time zone and goals. |
| `list_paired_devices` | Your devices, battery level and last sync. |
| `list_data_types` | All 35 readable data types. |

Not available: food and water logs. Google Health API v4 has no read permission for nutrition yet.

## Troubleshooting

| You see | Fix |
|---|---|
| `Not signed in to Google Health yet` | Open `https://YOUR-APP/auth` and sign in. |
| `Google rejected the saved sign-in` | Sign in again at `/auth`. If it keeps happening weekly, publish the Google app (step 2.4). |
| `Google OAuth client is not configured` | Add `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` in Vercel and redeploy. |
| `redirect_uri_mismatch` on Google's page | The redirect URI must be exactly `https://YOUR-APP/oauth2callback`. If you use a custom domain, also set `PUBLIC_BASE_URL=https://your-domain`. |
| `has no Google Health profile yet` | Set up the Fitbit / Google Health phone app with the same Google account. |
| Your AI app gets 401 | The token in the app does not match `MCP_HTTP_TOKEN`. |
| No data for today | Open the Fitbit app so the tracker syncs. |

To disconnect, remove the app at <https://myaccount.google.com/connections>. To lock out your AI apps, change `MCP_HTTP_TOKEN` and redeploy.

## Settings

| Variable | Required | Purpose |
|---|---|---|
| `MCP_HTTP_TOKEN` | yes | Secret your AI apps send (32+ characters) |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | yes | Your Google OAuth web client |
| Blob store (`BLOB_READ_WRITE_TOKEN`) | yes on Vercel | Added automatically when you connect a private Blob store |
| `PUBLIC_BASE_URL` | custom domains only | Public `https://` address used for the Google redirect |
| `GOOGLE_HEALTH_SCOPES` | no | Extra scopes, e.g. `activity,metrics,sleep,profile,settings,ecg,irn` |
| `GOOGLE_REFRESH_TOKEN` | no | Use a refresh token from elsewhere instead of signing in at `/auth` |

## Running on your own computer (optional)

For Claude Desktop or Claude Code without hosting anything:

1. Do step 2 above, but use the redirect URI `http://127.0.0.1:8765/oauth2callback` and save the downloaded client JSON as `~/.config/google-health-mcp/credentials.json`.
2. Run `npm install` then `npm run auth`.
3. Point your app at the command `node /path/to/google-health-mcp/dist/index.js serve`. In Claude Code that is `claude mcp add google-health -s user -- node /path/to/google-health-mcp/dist/index.js serve`.

`node dist/index.js serve --http` runs the same HTTP server as Vercel on `127.0.0.1:8787` if you want to put your own tunnel in front of it.

## Development

`npm test` builds and runs the unit tests. See [AGENTS.md](AGENTS.md) for how the code is organised.

Unofficial project. Not affiliated with Google or Fitbit.
