// The dashboard's queries against a real PostgreSQL (see packages/db/test/database.test.js for how to start one).
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createPool, ensureWorker, finalizeBlock, recordBlock, recordServiceEvent, recordShare } from "@xeldash/db";
import { getBlockTotals, getHashrateHistory, getMiner, getWorker, listBlocks, listEvents, listMiners, listProblems } from "../src/queries.js";
import { computePauses, getUptime } from "../src/uptime.js";

const url = process.env.TEST_DATABASE_URL;
const skip = url ? false : "set TEST_DATABASE_URL to run the database tests";
const hex = (n) => randomBytes(n).toString("hex");
const address = () => `xet:${hex(20)}`;

let pool;
test.before(() => {
  if (!url) return;
  const script = fileURLToPath(new URL("../../../packages/db/src/migrate.js", import.meta.url));
  execFileSync(process.execPath, [script], { env: { ...process.env, DATABASE_URL: url }, encoding: "utf8" });
  pool = createPool(url);
});
test.after(async () => { await pool?.end(); });

/** Shares in the minutes just before now, so they fall in the completed minutes the queries read. */
async function seedShares(workerId, { accepted = 0, rejected = 0, difficulty = "1000", minutesAgo = 3 } = {}) {
  const at = new Date(Date.now() - minutesAgo * 60_000).toISOString();
  for (let i = 0; i < accepted; i++) await recordShare(pool, { workerId, jobId: "j", nonce: `a${i}-${hex(3)}`, difficulty, networkDifficulty: "1000000", accepted: true, createdAt: at });
  for (let i = 0; i < rejected; i++) await recordShare(pool, { workerId, jobId: "j", nonce: `r${i}-${hex(3)}`, difficulty, accepted: false, rejectReason: "low difficulty", createdAt: at });
}

test("a miner's page lists its workers with shares, and leaves hidden workers out", { skip }, async () => {
  const a = address();
  const w1 = await ensureWorker(pool, { address: a, name: "rig1" });
  const w2 = await ensureWorker(pool, { address: a, name: "rig2" });
  const hidden = await ensureWorker(pool, { address: a, name: "gone" });
  await pool.query("UPDATE workers SET hidden_at = now() WHERE id = $1", [hidden.workerId]);
  await seedShares(w1.workerId, { accepted: 4, rejected: 1 });
  await seedShares(w2.workerId, { accepted: 2 });
  const miner = await getMiner(pool, a);
  assert.deepEqual(miner.workers.map((w) => w.name).sort(), ["rig1", "rig2"]);
  const rig1 = miner.workers.find((w) => w.name === "rig1");
  assert.deepEqual([rig1.accepted1h, rig1.rejected1h], ["4", "1"]);
  assert.equal(Number(rig1.hashrate1h), Math.round((4 * 1000) / 3600 * 1000) / 1000);
  assert.equal(await getMiner(pool, address()), null, "an unknown address is nothing, not an error");
  const row = (await listMiners(pool)).find((m) => m.address === a);
  assert.equal(row.workers, "2");
  assert.equal(row.accepted1h, "6");
  const worker = await getWorker(pool, a, "rig1");
  assert.equal(worker.name, "rig1");
});

test("hashrate history has a bucket for every interval, zero where nothing was found, and filters by miner and worker", { skip }, async () => {
  const a = address();
  const w = await ensureWorker(pool, { address: a, name: "only" });
  const other = await ensureWorker(pool, { address: address(), name: "other" });
  await seedShares(w.workerId, { accepted: 3, difficulty: "6000", minutesAgo: 8 });
  await seedShares(other.workerId, { accepted: 3, difficulty: "6000", minutesAgo: 8 });
  const history = await getHashrateHistory(pool, { address: a, range: "6h" });
  const mine = history.points;
  assert.equal(history.bucketSeconds, 300);
  assert.ok(mine.length >= 70, `a 6-hour range in 5-minute buckets (${mine.length})`);
  assert.equal(mine.reduce((sum, p) => sum + Number(p.accepted), 0), 3, "only this miner's shares");
  assert.ok(mine.some((p) => Number(p.hashrate) === 0), "gaps are zeros");
  assert.equal(Math.round(mine.reduce((sum, p) => sum + Number(p.hashrate) * 300, 0)), 18000, "hashrate times the bucket length gives the work done");
  const none = await getHashrateHistory(pool, { address: a, worker: "nobody", range: "6h" });
  assert.equal(none.points.reduce((sum, p) => sum + Number(p.accepted), 0), 0);
  const unknown = await getHashrateHistory(pool, { address: a, range: "nonsense" });
  assert.equal(unknown.range, "24h", "an unknown range means the default");
});

