// Tests that need a real PostgreSQL. Set TEST_DATABASE_URL to an empty, disposable database, for example:
//   docker run -d --name xeldash-test-db -e POSTGRES_PASSWORD=test -p 55432:5432 postgres:17-alpine
//   TEST_DATABASE_URL=postgres://postgres:test@127.0.0.1:55432/postgres npm test
// Without it these tests are skipped. They add rows with random addresses and do not clean up.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPool, ensureWorker, finalizeBlock, ingestRecords, listSubmittedBlocks, recordBan, recordBlock, recordShare, recordShares, recordServiceEvent, listActiveBans } from "../src/index.js";

const url = process.env.TEST_DATABASE_URL;
const skip = url ? false : "set TEST_DATABASE_URL to run the database tests";
const hex = (n) => randomBytes(n).toString("hex");
const address = () => `xet:${hex(20)}`;

/** @type {import("pg").Pool} */
let pool;

test("migrations apply from scratch, and applying them again changes nothing", { skip }, () => {
  const script = fileURLToPath(new URL("../src/migrate.js", import.meta.url));
  const run = () => execFileSync(process.execPath, [script], { env: { ...process.env, DATABASE_URL: url }, encoding: "utf8" });
  pool = createPool(url);
  run();
  assert.doesNotMatch(run(), /Applying/, "the second run has nothing to apply");
});

test("a worker is created once per address and name, and keeps its last address", { skip }, async () => {
  const a = address();
  const first = await ensureWorker(pool, { address: a, name: "rig", ip: "10.0.0.5" });
  const again = await ensureWorker(pool, { address: a, name: "rig", ip: null });
  assert.equal(String(first.workerId), String(again.workerId));
  assert.equal(String(first.minerId), String(again.minerId));
  const other = await ensureWorker(pool, { address: a, name: "rig2" });
  assert.notEqual(String(other.workerId), String(first.workerId));
  assert.equal(String(other.minerId), String(first.minerId), "same miner, another worker");
  const { rows } = await pool.query("SELECT last_ip FROM workers WHERE id = $1", [first.workerId]);
  assert.equal(rows[0].last_ip, "10.0.0.5", "a missing address does not erase the known one");
});

test("shares: stats and reject reasons follow, with no row per share", { skip }, async () => {
  const { workerId } = await ensureWorker(pool, { address: address(), name: "w" });
  const s = { workerId, jobId: "job1", nonce: "n1", difficulty: "1000", networkDifficulty: "100000", accepted: true };
  const first = await recordShare(pool, s);
  assert.deepEqual([first.duplicate, first.accepted], [false, true]);
  // Stratum finds duplicates itself and sends them as rejected shares.
  await recordShare(pool, { ...s, accepted: false, rejectReason: "duplicate" });
  await recordShare(pool, { ...s, nonce: "n2", accepted: false, rejectReason: "stale", networkDifficulty: undefined });
  await recordShare(pool, { ...s, nonce: "n3", accepted: false, rejectReason: "stale", networkDifficulty: undefined });
  const { rows } = await pool.query("SELECT sum(accepted) a, sum(rejected) r, sum(stale) s, sum(sum_difficulty) d FROM worker_stats_1m WHERE worker_id = $1", [workerId]);
  assert.deepEqual([Number(rows[0].a), Number(rows[0].r), Number(rows[0].s), Number(rows[0].d)], [1, 3, 2, 1000], "1 accepted; a duplicate and two stale rejected");
  const reasons = await pool.query("SELECT reason, sum(count)::int AS n FROM worker_rejects_1m WHERE worker_id = $1 GROUP BY reason ORDER BY reason", [workerId]);
  assert.deepEqual(reasons.rows.map((r) => [r.reason, r.n]), [["duplicate", 1], ["stale", 2]]);
  const shares = await pool.query("SELECT to_regclass('shares') IS NOT NULL AS kept, (SELECT count(*)::int FROM shares WHERE worker_id = $1) AS n", [workerId]);
  assert.deepEqual([shares.rows[0].kept, shares.rows[0].n], [true, 0], "the old table is kept, but nothing is written to it");
});

