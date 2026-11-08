import assert from "node:assert/strict";
import { test } from "node:test";
import { parseExerciseId, summarizeRoute } from "./tcx.js";

const TCX = `<?xml version="1.0" encoding="UTF-8"?>
<TrainingCenterDatabase xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2">
<Activities><Activity Sport="Running"><Id>2026-11-08T00:30:00Z</Id><Lap><Track>
<Trackpoint><Time>2026-11-08T00:30:00Z</Time><Position><LatitudeDegrees>12.9716000</LatitudeDegrees><LongitudeDegrees>77.5946000</LongitudeDegrees></Position><AltitudeMeters>900</AltitudeMeters><DistanceMeters>0</DistanceMeters><HeartRateBpm><Value>120</Value></HeartRateBpm></Trackpoint>
<Trackpoint><Time>2026-11-08T00:30:30Z</Time><AltitudeMeters>901</AltitudeMeters></Trackpoint>
<Trackpoint><Time>2026-11-08T00:31:00Z</Time><Position><LatitudeDegrees>12.9726000</LatitudeDegrees><LongitudeDegrees>77.5956000</LongitudeDegrees></Position><AltitudeMeters>905</AltitudeMeters><DistanceMeters>150.5</DistanceMeters><HeartRateBpm><Value>140</Value></HeartRateBpm></Trackpoint>
<Trackpoint><Time>2026-11-08T00:32:00Z</Time><Position><LatitudeDegrees>12.9736000</LatitudeDegrees><LongitudeDegrees>77.5966000</LongitudeDegrees></Position><AltitudeMeters>903</AltitudeMeters><DistanceMeters>301</DistanceMeters><HeartRateBpm><Value>151</Value></HeartRateBpm></Trackpoint>
</Track></Lap></Activity></Activities></TrainingCenterDatabase>`;

const trackpoint = (i: number, lat: number) =>
  `<Trackpoint><Time>${new Date(Date.UTC(2026, 10, 8, 1, 0, i * 30)).toISOString()}</Time><Position><LatitudeDegrees>${lat.toFixed(6)}</LatitudeDegrees><LongitudeDegrees>77.5946</LongitudeDegrees></Position></Trackpoint>`;

/** An out-and-back run: 20 steps of about 111 m north from home, then back. */
const OUT_AND_BACK = `<TrainingCenterDatabase><Activities><Activity Sport="Running"><Lap><Track>${Array.from({ length: 41 }, (_, i) =>
  trackpoint(i, 12.9716 + 0.001 * (i <= 20 ? i : 40 - i)),
).join("")}</Track></Lap></Activity></Activities></TrainingCenterDatabase>`;

const HOME = { lat: 12.9716, lon: 77.5946 };
const metresFromHome = (p: { lat: number; lon: number }) => {
  const rad = Math.PI / 180;
  const h = Math.sin(((p.lat - HOME.lat) * rad) / 2) ** 2 + Math.cos(HOME.lat * rad) * Math.cos(p.lat * rad) * Math.sin(((p.lon - HOME.lon) * rad) / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.sqrt(h));
};

test("by default a route is a summary with no coordinates at all", () => {
  const route = summarizeRoute(OUT_AND_BACK);
  assert.equal(route.gpsPointCount, 41);
  assert.equal(route.distanceKm, 4.45);
  assert.equal(route.durationSeconds, 1200);
  assert.deepEqual(route.points, []);
  assert.equal(route.bounds, undefined);
  assert.doesNotMatch(JSON.stringify(route), /12\.97|77\.59/);
});

test("track points near the start and finish are never returned", () => {
  const route = summarizeRoute(OUT_AND_BACK, { maxPoints: 1000 });
  assert.ok(route.points.length > 0);
  for (const p of route.points) assert.ok(metresFromHome(p) >= 500, `point ${p.lat},${p.lon} is ${Math.round(metresFromHome(p))} m from home`);
  assert.ok(route.bounds && metresFromHome({ lat: route.bounds.south, lon: HOME.lon }) >= 500, "the map bounds do not reach home either");
  assert.equal(route.privacy?.hiddenRadiusM, 500);
  assert.equal(route.distanceKm, 4.45, "distance still counts the hidden part");
});

test("a route that never leaves the privacy zone returns no points", () => {
  const route = summarizeRoute(TCX, { maxPoints: 200 });
  assert.equal(route.gpsPointCount, 3);
  assert.deepEqual(route.points, []);
  assert.equal(route.bounds, undefined);
  assert.equal(route.privacy?.hiddenPoints, 3);
});

test("a TCX workout becomes a route summary with GPS points only", () => {
  const route = summarizeRoute(TCX, { maxPoints: 200, privacyRadiusM: 0 });
  assert.equal(route.sport, "Running");
  assert.equal(route.gpsPointCount, 3);
  assert.equal(route.durationSeconds, 120);
  assert.equal(route.distanceKm, 0.3);
  assert.equal(route.elevationGainM, 5);
  assert.deepEqual(route.heartRate, { avg: 137, max: 151 });
  assert.deepEqual(route.bounds, { north: 12.9736, south: 12.9716, east: 77.5966, west: 77.5946 });
  assert.equal(route.points[0]?.lat, 12.9716);
});

test("maxPoints thins the track but keeps the start and finish", () => {
  const route = summarizeRoute(TCX, { maxPoints: 2, privacyRadiusM: 0 });
  assert.equal(route.points.length, 2);
  assert.equal(route.points[0]?.time, "2026-11-08T00:30:00Z");
  assert.equal(route.points[1]?.time, "2026-11-08T00:32:00Z");
  assert.equal(summarizeRoute(TCX, { maxPoints: 0, privacyRadiusM: 0 }).points.length, 0);
});

test("a workout without GPS has an empty route", () => {
  assert.deepEqual(summarizeRoute("<TrainingCenterDatabase></TrainingCenterDatabase>"), { sport: undefined, gpsPointCount: 0, points: [] });
});

test("exercise ids are accepted bare or as full names, and path tricks are rejected", () => {
  assert.equal(parseExerciseId("2026443605080188808"), "2026443605080188808");
  assert.equal(parseExerciseId("users/123/dataTypes/exercise/dataPoints/2026443605080188808"), "2026443605080188808");
  assert.equal(parseExerciseId("../../identity"), undefined);
  assert.equal(parseExerciseId("users/123/dataTypes/sleep/dataPoints/1"), undefined);
});
