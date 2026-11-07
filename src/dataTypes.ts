export type ScopeGroup = "activity" | "metrics" | "sleep" | "ecg" | "irn";

/**
 * How a data type is filtered by time in `dataPoints.list`, per the filter
 * grammar in the v4 discovery document.
 */
export type TimeKind =
  | "interval" // {type}.interval.civil_start_time
  | "session" // {type}.interval.civil_start_time
  | "sample" // {type}.sample_time.civil_time
  | "daily" // {type}.date
  | "sleep" // sleep.interval.civil_end_time
  | "ecg" // electrocardiogram.interval.start_time >= RFC-3339 only
  | "none";

export interface DataTypeSpec {
  label: string;
  scope: ScopeGroup;
  time: TimeKind;
  list: boolean;
  rollup: boolean;
}

const LIST_ONLY = { list: true, rollup: false } as const;
const ROLLUP_ONLY = { list: false, rollup: true } as const;
const BOTH = { list: true, rollup: true } as const;

export const DATA_TYPES = {
  "active-energy-burned": { label: "Active energy burned", scope: "activity", time: "interval", ...BOTH },
  "active-minutes": { label: "Active minutes", scope: "activity", time: "interval", ...BOTH },
  "active-zone-minutes": { label: "Active Zone Minutes", scope: "activity", time: "interval", ...BOTH },
  "activity-level": { label: "Activity level", scope: "activity", time: "interval", ...LIST_ONLY },
  altitude: { label: "Altitude", scope: "activity", time: "interval", ...BOTH },
  "blood-glucose": { label: "Blood glucose", scope: "metrics", time: "sample", ...BOTH },
  "body-fat": { label: "Body fat", scope: "metrics", time: "sample", ...BOTH },
  "calories-in-heart-rate-zone": { label: "Calories in heart rate zone", scope: "activity", time: "none", ...ROLLUP_ONLY },
  "core-body-temperature": { label: "Core body temperature", scope: "metrics", time: "sample", ...BOTH },
  "daily-heart-rate-variability": { label: "Daily HRV", scope: "metrics", time: "daily", ...LIST_ONLY },
  "daily-heart-rate-zones": { label: "Daily heart rate zones", scope: "metrics", time: "daily", ...LIST_ONLY },
  "daily-oxygen-saturation": { label: "Daily SpO2", scope: "metrics", time: "daily", ...LIST_ONLY },
  "daily-respiratory-rate": { label: "Daily respiratory rate", scope: "metrics", time: "daily", ...LIST_ONLY },
  "daily-resting-heart-rate": { label: "Daily resting heart rate", scope: "metrics", time: "daily", ...LIST_ONLY },
  "daily-sleep-temperature-derivations": { label: "Daily sleep temperature", scope: "metrics", time: "daily", ...LIST_ONLY },
  "daily-vo2-max": { label: "Daily VO2 max", scope: "activity", time: "daily", ...LIST_ONLY },
  distance: { label: "Distance", scope: "activity", time: "interval", ...BOTH },
  electrocardiogram: { label: "ECG readings", scope: "ecg", time: "ecg", ...LIST_ONLY },
  exercise: { label: "Exercise sessions", scope: "activity", time: "session", ...LIST_ONLY },
  floors: { label: "Floors climbed", scope: "activity", time: "interval", ...ROLLUP_ONLY },
  "heart-rate": { label: "Heart rate", scope: "metrics", time: "sample", ...BOTH },
  "heart-rate-variability": { label: "Heart rate variability samples", scope: "metrics", time: "sample", ...LIST_ONLY },
  height: { label: "Height", scope: "metrics", time: "sample", ...LIST_ONLY },
  "irregular-rhythm-notification": { label: "Irregular rhythm notifications", scope: "irn", time: "session", ...LIST_ONLY },
  "oxygen-saturation": { label: "SpO2 samples", scope: "metrics", time: "sample", ...LIST_ONLY },
  "respiratory-rate-sleep-summary": { label: "Respiratory rate during sleep", scope: "metrics", time: "sample", ...LIST_ONLY },
  "run-vo2-max": { label: "Run VO2 max", scope: "activity", time: "sample", ...BOTH },
  "sedentary-period": { label: "Sedentary periods", scope: "activity", time: "interval", ...BOTH },
  sleep: { label: "Sleep sessions", scope: "sleep", time: "sleep", ...LIST_ONLY },
  steps: { label: "Steps", scope: "activity", time: "interval", ...BOTH },
  "swim-lengths-data": { label: "Swim lengths", scope: "activity", time: "interval", ...BOTH },
  "time-in-heart-rate-zone": { label: "Time in heart rate zone", scope: "activity", time: "interval", ...BOTH },
  "total-calories": { label: "Total calories", scope: "activity", time: "none", ...ROLLUP_ONLY },
  "vo2-max": { label: "VO2 max", scope: "activity", time: "sample", ...LIST_ONLY },
  weight: { label: "Weight", scope: "metrics", time: "sample", ...BOTH },
} as const satisfies Record<string, DataTypeSpec>;

