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

test("a TCX workout becomes a route summary with GPS points only", () => {
  const route = summarizeRoute(TCX);
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
  const route = summarizeRoute(TCX, 2);
  assert.equal(route.points.length, 2);
  assert.equal(route.points[0]?.time, "2026-11-08T00:30:00Z");
  assert.equal(route.points[1]?.time, "2026-11-08T00:32:00Z");
  assert.equal(summarizeRoute(TCX, 0).points.length, 0);
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
