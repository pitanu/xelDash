// When a rig was mining, and what that time produced (src/activity.js), against a real PostgreSQL (see
// packages/db/test/database.test.js for how to start one). Minute stats are written directly: a week of a rig's minutes would be
// thousands of shares.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createPool, ensureWorker, recordBlock } from "@xeldash/db";
import { getActivity } from "../src/activity.js";

const url = process.env.TEST_DATABASE_URL;
const skip = url ? false : "set TEST_DATABASE_URL to run the database tests";
const hex = (n) => randomBytes(n).toString("hex");
const address = () => `xet:${hex(20)}`;
const MIN = 60_000;
// A fixed "now" on a minute boundary, so the expected minutes are exact.
const NOW = new Date(Math.floor(Date.now() / MIN) * MIN);

let pool;
test.before(async () => {
  if (!url) return;
  const script = fileURLToPath(new URL("../../../packages/db/src/migrate.js", import.meta.url));
  execFileSync(process.execPath, [script], { env: { ...process.env, DATABASE_URL: url }, encoding: "utf8" });
  pool = createPool(url);
  // Tracking began well before every range here (the period is cut to where the minute stats begin).
  const anchor = await ensureWorker(pool, { address: address(), name: "anchor" });
  await minutes(anchor.workerId, [new Date(NOW.getTime() - 100 * 1440 * MIN)]);
});
test.after(async () => { await pool?.end(); });

/**
 * One minute row per time given: a share's worth of work in each.
 * @param {string | bigint} workerId @param {Date[]} times @param {{ difficulty?: number, effort?: number }} [work]
 */
async function minutes(workerId, times, { difficulty = 600, effort = 0.001 } = {}) {
  await pool.query(
    `INSERT INTO worker_stats_1m (bucket, worker_id, accepted, rejected, sum_difficulty, sum_effort)
     SELECT t, $2, 1, 0, $3, $4 FROM unnest($1::timestamptz[]) AS t
     ON CONFLICT DO NOTHING`,
    [times, workerId, difficulty, effort],
  );
}
/** Every minute from `start` minutes ago for `count` minutes. */
const run = (/** @type {number} */ start, /** @type {number} */ count) => Array.from({ length: count }, (_, i) => new Date(NOW.getTime() - (start - i) * MIN));

test("a workstation on 6 hours a day: a quarter of the week, at its full speed while on", { skip }, async () => {
  const a = address();
  const { workerId } = await ensureWorker(pool, { address: a, name: "workstation" });
  // 6 hours each day for the last 7 days, starting an hour into each day of the range.
  for (let day = 7; day >= 1; day--) await minutes(workerId, run(day * 1440 - 60, 360));
  const week = await getActivity(pool, { address: a, worker: "workstation", range: "7d", now: NOW });
  assert.equal(week.periodMinutes, 7 * 1440);
  assert.equal(week.onMinutes, 7 * 360);
  assert.equal(week.dutyCycle, 0.25);
  assert.equal(week.averageOnMinutesPerDay, 360);
  assert.equal(week.hashrateWhileOn, 10, "600 difficulty a minute is 10 H/s while on, not the 2.5 H/s a whole-day average shows");
  assert.ok(Math.abs(week.expectedBlocks - 7 * 360 * 0.001) < 1e-9);
  assert.equal(week.stretches.length, 7, "one stretch a day");
  assert.equal(new Date(week.stretches[0][1]).getTime() - new Date(week.stretches[0][0]).getTime(), 360 * MIN);
  const day = await getActivity(pool, { address: a, worker: "workstation", range: "24h", now: NOW });
  assert.equal(day.onMinutes, 360);
});

test("gaps of up to 3 minutes without a share still count as on; longer gaps end the stretch", { skip }, async () => {
  const a = address();
  const { workerId } = await ensureWorker(pool, { address: a, name: "slow" });
  // 10 minutes on, 2 missing (bridged), 8 on, 10 missing (a break), 10 on.
  await minutes(workerId, [...run(100, 10), ...run(88, 8), ...run(70, 10)]);
  const r = await getActivity(pool, { address: a, worker: "slow", range: "24h", now: NOW });
  assert.equal(r.stretches.length, 2);
  assert.equal(r.onMinutes, 20 + 10, "the bridged 2 minutes count; the 10-minute break does not");
  // Exactly 3 missing minutes is still bridged; 4 is not.
  const b = address();
  const w2 = await ensureWorker(pool, { address: b, name: "edge" });
  await minutes(w2.workerId, [...run(50, 5), ...run(42, 5), ...run(33, 5)]);
  const edge = await getActivity(pool, { address: b, worker: "edge", range: "24h", now: NOW });
  assert.equal(edge.stretches.length, 2, "3 missing minutes bridged, 4 not");
  assert.equal(edge.onMinutes, 13 + 5);
});

test("an address combines its rigs; blocks found count against the work, rejected blocks do not", { skip }, async () => {
  const a = address();
  const rig1 = await ensureWorker(pool, { address: a, name: "rig1" });
  const rig2 = await ensureWorker(pool, { address: a, name: "rig2" });
  // Overlapping minutes are one minute on for the address.
  await minutes(rig1.workerId, run(200, 100), { effort: 0.01 });
  await minutes(rig2.workerId, run(150, 100), { effort: 0.01 });
  for (const [status, minutesAgo] of [["main-chain", 120], ["orphaned", 110], ["rejected", 100]]) {
    await recordBlock(pool, { hash: hex(32), height: 1, topoheight: 1, minerId: rig1.minerId, workerId: rig1.workerId, status,
      foundAt: new Date(NOW.getTime() - /** @type {number} */ (minutesAgo) * MIN) });
  }
  const all = await getActivity(pool, { address: a, range: "24h", now: NOW });
  assert.equal(all.onMinutes, 150, "minutes 200 to 50 ago, once each");
  assert.ok(Math.abs(all.expectedBlocks - 2) < 1e-9, "200 rig-minutes of 0.01");
  assert.equal(all.foundBlocks, 2, "main chain and orphaned count (as the luck figures do); rejected does not");
  assert.equal(all.luck, 1);
  const one = await getActivity(pool, { address: a, worker: "rig2", range: "24h", now: NOW });
  assert.equal(one.onMinutes, 100);
  assert.equal(one.foundBlocks, 0, "the blocks were rig1's");
});

test("a rig with no work: nothing on, no hashrate and no luck rather than zeros that look measured", { skip }, async () => {
  const r = await getActivity(pool, { address: address(), range: "30d", now: NOW });
  assert.equal(r.onMinutes, 0);
  assert.equal(r.dutyCycle, 0);
  assert.equal(r.hashrateWhileOn, null);
  assert.equal(r.luck, null);
  assert.deepEqual(r.stretches, []);
  await assert.rejects(getActivity(pool, { address: address(), range: "1y", now: NOW }), RangeError);
});
