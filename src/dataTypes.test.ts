import assert from "node:assert/strict";
import { test } from "node:test";
import { InputError, buildDailyRollUpBody, buildListFilter, buildRollUpBody, dateInTimeZone } from "./dataTypes.js";

test("list filters match the examples in the v4 discovery document", () => {
  assert.equal(
    buildListFilter("steps", "2023-11-24", "2023-11-24"),
    'steps.interval.civil_start_time >= "2023-11-24" AND steps.interval.civil_start_time < "2023-11-25"',
  );
  assert.equal(
    buildListFilter("weight", "2023-11-24", "2023-11-24"),
    'weight.sample_time.civil_time >= "2023-11-24" AND weight.sample_time.civil_time < "2023-11-25"',
  );
  assert.equal(
    buildListFilter("exercise", "2023-11-24", "2023-11-24"),
    'exercise.interval.civil_start_time >= "2023-11-24" AND exercise.interval.civil_start_time < "2023-11-25"',
  );
  assert.equal(
    buildListFilter("sleep", "2023-11-24", "2023-11-24"),
    'sleep.interval.civil_end_time >= "2023-11-24" AND sleep.interval.civil_end_time < "2023-11-25"',
  );
  assert.equal(
    buildListFilter("daily-heart-rate-variability", "2024-08-01", "2024-08-14"),
    'daily_heart_rate_variability.date >= "2024-08-01" AND daily_heart_rate_variability.date < "2024-08-15"',
  );
  assert.equal(buildListFilter("electrocardiogram", "2024-08-14", "2024-08-20"), 'electrocardiogram.interval.start_time >= "2024-08-14T00:00:00Z"');
});

test("HH:mm times are padded and daily types keep the end date's whole day", () => {
  assert.equal(
    buildListFilter("weight", "2026-11-07T06:00", "2026-11-07T07:30"),
    'weight.sample_time.civil_time >= "2026-11-07T06:00:00" AND weight.sample_time.civil_time < "2026-11-07T07:30:00"',
  );
  assert.equal(
    buildListFilter("daily-resting-heart-rate", "2026-11-07T06:00", "2026-11-07T07:30"),
    'daily_resting_heart_rate.date >= "2026-11-07" AND daily_resting_heart_rate.date < "2026-11-08"',
  );
});

test("a date-time end is exclusive and kept as given", () => {
  assert.equal(
    buildListFilter("heart-rate", "2026-11-07T06:00:00", "2026-11-07T07:00:00"),
    'heart_rate.sample_time.civil_time >= "2026-11-07T06:00:00" AND heart_rate.sample_time.civil_time < "2026-11-07T07:00:00"',
  );
});

test("bad dates and reversed ranges are rejected", () => {
  assert.throws(() => buildListFilter("steps", "2026-02-30", "2026-03-01"), InputError);
  assert.throws(() => buildListFilter("steps", "11/07/2026", "2026-11-08"), InputError);
  assert.throws(() => buildListFilter("steps", "2026-11-08", "2026-11-06"), InputError);
});

test("dailyRollUp body uses an exclusive end date and the per-type page size", () => {
  assert.deepEqual(buildDailyRollUpBody("steps", "2026-10-31", "2026-11-06"), {
    range: { start: { date: { year: 2026, month: 10, day: 31 } }, end: { date: { year: 2026, month: 11, day: 7 } } },
    windowSizeDays: 1,
    pageSize: 90,
  });
  assert.equal(buildDailyRollUpBody("heart-rate", "2026-11-01", "2026-11-07").pageSize, 14);
});

test("rollup range limits follow the documented 14 and 90 day caps", () => {
  assert.doesNotThrow(() => buildDailyRollUpBody("heart-rate", "2026-11-01", "2026-11-14"));
  assert.throws(() => buildDailyRollUpBody("heart-rate", "2026-11-01", "2026-11-15"), /at most 14 days/);
  assert.doesNotThrow(() => buildDailyRollUpBody("steps", "2026-08-10", "2026-11-07"));
  assert.throws(() => buildDailyRollUpBody("steps", "2026-08-09", "2026-11-07"), /at most 90 days/);
});

test("rollUp body converts to UTC timestamps and a Duration window", () => {
  assert.deepEqual(buildRollUpBody("heart-rate", "2026-11-07T06:00:00+05:30", "2026-11-07T08:00:00+05:30", 30), {
    range: { startTime: "2026-11-07T00:30:00.000Z", endTime: "2026-11-07T02:30:00.000Z" },
    windowSize: "1800s",
    pageSize: 4,
  });
  assert.throws(() => buildRollUpBody("heart-rate", "2026-11-01T00:00:00Z", "2026-11-16T00:00:00Z", 60), /at most 14 days/);
});

test("operations a type does not support are rejected before any request", () => {
  assert.throws(() => buildDailyRollUpBody("sleep", "2026-11-01", "2026-11-07"), /does not support rollups/);
});

test("today is taken from the user's time zone, not the server clock", () => {
  const earlyMorningInIndia = new Date("2026-11-07T20:30:00Z");
  assert.equal(dateInTimeZone(earlyMorningInIndia, "Asia/Kolkata"), "2026-11-08");
  assert.equal(dateInTimeZone(earlyMorningInIndia, "UTC"), "2026-11-07");
  assert.equal(dateInTimeZone(earlyMorningInIndia, "America/Los_Angeles"), "2026-11-07");
});
