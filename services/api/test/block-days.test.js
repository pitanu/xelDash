// Blocks found per day for the block calendar (src/block-days.js), against a real PostgreSQL (see
// packages/db/test/database.test.js for how to start one): days in the visitor's time zone, orphaned blocks found but counted apart,
// rejected ones and ones before the range left out.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createPool, ensureWorker, recordBlock } from "@xeldash/db";
import { getBlockDays, timeZoneOrUtc } from "../src/block-days.js";
import { testDatabase } from "../../../packages/db/test/test-database.js";

const database = await testDatabase();
const url = database?.url;
const skip = url ? false : "set TEST_DATABASE_URL to run the database tests";
const hex = (n) => randomBytes(n).toString("hex");
const DAY = 86_400_000;

let pool;
test.before(async () => {
  if (!url) return;
  const script = fileURLToPath(new URL("../../../packages/db/src/migrate.js", import.meta.url));
  execFileSync(process.execPath, [script], { env: { ...process.env, DATABASE_URL: url }, encoding: "utf8" });
  pool = createPool(url);
});
test.after(async () => {
  await pool?.end();
  await database?.drop();
});

/** The date of `time` in `timeZone`, as the API gives it ("2026-10-31"). @param {Date} time @param {string} timeZone */
const dayIn = (time, timeZone) => new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(time);

test("blocks per day: in the time zone asked for, orphaned ones counted apart, rejected and older ones left out", { skip }, async () => {
  const a = `xet:${hex(20)}`;
  const rig = await ensureWorker(pool, { address: a, name: "rig1" });
  const other = await ensureWorker(pool, { address: a, name: "rig2" });
  // Half an hour after a UTC midnight three days ago: that UTC day, but the evening before in New York.
  const utcMidnight = Math.floor(Date.now() / DAY) * DAY - 3 * DAY;
  const early = new Date(utcMidnight + 30 * 60_000);
  const block = (/** @type {any} */ w, /** @type {string} */ status, /** @type {Date} */ foundAt) =>
    recordBlock(pool, { hash: hex(32), minerId: w.minerId, workerId: w.workerId, status, foundAt: foundAt.toISOString() });
  await block(rig, "main-chain", early);
  await block(rig, "orphaned", new Date(early.getTime() + 60_000));
  await block(rig, "rejected", new Date(early.getTime() + 120_000));
  await block(other, "side", new Date(early.getTime() + 180_000));
  await block(rig, "main-chain", new Date(Date.now() - 400 * DAY));

  const utc = await getBlockDays(pool, { address: a, range: "1y", timeZone: "UTC" });
  assert.deepEqual(utc.days, [{ day: dayIn(early, "UTC"), blocks: 3, orphaned: 1 }], "the rejected block and the one from 400 days ago are not counted");
  const ny = await getBlockDays(pool, { address: a, range: "1y", timeZone: "America/New_York" });
  assert.equal(ny.timeZone, "America/New_York");
  assert.deepEqual(ny.days.map((d) => d.day), [dayIn(early, "America/New_York")]);
  assert.notEqual(ny.days[0].day, utc.days[0].day, "the evening before, in New York");
  const oneRig = await getBlockDays(pool, { address: a, worker: "rig1", range: "90d", timeZone: "UTC" });
  assert.deepEqual(oneRig.days, [{ day: dayIn(early, "UTC"), blocks: 2, orphaned: 1 }]);
  const pool90 = await getBlockDays(pool, { range: "90d", timeZone: "UTC" });
  assert.ok(pool90.days.some((d) => d.blocks >= 3), "the whole pool, without an address");
  await assert.rejects(getBlockDays(pool, { address: a, range: "7d" }), RangeError);
});

test("a time zone that is not one becomes UTC", () => {
  assert.equal(timeZoneOrUtc("Europe/Helsinki"), "Europe/Helsinki");
  assert.equal(timeZoneOrUtc(null), "UTC");
  assert.equal(timeZoneOrUtc("Mars/Olympus_Mons"), "UTC");
  assert.equal(timeZoneOrUtc("'; DROP TABLE blocks; --"), "UTC");
  assert.equal(timeZoneOrUtc("x".repeat(100)), "UTC");
});