test("a batch of shares gives the same stats as recording them one by one", { skip }, async () => {
  const one = await ensureWorker(pool, { address: address(), name: "one-by-one" });
  const many = await ensureWorker(pool, { address: address(), name: "batch" });
  const at = "2026-03-04T05:06:07.000Z";
  const later = "2026-03-04T05:07:30.000Z";
  /** @param {string | bigint} workerId */
  const shares = (workerId) => [
    { workerId, jobId: "j", nonce: "a", difficulty: "1000", networkDifficulty: "300000", accepted: true, createdAt: at },
    { workerId, jobId: "j", nonce: "b", difficulty: "1500.5", networkDifficulty: "300000", accepted: true, createdAt: at },
    { workerId, jobId: "j", nonce: "c", difficulty: "1000", accepted: false, rejectReason: "stale", createdAt: at },
    { workerId, jobId: "j", nonce: "d", difficulty: "1000", accepted: false, rejectReason: "duplicate", createdAt: at },
    { workerId, jobId: "j", nonce: "e", difficulty: "1000", networkDifficulty: "250000", accepted: true, createdAt: later },
    { workerId, jobId: "j", nonce: "f", difficulty: "1000", accepted: false, rejectReason: "low_difficulty", createdAt: later },
  ];
  for (const share of shares(one.workerId)) await recordShare(pool, share);
  assert.deepEqual(await recordShares(pool, shares(many.workerId)), { recorded: 6 });
  const stats = async (/** @type {string | bigint} */ workerId) => (await pool.query(
    `SELECT bucket, accepted::text, rejected::text, stale::text, sum_difficulty::text, sum_effort::text
     FROM worker_stats_1m WHERE worker_id = $1 ORDER BY bucket`, [workerId])).rows;
  const expected = await stats(one.workerId);
  assert.equal(expected.length, 2, "two minutes");
  assert.deepEqual(await stats(many.workerId), expected);
  const rejects = async (/** @type {string | bigint} */ workerId) => (await pool.query(
    "SELECT bucket, reason, count::int FROM worker_rejects_1m WHERE worker_id = $1 ORDER BY bucket, reason", [workerId])).rows;
  assert.equal((await rejects(one.workerId)).length, 3, "stale and duplicate in the first minute, low difficulty in the next");
  assert.deepEqual(await rejects(many.workerId), await rejects(one.workerId), "the same reject reasons, in their own minutes");
});

test("a batch keeps last_seen current, for the worker and its address", { skip }, async () => {
  const a = address();
  const rig = await ensureWorker(pool, { address: a, name: "rig" });
  const other = await ensureWorker(pool, { address: address(), name: "rig" });
  const soon = new Date(Date.now() + 3_600_000).toISOString();
  await recordShares(pool, [
    { workerId: rig.workerId, jobId: "j", nonce: "1", difficulty: "1", accepted: true, createdAt: new Date(Date.now() + 60_000).toISOString() },
    { workerId: rig.workerId, jobId: "j", nonce: "2", difficulty: "1", accepted: true, createdAt: soon },
    { workerId: other.workerId, jobId: "j", nonce: "1", difficulty: "1", accepted: true },
  ]);
  const { rows } = await pool.query(
    "SELECT w.last_seen AS worker, m.last_seen AS miner FROM workers w JOIN miners m ON m.id = w.miner_id WHERE w.id = $1", [rig.workerId]);
  assert.equal(rows[0].worker.toISOString(), soon, "the latest share in the batch");
  assert.equal(rows[0].miner.toISOString(), soon);
});

test("a batch is written whole or not at all", { skip }, async () => {
  const { workerId } = await ensureWorker(pool, { address: address(), name: "w" });
  const share = { workerId, jobId: "j", nonce: "n", difficulty: "10", accepted: true };
  const counted = async () => Number((await pool.query("SELECT coalesce(sum(accepted + rejected), 0) AS n FROM worker_stats_1m WHERE worker_id = $1", [workerId])).rows[0].n);
  await recordShares(pool, [share]);
  await assert.rejects(recordShares(pool, [{ ...share, nonce: "ok" }, { ...share, workerId: "999999999999", nonce: "no-such-worker" }]));
  assert.equal(await counted(), 1, "nothing from the refused batch");
  assert.deepEqual(await recordShares(pool, []), { recorded: 0 });
  await assert.rejects(recordShares(pool, [{ ...share, difficulty: "0" }]), TypeError, "shares are checked like single ones");
});

