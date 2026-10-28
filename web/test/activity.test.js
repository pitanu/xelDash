import test from "node:test";
import assert from "node:assert/strict";
import { formatDuration, onMinutesByHour } from "../src/activity.js";

/** A local time, so the test means the same in every time zone. */
const local = (/** @type {number[]} */ ...parts) => new Date(parts[0], parts[1], parts[2], parts[3] ?? 0, parts[4] ?? 0);

test("stretches are placed in this browser's own hours and days, split where they cross an hour or midnight", () => {
  const now = local(2026, 9, 28, 15, 0);
  const rows = onMinutesByHour([
    [local(2026, 9, 26, 9, 30).toISOString(), local(2026, 9, 26, 11, 0).toISOString()],
    [local(2026, 9, 27, 23, 40).toISOString(), local(2026, 9, 28, 0, 20).toISOString()],
  ], 3, now);
  assert.deepEqual(rows.map((r) => r.day.getDate()), [26, 27, 28], "oldest first, today last");
  assert.equal(rows[0].hours[9], 30);
  assert.equal(rows[0].hours[10], 60);
  assert.equal(rows[0].total, 90);
  assert.equal(rows[1].hours[23], 20, "the part before midnight");
  assert.equal(rows[2].hours[0], 20, "and after it, on the next day");
  assert.equal(rows[2].total, 20);
});

test("only the days asked for are filled; earlier parts of a stretch are left out", () => {
  const now = local(2026, 9, 28, 12);
  const rows = onMinutesByHour([[local(2026, 9, 26, 22).toISOString(), local(2026, 9, 27, 2).toISOString()]], 2, now);
  assert.deepEqual(rows.map((r) => r.total), [120, 0], "from midnight of the first day shown");
  assert.deepEqual(onMinutesByHour([], 7, now).map((r) => r.total), Array(7).fill(0));
});

test("durations read as hours and minutes", () => {
  assert.equal(formatDuration(0), "0 min");
  assert.equal(formatDuration(45), "45 min");
  assert.equal(formatDuration(60), "1 h");
  assert.equal(formatDuration(365), "6 h 5 min");
});