export type DataTypeId = keyof typeof DATA_TYPES;

const ALL_IDS = Object.keys(DATA_TYPES) as DataTypeId[];
export const LISTABLE_IDS = ALL_IDS.filter((id) => DATA_TYPES[id].list) as [DataTypeId, ...DataTypeId[]];
export const ROLLUP_IDS = ALL_IDS.filter((id) => DATA_TYPES[id].rollup) as [DataTypeId, ...DataTypeId[]];

const FOURTEEN_DAY_TYPES = new Set<DataTypeId>(["heart-rate", "active-minutes", "total-calories", "calories-in-heart-rate-zone"]);
const SESSION_PAGE_TYPES = new Set<DataTypeId>(["exercise", "sleep"]);

export function maxRollupDays(id: DataTypeId): number {
  return FOURTEEN_DAY_TYPES.has(id) ? 14 : 90;
}

export function maxListPageSize(id: DataTypeId): number {
  return SESSION_PAGE_TYPES.has(id) ? 25 : 10000;
}

export function maxDailyRollupPageSize(id: DataTypeId): number {
  return FOURTEEN_DAY_TYPES.has(id) ? 14 : 90;
}

export class InputError extends Error {}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const CIVIL = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?)?$/;

export interface CivilDate {
  year: number;
  month: number;
  day: number;
}

export function parseDate(value: string): CivilDate {
  if (!DATE.test(value)) throw new InputError(`Expected a date like 2026-11-07, got "${value}".`);
  const [year, month, day] = value.split("-").map(Number) as [number, number, number];
  const check = new Date(Date.UTC(year, month - 1, day));
  if (check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) throw new InputError(`"${value}" is not a real date.`);
  return { year, month, day };
}

export function formatDate(d: CivilDate): string {
  return `${d.year}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}`;
}

