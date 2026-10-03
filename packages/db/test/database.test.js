// Tests that need a real PostgreSQL. Set TEST_DATABASE_URL to an empty, disposable database, for example:
//   docker run -d --name xeldash-test-db -e POSTGRES_PASSWORD=test -p 55432:5432 postgres:17-alpine
//   TEST_DATABASE_URL=postgres://postgres:test@127.0.0.1:55432/postgres npm test
// Without it these tests are skipped. They add rows with random addresses and do not clean up.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createPool, ensureWorker, finalizeBlock, ingestRecords, listSubmittedBlocks, recordBan, recordBlock, recordShare, recordServiceEvent, listActiveBans } from "../src/index.js";

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

test("shares: an accepted share is stored once, a repeat is recorded as a rejected duplicate, stats follow", { skip }, async () => {
  const { workerId } = await ensureWorker(pool, { address: address(), name: "w" });
  const s = { workerId, jobId: "job1", nonce: "n1", difficulty: "1000", networkDifficulty: "100000", accepted: true };
  const first = await recordShare(pool, s);
  assert.deepEqual([first.duplicate, first.accepted], [false, true]);
  const dup = await recordShare(pool, s);
  assert.deepEqual([dup.duplicate, dup.accepted], [true, false]);
  await recordShare(pool, { ...s, nonce: "n2", accepted: false, rejectReason: "stale", networkDifficulty: undefined });
  const { rows } = await pool.query("SELECT sum(accepted) a, sum(rejected) r, sum(stale) s, sum(sum_difficulty) d FROM worker_stats_1m WHERE worker_id = $1", [workerId]);
  assert.deepEqual([Number(rows[0].a), Number(rows[0].r), Number(rows[0].s), Number(rows[0].d)], [1, 2, 1, 1000], "1 accepted, a duplicate and a stale rejected, difficulty counted once");
});

test("a share recorded late keeps the time it was found", { skip }, async () => {
  const { workerId } = await ensureWorker(pool, { address: address(), name: "w" });
  const found = "2026-01-02T03:04:05.000Z";
  await recordShare(pool, { workerId, jobId: "j", nonce: "late", difficulty: "5", accepted: true, createdAt: found });
  const { rows } = await pool.query("SELECT created_at FROM shares WHERE worker_id = $1 AND nonce = 'late'", [workerId]);
  assert.equal(rows[0].created_at.toISOString(), found);
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
  const { rows } = await pool.query("SELECT count(*)::int AS n FROM shares s JOIN workers w ON w.id = s.worker_id JOIN miners m ON m.id = w.miner_id WHERE m.address = $1", [addr]);
  assert.equal(rows[0].n, 3, "three shares, each stored once; a worker first seen in a share is created");
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
