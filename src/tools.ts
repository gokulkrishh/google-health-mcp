import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { HealthClient } from "./api.js";
import {
  DATA_TYPES,
  InputError,
  LISTABLE_IDS,
  ROLLUP_IDS,
  type DataTypeId,
  buildDailyRollUpBody,
  buildListFilter,
  buildRollUpBody,
  dateInTimeZone,
  maxListPageSize,
  maxRollupDays,
  requireList,
} from "./dataTypes.js";
import { DEFAULT_PRIVACY_RADIUS_M, parseExerciseId, summarizeRoute } from "./tcx.js";

const MAX_OUTPUT_CHARS = 80_000;
const MAX_ROLLUP_PAGES = 10;
const READ_ONLY = { readOnlyHint: true, openWorldHint: true } as const;

function ok(value: unknown): CallToolResult {
  let text = JSON.stringify(value);
  if (text.length > MAX_OUTPUT_CHARS) {
    text = `${text.slice(0, MAX_OUTPUT_CHARS)}\n…[truncated: response too large. Narrow the date range, lower pageSize, or use a rollup tool.]`;
  }
  return { content: [{ type: "text", text }] };
}

function fail(err: unknown): CallToolResult {
  return { isError: true, content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }] };
}

async function run(fn: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    return ok(await fn());
  } catch (err) {
    return fail(err);
  }
}

async function today(client: HealthClient): Promise<string> {
  const timeZone = await client.timeZone().catch(() => undefined);
  try {
    return dateInTimeZone(new Date(), timeZone);
  } catch {
    return dateInTimeZone(new Date());
  }
}

async function allPages<T extends { rollupDataPoints?: unknown[]; nextPageToken?: string }>(fetchPage: (pageToken?: string) => Promise<T>) {
  const points: unknown[] = [];
  let pageToken: string | undefined;
  for (let i = 0; i < MAX_ROLLUP_PAGES; i++) {
    const page = await fetchPage(pageToken);
    points.push(...(page.rollupDataPoints ?? []));
    pageToken = page.nextPageToken;
    if (!pageToken) break;
  }
  return { rollupDataPoints: points, ...(pageToken ? { nextPageToken: pageToken, note: "More data exists; narrow the range." } : {}) };
}

const dateString = z.string().describe("Date in YYYY-MM-DD (the user's local calendar date).");
const civilString = z.string().describe("Local date (YYYY-MM-DD) or local date-time (YYYY-MM-DDTHH:mm:ss).");