test("a share recorded late counts in the minute it was found", { skip }, async () => {
  const { workerId } = await ensureWorker(pool, { address: address(), name: "w" });
  await recordShare(pool, { workerId, jobId: "j", nonce: "late", difficulty: "5", accepted: true, createdAt: "2026-01-02T03:04:05.000Z" });
  await recordShare(pool, { workerId, jobId: "j", nonce: "late-r", difficulty: "5", accepted: false, rejectReason: "stale", createdAt: "2026-01-02T03:04:59.000Z" });
  const stats = await pool.query("SELECT bucket FROM worker_stats_1m WHERE worker_id = $1", [workerId]);
  const rejects = await pool.query("SELECT bucket FROM worker_rejects_1m WHERE worker_id = $1", [workerId]);
  assert.deepEqual([...stats.rows, ...rejects.rows].map((r) => r.bucket.toISOString()), ["2026-01-02T03:04:00.000Z", "2026-01-02T03:04:00.000Z"]);
});

test("blocks: a hash keeps its first found time, only the status moves on; finalizing stores the reward", { skip }, async () => {
  const { minerId, workerId } = await ensureWorker(pool, { address: address(), name: "w" });
  const hash = hex(32);
  await recordBlock(pool, { hash, height: 10, minerId, workerId, status: "submitted", foundAt: new Date("2026-01-01T00:00:00Z") });
  await recordBlock(pool, { hash, status: "orphaned", foundAt: new Date("2026-06-06T00:00:00Z") });
  let { rows } = await pool.query("SELECT status, height, found_at FROM blocks WHERE hash = $1", [hash]);
  assert.equal(rows[0].status, "orphaned");
  assert.equal(Number(rows[0].height), 10, "a later record without a height does not erase it");
  assert.equal(rows[0].found_at.toISOString(), "2026-01-01T00:00:00.000Z");
  await recordBlock(pool, { hash, status: "submitted" });
  assert.ok((await listSubmittedBlocks(pool)).some((b) => b.hash === hash));
  await finalizeBlock(pool, { hash, status: "confirmed", topoheight: 99, reward: "123456789" });
  ({ rows } = await pool.query("SELECT status, topoheight, reward FROM blocks WHERE hash = $1", [hash]));
  assert.deepEqual([rows[0].status, Number(rows[0].topoheight), String(rows[0].reward)], ["confirmed", 99, "123456789"]);
  assert.ok(!(await listSubmittedBlocks(pool)).some((b) => b.hash === hash));
});

