import { TokenManager, signInHint } from "./auth.js";
import type { DailyRollUpBody, DataTypeId, RollUpBody } from "./dataTypes.js";

const BASE = "https://health.googleapis.com/v4/";

export class HealthApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

interface GoogleError {
  error?: { code?: number; status?: string; message?: string; details?: { reason?: string }[] };
}

function explain(status: number, body: GoogleError): string {
  const err = body.error;
  const reasons = err?.details?.map((d) => d.reason).filter(Boolean) ?? [];
  if (reasons.includes("ACCOUNT_NOT_LINKED")) {
    return "Your Google account has no Google Health profile yet. Sign in to the Google Health (Fitbit) app with this Google account, finish the profile or Fitbit migration, then try again.";
  }
  if (status === 403) {
    return `Permission denied: ${err?.message ?? "missing scope"}. This data needs a permission that was not granted at sign-in (for example GPS routes, ECG or IRN). ${signInHint()}`;
  }
  return `Google Health API ${status} ${err?.status ?? ""}: ${err?.message ?? "request failed"}`.replace(/\s+/g, " ");
}

type Query = Record<string, string | number | undefined>;

export class HealthClient {
  private timeZoneLookup?: Promise<string | undefined>;

  constructor(private readonly tokens = new TokenManager()) {}

  resetAuth(): void {
    this.tokens.reset();
    this.timeZoneLookup = undefined;
  }

  private async fetchText(method: "GET" | "POST", path: string, query?: Query, body?: unknown): Promise<{ ok: boolean; status: number; text: string }> {
    const url = new URL(path, BASE);
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined && v !== "") url.searchParams.set(k, String(v));

    const send = async (forceRefresh: boolean) =>
      fetch(url, {
        method,
        headers: {
          authorization: `Bearer ${await this.tokens.getAccessToken(forceRefresh)}`,
          ...(body ? { "content-type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(30_000),
      });

    let res = await send(false);
    if (res.status === 401) res = await send(true);
    return { ok: res.ok, status: res.status, text: await res.text() };
  }

  private async request<T>(method: "GET" | "POST", path: string, query?: Query, body?: unknown): Promise<T> {
    const { ok, status, text } = await this.fetchText(method, path, query, body);
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      throw new HealthApiError(status, `Google Health API ${status}: ${text.slice(0, 200)}`);
    }
    if (!ok) throw new HealthApiError(status, explain(status, json as GoogleError));
    return json as T;
  }

  /** Raw TCX (XML) for one exercise session, including its GPS track. */
  async exerciseTcx(exerciseId: string): Promise<string> {
    const { ok, status, text } = await this.fetchText("GET", `users/me/dataTypes/exercise/dataPoints/${exerciseId}:exportExerciseTcx`, { alt: "media" });
    if (ok) return text;
    let body: GoogleError = {};
    try {
      body = JSON.parse(text);
    } catch {}
    throw new HealthApiError(status, explain(status, body));
  }

  identity() {
    return this.request<unknown>("GET", "users/me/identity");
  }

  profile() {
    return this.request<unknown>("GET", "users/me/profile");
  }

  settings() {
    return this.request<unknown>("GET", "users/me/settings");
  }

  /** The user's IANA time zone from Google Health settings, looked up once per instance. */
  timeZone(): Promise<string | undefined> {
    this.timeZoneLookup ??= this.request<{ timeZone?: string }>("GET", "users/me/settings")
      .then((s) => s.timeZone)
      .catch((err) => {
        this.timeZoneLookup = undefined;
        throw err;
      });
    return this.timeZoneLookup;
  }

  pairedDevices(pageSize = 100) {
    return this.request<unknown>("GET", "users/me/pairedDevices", { pageSize });
  }

  listDataPoints(id: DataTypeId, opts: { filter?: string; pageSize?: number; pageToken?: string }) {
    return this.request<{ dataPoints?: unknown[]; nextPageToken?: string }>("GET", `users/me/dataTypes/${id}/dataPoints`, opts);
  }

  dailyRollUp(id: DataTypeId, body: DailyRollUpBody) {
    return this.request<{ rollupDataPoints?: unknown[]; nextPageToken?: string }>("POST", `users/me/dataTypes/${id}/dataPoints:dailyRollUp`, undefined, body);
  }

  rollUp(id: DataTypeId, body: RollUpBody) {
    return this.request<{ rollupDataPoints?: unknown[]; nextPageToken?: string }>("POST", `users/me/dataTypes/${id}/dataPoints:rollUp`, undefined, body);
  }
}