export function createServer(client = new HealthClient()): McpServer {
  const server = new McpServer({ name: "google-health", version: "0.1.0" });

  server.registerTool(
    "list_data_types",
    {
      title: "List Google Health data types",
      description: "Lists every readable Google Health / Fitbit data type, which tools support it, and the maximum rollup range.",
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () =>
      ok(
        Object.entries(DATA_TYPES).map(([id, spec]) => ({
          id,
          label: spec.label,
          get_data_points: spec.list,
          rollups: spec.rollup,
          ...(spec.rollup ? { maxRollupDays: maxRollupDays(id as DataTypeId) } : {}),
        })),
      ),
  );

  server.registerTool(
    "get_daily_summary",
    {
      title: "Daily health summary",
      description:
        "One-call overview of a single day: steps, distance, calories, active zone minutes, floors, resting heart rate, HRV, sleep that ended that day, and exercise sessions. Start here for questions like 'how did I do today/yesterday'.",
      inputSchema: { date: dateString.optional().describe("Local date YYYY-MM-DD. Defaults to today in the user's Google Health time zone.") },
      annotations: READ_ONLY,
    },
    async ({ date }) =>
      run(async () => {
        const day = date ?? (await today(client));
        const rollups = ["steps", "distance", "total-calories", "active-zone-minutes", "active-minutes", "floors"] as const;
        const lists = ["daily-resting-heart-rate", "daily-heart-rate-variability", "sleep", "exercise"] as const;
        const jobs: [string, Promise<unknown>][] = [
          ...rollups.map((id): [string, Promise<unknown>] => [id, client.dailyRollUp(id, buildDailyRollUpBody(id, day, day)).then((r) => r.rollupDataPoints ?? [])]),
          ...lists.map((id): [string, Promise<unknown>] => [
            id,
            client.listDataPoints(id, { filter: buildListFilter(id, day, day), pageSize: Math.min(50, maxListPageSize(id)) }).then((r) => r.dataPoints ?? []),
          ]),
        ];
        const settled = await Promise.allSettled(jobs.map(([, p]) => p));
        const firstFailure = settled[0];
        if (firstFailure?.status === "rejected" && settled.every((r) => r.status === "rejected")) throw firstFailure.reason;
        const summary: Record<string, unknown> = { date: day };
        settled.forEach((result, i) => {
          const key = jobs[i]![0];
          summary[key] = result.status === "fulfilled" ? result.value : { error: result.reason instanceof Error ? result.reason.message : String(result.reason) };
        });
        return summary;
      }),
  );

  server.registerTool(
    "get_daily_rollup",
    {
      title: "Daily totals over a date range",
      description:
        "Aggregated values per day (or per N days) for a data type, e.g. steps per day this week, average heart rate per day, weekly distance. Best tool for trends. Max range is 14 days for heart-rate, active-minutes, total-calories and calories-in-heart-rate-zone, 90 days otherwise.",
      inputSchema: {
        dataType: z.enum(ROLLUP_IDS),
        startDate: dateString,
        endDate: dateString.describe("Inclusive last date, YYYY-MM-DD."),
        windowDays: z.number().int().min(1).optional().describe("Days per bucket. Default 1 (one value per day); 7 gives weekly buckets."),
      },
      annotations: READ_ONLY,
    },
    async ({ dataType, startDate, endDate, windowDays }) =>
      run(async () => {
        const body = buildDailyRollUpBody(dataType, startDate, endDate, windowDays);
        return { dataType, ...(await allPages((pageToken) => client.dailyRollUp(dataType, { ...body, pageToken }))) };
      }),
  );

  server.registerTool(
    "get_rollup",
    {
      title: "Aggregates over fixed time windows",
      description:
        "Aggregated values over physical-time windows (e.g. heart rate per 60 minutes during a workout, steps per hour today). Use get_daily_rollup for per-day values.",
      inputSchema: {
        dataType: z.enum(ROLLUP_IDS),
        startTime: z.string().describe("RFC-3339 timestamp with offset, e.g. 2026-11-07T06:00:00+05:30."),
        endTime: z.string().describe("RFC-3339 timestamp with offset (exclusive)."),
        windowMinutes: z.number().int().min(1).describe("Bucket size in minutes, e.g. 60 for hourly."),
      },
      annotations: READ_ONLY,
    },
    async ({ dataType, startTime, endTime, windowMinutes }) =>
      run(async () => {
        const body = buildRollUpBody(dataType, startTime, endTime, windowMinutes);
        return { dataType, ...(await allPages((pageToken) => client.rollUp(dataType, { ...body, pageToken }))) };
      }),
  );

  server.registerTool(
    "get_data_points",
    {
      title: "Raw data points",
      description:
        "Raw records for a data type, newest first: sleep sessions with stages, exercise sessions, weight entries, daily resting heart rate, HRV, SpO2, ECG and so on. Heart-rate and steps produce many points per day, so prefer the rollup tools for those. Pass nextPageToken back as pageToken to read more. For electrocardiogram the API only filters by start, treated as UTC, and end is ignored.",
      inputSchema: {
        dataType: z.enum(LISTABLE_IDS),
        start: civilString.optional().describe("Local start, YYYY-MM-DD or YYYY-MM-DDTHH:mm:ss. Omit start and end to get the most recent records."),
        end: civilString.optional().describe("Local end. A date-only value includes that whole day. Defaults to start."),
        pageSize: z.number().int().min(1).max(1000).optional().describe("Default 50 (sleep and exercise are capped at 25)."),
        pageToken: z.string().optional(),
        filter: z.string().optional().describe("Advanced: raw AIP-160 filter that overrides start/end."),
      },
      annotations: READ_ONLY,
    },
    async ({ dataType, start, end, pageSize, pageToken, filter }) =>
      run(async () => {
        requireList(dataType);
        const effectiveFilter = filter ?? (start ? buildListFilter(dataType, start, end ?? start) : undefined);
        const size = Math.min(pageSize ?? 50, maxListPageSize(dataType));
        const res = await client.listDataPoints(dataType, { filter: effectiveFilter, pageSize: size, pageToken });
        return { dataType, filter: effectiveFilter, ...res };
      }),
  );

  const routePrivacyRadius = () => {
    const raw = process.env.ROUTE_PRIVACY_METERS?.trim();
    const configured = raw ? Number(raw) : Number.NaN;
    return Number.isFinite(configured) && configured >= 0 ? configured : DEFAULT_PRIVACY_RADIUS_M;
  };

  server.registerTool(
    "get_exercise_route",
    {
      title: "Workout GPS route",
      description:
        "Route of one GPS workout. By default returns only a summary with no coordinates: distance, duration, elevation gain and heart rate. Set maxPoints only when the user wants to see the route on a map; points near the start and finish are always hidden for privacy, because they usually reveal where the user lives. Get the exercise id from get_data_points with dataType 'exercise'. Workouts recorded without GPS have no route.",
      inputSchema: {
        exercise: z.string().describe("Exercise id, or the full data point name from get_data_points, e.g. users/123/dataTypes/exercise/dataPoints/456."),
        maxPoints: z.number().int().min(0).max(1000).optional().describe("Most track points (time, lat, lon, altitude, heart rate) to return, for drawing the route. Default 0: summary only, no coordinates. Use about 200 for a map."),
      },
      annotations: READ_ONLY,
    },
    async ({ exercise, maxPoints }) =>
      run(async () => {
        const id = parseExerciseId(exercise);
        if (!id) throw new InputError("exercise must be an exercise id or a name like users/123/dataTypes/exercise/dataPoints/456.");
        const route = summarizeRoute(await client.exerciseTcx(id), { maxPoints: maxPoints ?? 0, privacyRadiusM: routePrivacyRadius() });
        return route.gpsPointCount ? { exercise: id, ...route } : { exercise: id, ...route, note: "This workout has no GPS data." };
      }),
  );

  server.registerTool(
    "get_user_info",
    {
      title: "Profile, settings and identity",
      description: "The user's Google Health identity (user IDs), profile (age, height, stride, etc.) and settings (units, time zone, goals).",
      annotations: READ_ONLY,
    },
    async () =>
      run(async () => {
        const [identity, profile, settings] = await Promise.allSettled([client.identity(), client.profile(), client.settings()]);
        const unwrap = (r: PromiseSettledResult<unknown>) => (r.status === "fulfilled" ? r.value : { error: (r.reason as Error).message });
        return { identity: unwrap(identity), profile: unwrap(profile), settings: unwrap(settings) };
      }),
  );

  server.registerTool(
    "list_paired_devices",
    {
      title: "Paired devices",
      description: "Devices paired to the account (e.g. Fitbit Air, Pixel Watch), with battery and last sync time when available.",
      annotations: READ_ONLY,
    },
    async () => run(() => client.pairedDevices()),
  );

  return server;
}