/** Calendar date (YYYY-MM-DD) of `now` in an IANA time zone; the process time zone when omitted. */
export function dateInTimeZone(now: Date, timeZone?: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

export function addDays(value: string, days: number): string {
  const { year, month, day } = parseDate(value);
  const t = new Date(Date.UTC(year, month - 1, day + days));
  return formatDate({ year: t.getUTCFullYear(), month: t.getUTCMonth() + 1, day: t.getUTCDate() });
}

export function daysBetween(start: string, endExclusive: string): number {
  const a = parseDate(start);
  const b = parseDate(endExclusive);
  return (Date.UTC(b.year, b.month - 1, b.day) - Date.UTC(a.year, a.month - 1, a.day)) / 86_400_000;
}

/**
 * Converts a user-facing range into a closed-open civil range.
 * A date-only `end` is inclusive (the whole day is included); an `end` with a time is exclusive.
 */
export function civilRange(start: string, end: string): { start: string; endExclusive: string; endDateExclusive: string } {
  const lo = normalizeCivil(start, "start");
  const hi = normalizeCivil(end, "end");
  const endExclusive = DATE.test(hi) ? addDays(hi, 1) : hi;
  if (endExclusive <= lo) throw new InputError("end must be after start.");
  const endDateExclusive = DATE.test(endExclusive) ? endExclusive : addDays(endExclusive.slice(0, 10), 1);
  return { start: lo, endExclusive, endDateExclusive };
}

function normalizeCivil(value: string, name: string): string {
  if (!CIVIL.test(value)) throw new InputError(`${name} must look like 2026-11-07 or 2026-11-07T08:00:00, got "${value}".`);
  parseDate(value.slice(0, 10));
  return value.length === 16 ? `${value}:00` : value;
}

function prefix(id: DataTypeId): string {
  return id.replaceAll("-", "_");
}

/** Builds an AIP-160 filter for `dataPoints.list` from an inclusive start and end. */
export function buildListFilter(id: DataTypeId, start: string, end: string): string | undefined {
  const spec: DataTypeSpec = DATA_TYPES[id];
  const p = prefix(id);
  const range = civilRange(start, end);
  const between = (field: string, lo: string, hi: string) => `${field} >= "${lo}" AND ${field} < "${hi}"`;

  switch (spec.time) {
    case "interval":
    case "session":
      return between(`${p}.interval.civil_start_time`, range.start, range.endExclusive);
    case "sample":
      return between(`${p}.sample_time.civil_time`, range.start, range.endExclusive);
    case "daily":
      return between(`${p}.date`, range.start.slice(0, 10), range.endDateExclusive);
    case "sleep":
      return between("sleep.interval.civil_end_time", range.start, range.endExclusive);
    case "ecg":
      return `electrocardiogram.interval.start_time >= "${DATE.test(range.start) ? `${range.start}T00:00:00` : range.start}Z"`;
    case "none":
      return undefined;
  }
}

export function requireList(id: DataTypeId): void {
  if (!DATA_TYPES[id].list) {
    throw new InputError(`${id} cannot be listed as raw data points. Use get_daily_rollup or get_rollup instead.`);
  }
}

export function requireRollup(id: DataTypeId): void {
  if (!DATA_TYPES[id].rollup) {
    throw new InputError(`${id} does not support rollups. Use get_data_points instead.`);
  }
}

export interface DailyRollUpBody {
  range: { start: { date: CivilDate }; end: { date: CivilDate } };
  windowSizeDays: number;
  pageSize: number;
  pageToken?: string;
}

/** Body for `dataPoints:dailyRollUp`. `endDate` is inclusive. */
export function buildDailyRollUpBody(id: DataTypeId, startDate: string, endDate: string, windowSizeDays = 1): DailyRollUpBody {
  requireRollup(id);
  const endExclusive = addDays(endDate, 1);
  const days = daysBetween(startDate, endExclusive);
  if (days < 1) throw new InputError("endDate must be on or after startDate.");
  const max = maxRollupDays(id);
  if (days > max) throw new InputError(`${id} rollups cover at most ${max} days; you asked for ${days}. Split the range.`);
  if (!Number.isInteger(windowSizeDays) || windowSizeDays < 1) throw new InputError("windowDays must be a whole number of at least 1.");
  return {
    range: { start: { date: parseDate(startDate) }, end: { date: parseDate(endExclusive) } },
    windowSizeDays,
    pageSize: maxDailyRollupPageSize(id),
  };
}

export interface RollUpBody {
  range: { startTime: string; endTime: string };
  windowSize: string;
  pageSize: number;
  pageToken?: string;
}

/** Body for `dataPoints:rollUp` over physical time. */
export function buildRollUpBody(id: DataTypeId, startTime: string, endTime: string, windowMinutes: number): RollUpBody {
  requireRollup(id);
  const a = Date.parse(startTime);
  const b = Date.parse(endTime);
  if (Number.isNaN(a) || Number.isNaN(b)) throw new InputError("startTime and endTime must be RFC-3339 timestamps, e.g. 2026-11-07T06:00:00+05:30.");
  if (b <= a) throw new InputError("endTime must be after startTime.");
  const max = maxRollupDays(id);
  if (b - a > max * 86_400_000) throw new InputError(`${id} rollups cover at most ${max} days. Shorten the range.`);
  if (!Number.isInteger(windowMinutes) || windowMinutes < 1) throw new InputError("windowMinutes must be a whole number of at least 1.");
  const buckets = Math.ceil((b - a) / (windowMinutes * 60_000));
  if (buckets > 10000) throw new InputError(`That would return ${buckets} buckets. Use a larger windowMinutes.`);
  return {
    range: { startTime: new Date(a).toISOString(), endTime: new Date(b).toISOString() },
    windowSize: `${windowMinutes * 60}s`,
    pageSize: Math.min(buckets, 10000),
  };
}
