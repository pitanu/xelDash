// The block calendar's weeks (src/block-days.js): Monday-first columns of local days, the range's days in them and nothing else.
import test from "node:test";
import assert from "node:assert/strict";
import { calendarWeeks, localDayKey } from "../src/block-days.js";

test("weeks run Monday to Sunday, with the days before the range and after today left empty", () => {
  const now = new Date(2026, 9, 31, 15, 0); // Saturday 31 October 2026, local time
  const weeks = calendarWeeks([{ day: "2026-10-31", blocks: 2, orphaned: 1 }, { day: "2026-10-26", blocks: 1, orphaned: 0 }], 10, now);
  assert.equal(weeks.length, 2, "Thursday 22 October to Saturday 31 October");
  assert.ok(weeks.every((w) => w.length === 7));
  assert.deepEqual(weeks[0].map((c) => c?.day.getDate() ?? null), [null, null, null, 22, 23, 24, 25]);
  assert.deepEqual(weeks[1].map((c) => c?.blocks ?? null), [1, 0, 0, 0, 0, 2, null], "Monday the 26th had one; today two; Sunday is still to come");
  assert.equal(weeks[1][5]?.orphaned, 1);
  assert.equal(weeks.flat().filter(Boolean).length, 10);
});

test("a day's key is its local date", () => {
  assert.equal(localDayKey(new Date(2026, 0, 5, 23, 59)), "2026-01-05");
});
