export interface RoutePoint {
  time: string;
  lat: number;
  lon: number;
  altitudeM?: number;
  distanceM?: number;
  heartRate?: number;
}

export interface RouteSummary {
  sport?: string;
  startTime?: string;
  endTime?: string;
  durationSeconds?: number;
  distanceKm?: number;
  elevationGainM?: number;
  heartRate?: { avg: number; max: number };
  bounds?: { north: number; south: number; east: number; west: number };
  gpsPointCount: number;
  points: RoutePoint[];
}

const EXERCISE_NAME = /^users\/[^/]+\/dataTypes\/exercise\/dataPoints\/([A-Za-z0-9_-]+)$/;
const EXERCISE_ID = /^[A-Za-z0-9_-]+$/;

/** Accepts a bare exercise id or the full data point name returned by get_data_points. */
export function parseExerciseId(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed.match(EXERCISE_NAME)?.[1] ?? (EXERCISE_ID.test(trimmed) ? trimmed : undefined);
}

function tag(block: string, name: string): string | undefined {
  return block.match(new RegExp(`<(?:\\w+:)?${name}>([^<]*)</(?:\\w+:)?${name}>`))?.[1]?.trim();
}

function num(value: string | undefined): number | undefined {
  if (value === undefined || value === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

export function parseTcxTrackpoints(xml: string): { sport?: string; points: RoutePoint[] } {
  const sport = xml.match(/<(?:\w+:)?Activity\b[^>]*\bSport="([^"]+)"/)?.[1];
  const points: RoutePoint[] = [];
  for (const [, block = ""] of xml.matchAll(/<(?:\w+:)?Trackpoint>([\s\S]*?)<\/(?:\w+:)?Trackpoint>/g)) {
    const lat = num(tag(block, "LatitudeDegrees"));
    const lon = num(tag(block, "LongitudeDegrees"));
    const time = tag(block, "Time");
    if (lat === undefined || lon === undefined || !time) continue;
    const hrBlock = block.match(/<(?:\w+:)?HeartRateBpm>([\s\S]*?)<\/(?:\w+:)?HeartRateBpm>/)?.[1];
    points.push({
      time,
      lat,
      lon,
      altitudeM: num(tag(block, "AltitudeMeters")),
      distanceM: num(tag(block, "DistanceMeters")),
      heartRate: hrBlock ? num(tag(hrBlock, "Value")) : undefined,
    });
  }
  return { sport, points };
}

function haversineM(a: RoutePoint, b: RoutePoint): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.sqrt(h));
}

/** Evenly samples at most `max` points, always keeping the first and last. */
function sample<T>(items: T[], max: number): T[] {
  if (max <= 0) return [];
  if (items.length <= max) return items;
  if (max === 1) return [items[0]!];
  const step = (items.length - 1) / (max - 1);
  return Array.from({ length: max }, (_, i) => items[Math.round(i * step)]!);
}

const round = (n: number, places: number) => Math.round(n * 10 ** places) / 10 ** places;

export function summarizeRoute(xml: string, maxPoints = 200): RouteSummary {
  const { sport, points } = parseTcxTrackpoints(xml);
  if (points.length === 0) return { sport, gpsPointCount: 0, points: [] };

  const first = points[0]!;
  const last = points[points.length - 1]!;
  const recordedDistance = last.distanceM;
  const distanceM = recordedDistance ?? points.slice(1).reduce((sum, p, i) => sum + haversineM(points[i]!, p), 0);

  let elevationGain = 0;
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1]!.altitudeM;
    const cur = points[i]!.altitudeM;
    if (prev !== undefined && cur !== undefined && cur > prev) elevationGain += cur - prev;
  }
  const rates = points.map((p) => p.heartRate).filter((v): v is number => v !== undefined);
  const lats = points.map((p) => p.lat);
  const lons = points.map((p) => p.lon);
  const start = Date.parse(first.time);
  const end = Date.parse(last.time);

  return {
    sport,
    startTime: first.time,
    endTime: last.time,
    durationSeconds: Number.isNaN(start) || Number.isNaN(end) ? undefined : Math.round((end - start) / 1000),
    distanceKm: round(distanceM / 1000, 2),
    elevationGainM: points.some((p) => p.altitudeM !== undefined) ? Math.round(elevationGain) : undefined,
    heartRate: rates.length ? { avg: Math.round(rates.reduce((a, b) => a + b, 0) / rates.length), max: Math.max(...rates) } : undefined,
    bounds: { north: round(Math.max(...lats), 5), south: round(Math.min(...lats), 5), east: round(Math.max(...lons), 5), west: round(Math.min(...lons), 5) },
    gpsPointCount: points.length,
    points: sample(points, maxPoints).map((p) => ({ ...p, lat: round(p.lat, 5), lon: round(p.lon, 5) })),
  };
}