test("blocks: listed newest first, filtered by miner and worker; totals count only paid blocks as reward", { skip }, async () => {
  const a = address();
  const { minerId, workerId } = await ensureWorker(pool, { address: a, name: "w" });
  const found = (minutesAgo) => new Date(Date.now() - minutesAgo * 60_000);
  const make = async (status, reward, minutesAgo) => {
    const hash = hex(32);
    await recordBlock(pool, { hash, height: 1000 + minutesAgo, minerId, workerId, status: "submitted", foundAt: found(minutesAgo) });
    if (status !== "submitted") await finalizeBlock(pool, { hash, status, topoheight: 5, reward });
    return hash;
  };
  const first = await make("main-chain", "300000000", 30);
  await make("side", "100000000", 20);
  await make("orphaned", null, 10);
  await make("submitted", null, 5);
  const list = await listBlocks(pool, { address: a, limit: 10 });
  assert.equal(list.length, 4);
  assert.deepEqual(list.map((b) => b.status), ["submitted", "orphaned", "side", "main-chain"], "newest first");
  assert.equal(list.at(-1).hash, first);
  assert.equal(list.at(-1).reward, "300000000");
  assert.equal((await listBlocks(pool, { address: a, worker: "nobody", limit: 10 })).length, 0);
  assert.equal((await listBlocks(pool, { address: a, limit: 2 })).length, 2);
  const totals = await getBlockTotals(pool, { address: a });
  assert.equal(totals.reward, "400000000", "main-chain and side blocks are paid; orphaned and waiting are not");
  assert.deepEqual(Object.keys(totals.byStatus).sort(), ["main-chain", "orphaned", "side", "submitted"]);
  assert.equal(totals.byStatus["main-chain"].blocks, 1);
});

test("connection and login problems are grouped, counted and kept out of the general events", { skip }, async () => {
  const ip = `10.77.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
  for (let i = 0; i < 3; i++) await recordServiceEvent(pool, "connection_refused", { ip, reason: "not on your local network" });
  await recordServiceEvent(pool, "login_problem", { reason: "invalid_address", ip, address: "x".repeat(500), detail: "d".repeat(500) });
  await recordServiceEvent(pool, "problem_test_marker", { n: 1 });
  const problems = await listProblems(pool);
  const refused = problems.find((p) => p.ip === ip && p.kind === "connection_refused");
  assert.equal(refused.count, 3, "the same problem from the same place is one line with a count");
  const login = problems.find((p) => p.ip === ip && p.kind === "login_problem");
  assert.equal(login.address.length, 200, "text from a miner is cut short");
  assert.equal(login.detail.length, 300);
  const events = await listEvents(pool, 200);
  assert.ok(events.some((e) => e.type === "problem_test_marker"));
  assert.ok(!events.some((e) => e.type === "connection_refused" || e.type === "login_problem"), "problems have their own list");
});

test("uptime: the pauses recorded as events become the share of time miners could be given work", { skip }, async () => {
  const hoursAgo = (h) => new Date(Date.now() - h * 3_600_000);
  await recordServiceEvent(pool, "stratum_started", { port: 3333 }, hoursAgo(5));
  await recordServiceEvent(pool, "node_unreachable", {}, hoursAgo(3));
  await recordServiceEvent(pool, "node_ready", {}, hoursAgo(2.5));
  const result = await getUptime(pool, { range: "24h" });
  assert.ok(result.restarts >= 1);
  assert.ok(result.pauses.length >= 1);
  assert.ok(result.uptimePercent < 100 && result.uptimePercent > 0);
  assert.ok(result.pausedSeconds >= 1800, `at least the half hour just recorded (${result.pausedSeconds})`);
});

test("uptime maths never counts more than the window", () => {
  const start = new Date("2026-01-01T00:00:00Z");
  const end = new Date("2026-01-01T10:00:00Z");
  const r = computePauses([], { paused: true, reason: "node_syncing" }, start, end);
  assert.equal(r.pausedMs, 10 * 3_600_000);
});
