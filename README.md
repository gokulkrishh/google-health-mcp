# google-health-mcp

> **Unofficial.** A community project, not made, endorsed or supported by Google or Fitbit.

Ask Claude, ChatGPT or Grok about your Fitbit or Pixel Watch data: "How did I sleep?", "Steps this month?", "Map my last run". A private, read-only [MCP](https://modelcontextprotocol.io) server for the Google Health API that runs free on your own Vercel account. It can only read your data, never change it.

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fgokulkrishh%2Fgoogle-health-mcp&project-name=google-health-mcp&repository-name=google-health-mcp&env=MCP_HTTP_TOKEN&envDescription=A%20random%20password%20of%2032%2B%20characters%20that%20your%20AI%20apps%20use%20to%20reach%20your%20data.%20Save%20it%20in%20your%20password%20manager.&envLink=https%3A%2F%2Fgithub.com%2Fgokulkrishh%2Fgoogle-health-mcp%231-deploy&stores=%5B%7B%22type%22%3A%22blob%22%2C%22access%22%3A%22private%22%7D%5D)

## Setup

You need a Fitbit or Pixel Watch synced to the Fitbit / Google Health app, plus free Vercel and GitHub accounts. It takes about 10 minutes.

### 1. Deploy

Click **Deploy with Vercel** above. Vercel copies this repo to your GitHub, creates a private storage area for your Google sign-in, and asks for one value:

- `MCP_HTTP_TOKEN`: a random password of 32+ characters (a password manager can generate one, or run `openssl rand -hex 32`). Your AI apps use it to reach your data. Save it.

### 2. Connect Google

Open `https://YOUR-APP.vercel.app/auth`. The first time, it shows a short checklist for creating a Google sign-in, with direct links and your app's exact redirect URI to copy. Then you add two values in Vercel, redeploy, reload the page and sign in with Google.

### 3. Connect your AI app

Every app needs your server address, `https://YOUR-APP.vercel.app/mcp`, and your token:

- **Claude** (web, desktop, phone): Settings → Connectors → Add custom connector. Paste the address, choose **No sign in**, and add the request header `Authorization: Bearer YOUR_TOKEN`.
- **ChatGPT**: turn on Developer mode under Settings → Apps & Connectors, then add a connector with **No authentication** and the URL `https://YOUR-APP.vercel.app/mcp?key=YOUR_TOKEN`.
- **Claude Code**: `claude mcp add --transport http -s user google-health https://YOUR-APP.vercel.app/mcp --header "Authorization: Bearer YOUR_TOKEN"`
- **Grok and other apps**: same address, with the header if the app supports one, otherwise the `?key=` URL.

Your app's home page shows all of this with your address filled in.

## What it can read

| Tool | Answers |
|---|---|
| `get_daily_summary` | One day at a glance: steps, calories, Active Zone Minutes, resting heart rate, HRV, sleep, workouts |
| `get_daily_rollup` | Trends per day or week, up to 90 days |
| `get_rollup` | Hour-by-hour values, such as heart rate during a run |
| `get_data_points` | Raw records: sleep stages, workouts, weight, SpO2, HRV, ECG |
| `get_exercise_route` | A workout's GPS route with distance, elevation and heart rate |
| `get_user_info` | Profile, units, time zone and goals |
| `list_paired_devices` | Devices, battery and last sync |
| `list_data_types` | Every readable data type |

Food and water logs are not available: the Google Health API has no read permission for them yet.

## Skill: better answers (optional)

The [`google-health-insights`](skills/google-health-insights/SKILL.md) skill teaches the AI which tool to use for each question, how to read the raw numbers, how to compare them with your own baseline, and when to suggest seeing a doctor. It's a single file, `SKILL.md`.

**Let your AI install it.** Paste this into Claude Code or any coding agent:

