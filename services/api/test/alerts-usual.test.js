// worker_unusual's question (usualDaysOn in src/alerts.js): on how many of the last 7 days was the rig mining through the stretch it
// has now been silent for? Against a real PostgreSQL (see packages/db/test/database.test.js for how to start one).
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createPool, ensureWorker } from "@xeldash/db";
import { usualDaysOn } from "../src/alerts.js";

const url = process.env.TEST_DATABASE_URL;
const skip = url ? false : "set TEST_DATABASE_URL to run the database tests";
const MIN = 60_000;
const DAY = 1440 * MIN;

let pool;
test.before(async () => {
  if (!url) return;
  const script = fileURLToPath(new URL("../../../packages/db/src/migrate.js", import.meta.url));
  execFileSync(process.execPath, [script], { env: { ...process.env, DATABASE_URL: url }, encoding: "utf8" });
  pool = createPool(url);
});
test.after(async () => { await pool?.end(); });

/** A worker with an accepted share in each minute from `from` to `to` minutes before now, on each of the given days back. */
async function worker(/** @type {number[]} */ days, /** @type {number} */ from, /** @type {number} */ to) {
  const { workerId } = await ensureWorker(pool, { address: `xet:${randomBytes(20).toString("hex")}`, name: "rig" });
  const now = Math.floor(Date.now() / MIN) * MIN;
  const times = days.flatMap((d) => Array.from({ length: from - to + 1 }, (_, i) => new Date(now - d * DAY - (from - i) * MIN)));
  await pool.query(
    `INSERT INTO worker_stats_1m (bucket, worker_id, accepted, rejected, sum_difficulty, sum_effort)
     SELECT t, $2, 1, 0, 600, 0.001 FROM unnest($1::timestamptz[]) AS t ON CONFLICT DO NOTHING`,
    [times, workerId],
  );
  return workerId;
}

const WEEK = [1, 2, 3, 4, 5, 6, 7];
// Silent for the last 11 minutes, with the offline alert at 10.
const lastShare = () => new Date(Date.now() - 11 * MIN);

test("a rig that mines around the clock was on at this time every day", { skip }, async () => {
  assert.equal(await usualDaysOn(pool, await worker(WEEK, 60, 0), lastShare(), 10), 7);
});

test("a rig on a schedule that stops at this time every day was never on now: no alert", { skip }, async () => {
  assert.equal(await usualDaysOn(pool, await worker(WEEK, 120, 12), lastShare(), 10), 0);
});

test("only the days it was on count, and a day counts with at least half of the stretch", { skip }, async () => {
  assert.equal(await usualDaysOn(pool, await worker([1, 2, 3, 4], 60, 0), lastShare(), 10), 4);
  assert.equal(await usualDaysOn(pool, await worker(WEEK, 60, 6), lastShare(), 10), 7, "on for the first 6 of the 11 minutes");
  assert.equal(await usualDaysOn(pool, await worker(WEEK, 60, 8), lastShare(), 10), 0, "on for only the first 4");
  assert.equal(await usualDaysOn(pool, await worker([8, 9, 10], 60, 0), lastShare(), 10), 0, "older than a week does not count");
});