test("bans: only those that have not expired are listed", { skip }, async () => {
  const live = `10.9.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
  await recordBan(pool, { ip: live, reason: "test", until: new Date(Date.now() + 3_600_000) });
  await recordBan(pool, { ip: "10.8.8.8", reason: "old", until: new Date(Date.now() - 3_600_000) });
  const ips = (await listActiveBans(pool)).map((b) => b.ip);
  assert.ok(ips.includes(live));
  assert.ok(!ips.includes("10.8.8.8"));
});

test("a service event can be recorded with the time it happened", { skip }, async () => {
  await recordServiceEvent(pool, "test_event", { n: 1 }, "2026-02-03T04:05:06.000Z");
  const { rows } = await pool.query("SELECT created_at, payload FROM service_events WHERE type = 'test_event' ORDER BY id DESC LIMIT 1");
  assert.equal(rows[0].created_at.toISOString(), "2026-02-03T04:05:06.000Z");
  assert.deepEqual(rows[0].payload, { n: 1 });
});

test("ingest: a batch is applied once, a resent batch is skipped, bad records are rejected, order is kept", { skip }, async () => {
  const instance = `standby-${hex(4)}`;
  const addr = address();
  const base = Date.now() * 1000;
  const at = new Date().toISOString();
  const key = { address: addr, name: "remote-rig" };
  const records = [
    { t: "worker", s: base + 1, at, address: addr, name: "remote-rig", ip: "10.0.0.77" },
    { t: "share", s: base + 2, at, key, jobId: "j", nonce: "r1", difficulty: "500", accepted: true },
    { t: "share", s: base + 3, at, key, jobId: "j", nonce: "r2", difficulty: "500", accepted: true },
    { t: "share", s: base + 4, at, key: { address: addr, name: "never-seen" }, jobId: "j", nonce: "r3", difficulty: "500", accepted: true },
    { t: "mystery", s: base + 5, at },
    { t: "event", s: base + 6, at, type: "ingest_test", payload: {} },
  ];
  const first = await ingestRecords(pool, instance, records);
  assert.deepEqual([first.applied, first.skipped, first.rejected], [5, 0, 1]);
  assert.equal(first.lastSeq, base + 6);
  const again = await ingestRecords(pool, instance, records);
  assert.deepEqual([again.applied, again.skipped], [0, 5], "resending applies nothing twice");
  const { rows } = await pool.query("SELECT sum(s.accepted)::int AS n FROM worker_stats_1m s JOIN workers w ON w.id = s.worker_id JOIN miners m ON m.id = w.miner_id WHERE m.address = $1", [addr]);
  assert.equal(rows[0].n, 3, "three shares, each counted once; a worker first seen in a share is created");
  const second = await ingestRecords(pool, instance, [{ t: "event", s: base + 7, at, type: "ingest_test", payload: {} }]);
  assert.equal(second.applied, 1, "new records after the resend still go through");
  await assert.rejects(ingestRecords(pool, "", []), TypeError);
});

test("ingest: progress is kept per sender", { skip }, async () => {
  const at = new Date().toISOString();
  const s = Date.now() * 1000 + 50;
  const record = { t: "event", s, at, type: "ingest_test", payload: {} };
  const a = await ingestRecords(pool, `a-${hex(3)}`, [record]);
  const b = await ingestRecords(pool, `b-${hex(3)}`, [record]);
  assert.deepEqual([a.applied, b.applied], [1, 1]);
});

test.after(async () => { await pool?.end(); });

test("retention: records that arrive late (a replayed journal) are still rolled into the hourly stats", { skip }, async () => {
  const { runRetention } = await import("../src/index.js");
  const { workerId } = await ensureWorker(pool, { address: address(), name: "late" });
  const hoursAgo = (h) => new Date(Date.now() - h * 3_600_000).toISOString();
  await recordShare(pool, { workerId, jobId: "j", nonce: "recent", difficulty: "10", accepted: true, createdAt: hoursAgo(5) });
  await runRetention(pool, { rawShareDays: 7, minuteStatsDays: 90, eventDays: 365 });
  // The same worker's shares from three days ago arrive only now, as after a long outage.
  await recordShare(pool, { workerId, jobId: "j", nonce: "late1", difficulty: "20", accepted: true, createdAt: hoursAgo(72) });
  await recordShare(pool, { workerId, jobId: "j", nonce: "late2", difficulty: "30", accepted: true, createdAt: hoursAgo(72) });
  await runRetention(pool, { rawShareDays: 7, minuteStatsDays: 90, eventDays: 365 });
  const { rows } = await pool.query("SELECT accepted, sum_difficulty FROM worker_stats_1h WHERE worker_id = $1 AND bucket < now() - interval '60 hours'", [workerId]);
  assert.equal(rows.length, 1, "the late hour has a row");
  assert.deepEqual([Number(rows[0].accepted), Number(rows[0].sum_difficulty)], [2, 50]);
  // Running it again changes nothing.
  await runRetention(pool, { rawShareDays: 7, minuteStatsDays: 90, eventDays: 365 });
  const again = await pool.query("SELECT accepted FROM worker_stats_1h WHERE worker_id = $1", [workerId]);
  assert.equal(again.rows.reduce((sum, r) => sum + Number(r.accepted), 0), 3);
});

test("retention: old events and bans are deleted, recent ones and blocks stay", { skip }, async () => {
  const { runRetention } = await import("../src/index.js");
  const marker = `ret_${hex(4)}`;
  const old = new Date(Date.now() - 400 * 86_400_000).toISOString();
  await recordServiceEvent(pool, marker, { n: 1 }, old);
  await recordServiceEvent(pool, marker, { n: 2 });
  const oldIp = `10.55.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
  const newIp = `10.56.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
  await recordBan(pool, { ip: oldIp, reason: "old", until: new Date(Date.now() - 400 * 86_400_000) });
  await recordBan(pool, { ip: newIp, reason: "new", until: new Date(Date.now() + 3_600_000) });
  const result = await runRetention(pool, { rawShareDays: 7, minuteStatsDays: 90, eventDays: 365 });
  assert.ok(result.events >= 1 && result.bans >= 1);
  const left = await pool.query("SELECT payload FROM service_events WHERE type = $1", [marker]);
  assert.deepEqual(left.rows.map((r) => r.payload.n), [2]);
  const bans = await pool.query("SELECT host(ip) AS ip FROM bans WHERE host(ip) = ANY($1)", [[oldIp, newIp]]);
  assert.deepEqual(bans.rows.map((r) => r.ip), [newIp]);
  await runRetention(pool, { rawShareDays: 7, minuteStatsDays: 90, eventDays: 365 });
});

test("retention: workers that never mined are deleted once unused, with their address; any that ever mined stay", { skip }, async () => {
  const { runRetention } = await import("../src/index.js");
  const daysAgo = (d) => new Date(Date.now() - d * 86_400_000).toISOString();
  const junkAddress = address();
  const junk = await ensureWorker(pool, { address: junkAddress, name: "made-up" });
  const rejectedOnly = await ensureWorker(pool, { address: address(), name: "rejected-only" });
  await recordShare(pool, { workerId: rejectedOnly.workerId, jobId: "j", nonce: "r1", difficulty: "10", accepted: false, rejectReason: "low_difficulty", createdAt: daysAgo(2) });
  const mined = await ensureWorker(pool, { address: address(), name: "mined" });
  await recordShare(pool, { workerId: mined.workerId, jobId: "j", nonce: "a1", difficulty: "10", accepted: true, createdAt: daysAgo(30) });
  const activeToday = await ensureWorker(pool, { address: address(), name: "rejected-today" });
  await recordShare(pool, { workerId: activeToday.workerId, jobId: "j", nonce: "r2", difficulty: "10", accepted: false, rejectReason: "low_difficulty" });
  const loggedInToday = await ensureWorker(pool, { address: address(), name: "new" });
  const old = [junk, rejectedOnly, mined, activeToday].map((w) => w.workerId);
  await pool.query("UPDATE workers SET last_seen = now() - interval '2 days' WHERE id = ANY($1)", [old]);
  await pool.query("UPDATE miners SET last_seen = now() - interval '2 days' WHERE address = $1", [junkAddress]);
  const result = await runRetention(pool, { rawShareDays: 7, minuteStatsDays: 90, eventDays: 365, unusedWorkerDays: 1 });
  assert.ok(result.unusedWorkers >= 2 && result.unusedMiners >= 1);
  const left = await pool.query("SELECT name FROM workers WHERE id = ANY($1) ORDER BY name", [[...old, loggedInToday.workerId]]);
  assert.deepEqual(left.rows.map((r) => r.name), ["mined", "new", "rejected-today"]);
  const miner = await pool.query("SELECT 1 FROM miners WHERE address = $1", [junkAddress]);
  assert.equal(miner.rowCount, 0, "an address left with no worker and no block goes too");
  // A worker logging in again after it was deleted simply comes back.
  const back = await ensureWorker(pool, { address: junkAddress, name: "made-up" });
  assert.ok(back.workerId);
});

test("retention: reject reasons go with the minute stats they belong to", { skip }, async () => {
  const { runRetention } = await import("../src/index.js");
  const { workerId } = await ensureWorker(pool, { address: address(), name: "rejects" });
  const daysAgo = (d) => new Date(Date.now() - d * 86_400_000).toISOString();
  await recordShare(pool, { workerId, jobId: "j", nonce: "old", difficulty: "1", accepted: false, rejectReason: "stale", createdAt: daysAgo(100) });
  await recordShare(pool, { workerId, jobId: "j", nonce: "new", difficulty: "1", accepted: false, rejectReason: "stale" });
  const result = await runRetention(pool, { rawShareDays: 7, minuteStatsDays: 90, eventDays: 365 });
  assert.ok(result.rejects >= 1);
  const { rows } = await pool.query("SELECT count(*)::int AS n FROM worker_rejects_1m WHERE worker_id = $1", [workerId]);
  assert.equal(rows[0].n, 1, "only the recent minute is left");
});

test("upgrading counts the reject reasons of the raw shares on record", { skip }, async () => {
  const { readdir, readFile } = await import("node:fs/promises");
  const pg = (await import("pg")).default;
  const dir = fileURLToPath(new URL("../migrations/", import.meta.url));
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  const upgrade = files.indexOf("009_reject_reasons.sql");
  const name = `xeldash_upgrade_${hex(4)}`;
  await pool.query(`CREATE DATABASE ${name}`);
  const client = new pg.Client({ connectionString: url.replace(/\/[^/?]*(\?|$)/, `/${name}$1`) });
  await client.connect();
  try {
    for (const file of files.slice(0, upgrade)) await client.query(await readFile(join(dir, file), "utf8"));
    const { rows: [w] } = await client.query(
      "WITH m AS (INSERT INTO miners (address) VALUES ('xet:upgrade') RETURNING id) INSERT INTO workers (miner_id, name) SELECT id, 'rig' FROM m RETURNING id");
    await client.query(
      `INSERT INTO shares (worker_id, job_id, nonce, difficulty, accepted, reject_reason, created_at) VALUES
         ($1, 'j', 'a', 1, true, NULL, '2026-10-01T10:00:10Z'),
         ($1, 'j', 'b', 1, false, 'stale', '2026-10-01T10:00:20Z'),
         ($1, 'j', 'c', 1, false, 'stale', '2026-10-01T10:00:30Z'),
         ($1, 'j', 'd', 1, false, 'low_difficulty', '2026-10-01T10:01:00Z')`, [w.id]);
    await client.query(await readFile(join(dir, files[upgrade]), "utf8"));
    const { rows } = await client.query("SELECT bucket, reason, count::int FROM worker_rejects_1m ORDER BY bucket, reason");
    assert.deepEqual(rows.map((r) => [r.bucket.toISOString(), r.reason, r.count]), [
      ["2026-10-01T10:00:00.000Z", "stale", 2],
      ["2026-10-01T10:01:00.000Z", "low_difficulty", 1],
    ]);
    const kept = await client.query("SELECT count(*)::int AS n FROM shares");
    assert.equal(kept.rows[0].n, 4, "the raw shares are left for retention");
  } finally {
    await client.end();
    await pool.query(`DROP DATABASE ${name}`);
  }
});

test("best share: the best of each minute is kept, whichever batch brings it, and only accepted shares count", { skip }, async () => {
  const { workerId } = await ensureWorker(pool, { address: address(), name: "best" });
  const at = "2026-05-06T07:08:10.000Z";
  const share = { workerId, jobId: "j", nonce: "n", difficulty: "10", accepted: true, createdAt: at };
  await recordShares(pool, [{ ...share, bestShare: 0.02 }, { ...share, bestShare: 0.3 }, { ...share, bestShare: null }]);
  await recordShares(pool, [{ ...share, bestShare: 0.1 }, { ...share, accepted: false, rejectReason: "low_difficulty", bestShare: 0.9 }]);
  let { rows } = await pool.query("SELECT best_share FROM worker_stats_1m WHERE worker_id = $1", [workerId]);
  assert.equal(rows[0].best_share, 0.3, "the best of both batches; a rejected share's value is not counted");
  await recordShares(pool, [{ ...share, bestShare: 1.25 }]);
  ({ rows } = await pool.query("SELECT best_share FROM worker_stats_1m WHERE worker_id = $1", [workerId]));
  assert.equal(rows[0].best_share, 1.25, "a block beats it");
  await assert.rejects(recordShares(pool, [{ ...share, bestShare: -1 }]), TypeError);
  await assert.rejects(recordShares(pool, [{ ...share, bestShare: Number.NaN }]), TypeError);
});

test("best share: the hourly rollup keeps each hour's best", { skip }, async () => {
  const { rollUpHourlyStats } = await import("../src/index.js");
  const { workerId } = await ensureWorker(pool, { address: address(), name: "best-hourly" });
  const hourAgo = new Date(Date.now() - 2 * 3_600_000);
  hourAgo.setUTCMinutes(10, 0, 0);
  const later = new Date(hourAgo.getTime() + 20 * 60_000);
  await recordShares(pool, [
    { workerId, jobId: "j", nonce: "a", difficulty: "1", accepted: true, createdAt: hourAgo.toISOString(), bestShare: 0.05 },
    { workerId, jobId: "j", nonce: "b", difficulty: "1", accepted: true, createdAt: later.toISOString(), bestShare: 0.4 },
  ]);
  await rollUpHourlyStats(pool, { lookbackDays: 1 });
  const { rows } = await pool.query("SELECT best_share FROM worker_stats_1h WHERE worker_id = $1", [workerId]);
  assert.deepEqual(rows.map((r) => r.best_share), [0.4]);
});