```text
Install the google-health-insights skill from https://github.com/gokulkrishh/google-health-mcp.
Download https://raw.githubusercontent.com/gokulkrishh/google-health-mcp/main/skills/google-health-insights/SKILL.md
and save it as ~/.claude/skills/google-health-insights/SKILL.md, creating the folder if needed.
Then confirm the file starts with "name: google-health-insights".
```

**Or install it yourself:**

- **Claude Code:**

  ```bash
  mkdir -p ~/.claude/skills/google-health-insights && curl -fsSL https://raw.githubusercontent.com/gokulkrishh/google-health-mcp/main/skills/google-health-insights/SKILL.md -o ~/.claude/skills/google-health-insights/SKILL.md
  ```

  Start a new session to load it. It's already active when you work inside this repo.
- **Claude apps (web, desktop, phone):** download [`SKILL.md`](https://raw.githubusercontent.com/gokulkrishh/google-health-mcp/main/skills/google-health-insights/SKILL.md), put it in a folder named `google-health-insights`, zip that folder, and upload the zip as a custom skill in claude.ai settings.
- **Other AI apps:** any app that supports Agent Skills can use the same folder. For apps without skills, paste the contents of `SKILL.md` into the app's custom instructions or project instructions.

To update the skill later, run the same command or prompt again.

## Grok Bot template

[`grok-bot/TEMPLATE.md`](grok-bot/TEMPLATE.md) sets up a **Health Coach** Grok Bot in a few copy-pastes: the connector, its standing instructions, three skills (`/daily-health-brief`, `/weekly-health-review`, `/recovery-check`), and routines for a morning brief and a Sunday review.

## Troubleshooting

| You see | Fix |
|---|---|
| `Not signed in` or `Permission denied` | Open `/auth` and sign in again (also needed after new permissions are added). |
| `Google rejected the saved sign-in` | Sign in again at `/auth`. If it happens weekly, click **Publish app** in Google Auth Platform → Audience. |
| `redirect_uri_mismatch` | The Google client's redirect URI must exactly match the one shown on `/auth`. For custom domains, also set `PUBLIC_BASE_URL`. |
| `has no Google Health profile yet` | Open the Fitbit / Google Health phone app with the same Google account and finish setup. |
| 401 in your AI app | The token in the app doesn't match `MCP_HTTP_TOKEN`. |
| No data for today | Open the Fitbit app to sync. Sleep and resting heart rate appear after a night's wear. |

To disconnect Google, remove the app at <https://myaccount.google.com/connections>. To lock out your AI apps, change `MCP_HTTP_TOKEN` and redeploy.

<details>
<summary><b>All settings</b></summary>

| Variable | Purpose |
|---|---|
| `MCP_HTTP_TOKEN` | Required. Secret your AI apps send (32+ characters). |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Required. Your Google OAuth web client. |
| Blob store | Required on Vercel. Created by the Deploy button; keeps your Google sign-in. |
| `PUBLIC_BASE_URL` | Only for custom domains: your public `https://` address. |
| `GOOGLE_HEALTH_SCOPES` | Scopes to request. Default `activity,metrics,sleep,profile,settings,location`; add `ecg,irn` for ECG data. |
| `GOOGLE_REFRESH_TOKEN` | Use a refresh token from elsewhere instead of signing in at `/auth`. |

</details>

<details>
<summary><b>Run it on your own computer instead</b></summary>

1. Create the Google client as on the `/auth` checklist, but use the redirect URI `http://127.0.0.1:8765/oauth2callback`, and save the downloaded JSON as `~/.config/google-health-mcp/credentials.json`.
2. `npm install`, then `npm run auth`.
3. Add `node /path/to/google-health-mcp/dist/index.js serve` as a local MCP server, for example `claude mcp add google-health -s user -- node /path/to/google-health-mcp/dist/index.js serve`.

</details>

## Development

`npm test` builds and runs the unit tests. See [AGENTS.md](AGENTS.md) for how the code is organised. MIT licensed.
