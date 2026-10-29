// XELDASH_PUBLIC_HIDE_WORKERS against a real PostgreSQL (see packages/db/test/database.test.js for how to start one): the real API
// server in public mode with worker names hidden. A visitor must never receive one, from any route, and gets an address's totals
// instead; the operator's admin web still has them (which also proves this test would notice a leak). Its own file: the API reads
// its settings once, when it is imported.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { testDatabase } from "../../../packages/db/test/test-database.js";

const database = await testDatabase();
const url = database?.url;
const skip = url ? false : "set TEST_DATABASE_URL to run the database tests";

// Names no other text in an answer contains.
const NAMES = ["garagepc-zq7", "kitchen-rig-zq8"];
const address = `xet:${randomBytes(20).toString("hex")}`;
let base;
let server;
let pool;

test.before(async () => {
  if (!url) return;
  const script = fileURLToPath(new URL("../../../packages/db/src/migrate.js", import.meta.url));
  execFileSync(process.execPath, [script], { env: { ...process.env, DATABASE_URL: url }, encoding: "utf8" });
  Object.assign(process.env, {
    DATABASE_URL: url, XELDASH_PUBLIC_MODE: "true", XELDASH_PUBLIC_HIDE_WORKERS: "true", XELIS_NETWORK: "devnet",
    XELDASH_VERSION_CHECK: "off", XELDASH_PRICE: "off", XELIS_RPC_URLS: "http://node.invalid:8080/json_rpc",
    STRATUM_HEALTH_URL: "http://stratum.invalid:8096/healthz", STRATUM_PROBE_HOST: "stratum.invalid",
    CONFIG_DIR: await mkdtemp(join(tmpdir(), "xeldash-hide-")),
  });
  const db = await import("@xeldash/db");
  pool = db.createPool(url);
  const now = Math.floor(Date.now() / 60_000) * 60_000;
  for (const [i, name] of NAMES.entries()) {
    const { workerId, minerId } = await db.ensureWorker(pool, { address, name });
    // 30 minutes of 3,600 difficulty a minute in the last hour: 30 H/s each over the hour, 60 for the address.
    const times = Array.from({ length: 30 }, (_, m) => new Date(now - (31 - m) * 60_000));
    await pool.query(
      `INSERT INTO worker_stats_1m (bucket, worker_id, accepted, rejected, sum_difficulty, sum_effort)
       SELECT t, $2, 2, 0, 3600, 0.001 FROM unnest($1::timestamptz[]) AS t`,
      [times, workerId],
    );
    await db.recordBlock(pool, { hash: randomBytes(32).toString("hex"), height: 100 + i, minerId, workerId, status: "pending", foundAt: new Date(now - 20 * 60_000) });
  }
  ({ server } = await import("../src/server.js"));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(undefined)));
  base = `http://127.0.0.1:${/** @type {import("node:net").AddressInfo} */ (server.address()).port}`;
});
test.after(async () => {
  await new Promise((resolve) => (server ? server.close(() => resolve(undefined)) : resolve(undefined)));
  await pool?.end();
  await database?.drop();
});

/** @param {string} path @param {Record<string, string>} [headers] */
async function get(path, headers = {}) {
  const response = await fetch(base + path, { headers });
  return { status: response.status, text: await response.text() };
}

test("with worker names hidden, a visitor gets none from any route, and an address's totals instead", { skip, timeout: 60_000 }, async () => {
  const routes = [
    "/api/v1/overview", "/api/v1/miners", `/api/v1/miners/${address}`, "/api/v1/blocks", `/api/v1/blocks?address=${address}`,
    "/api/v1/blocks.csv", `/api/v1/blocks.csv?address=${address}`, `/api/v1/hashrate?address=${address}`,
    `/api/v1/activity?address=${address}&range=24h`, `/api/v1/activity.csv?address=${address}&range=24h`, "/api/v1/rewards",
    `/api/v1/miners/${address}/workers/${NAMES[0]}`, `/api/v1/hashrate?address=${address}&worker=${NAMES[0]}`,
  ];
  for (const path of routes) {
    const { status, text } = await get(path);
    for (const name of NAMES) assert.ok(!text.includes(name), `${path} (${status}) leaks ${name}: ${text.slice(0, 300)}`);
  }
  // A worker's own page and any filter by one are not found, whether the name exists or not.
  for (const name of [NAMES[0], "no-such-rig"]) {
    assert.equal((await get(`/api/v1/miners/${address}/workers/${name}`)).status, 404);
    assert.equal(JSON.parse((await get(`/api/v1/activity?address=${address}&worker=${name}&range=24h`)).text).error, "workers_hidden");
  }
  const miner = JSON.parse((await get(`/api/v1/miners/${address}`)).text);
  assert.deepEqual(miner.workers, []);
  assert.equal(miner.workersHidden, true);
  assert.equal(miner.workerTotals.count, 2);
  assert.equal(Number(miner.workerTotals.hashrate1h), 60, "both rigs' 30 minutes of 3,600 a minute, over the hour");
  assert.equal(miner.workerTotals.accepted1h, "120");
  const blocks = JSON.parse((await get(`/api/v1/blocks?address=${address}`)).text).blocks;
  assert.equal(blocks.length, 2);
  assert.ok(blocks.every((/** @type {any} */ b) => b.address === address && !("worker" in b)), "blocks keep their address");
});

test("the operator's admin web still sees worker names (so the test above would notice a leak)", { skip, timeout: 60_000 }, async () => {
  const admin = { "x-xeldash-view": "admin" };
  const miner = JSON.parse((await get(`/api/v1/miners/${address}`, admin)).text);
  assert.deepEqual(miner.workers.map((/** @type {any} */ w) => w.name).sort(), [...NAMES].sort());
  assert.equal(miner.workersHidden, undefined);
  assert.equal((await get(`/api/v1/miners/${address}/workers/${NAMES[0]}`, admin)).status, 200);
  const csv = await get(`/api/v1/blocks.csv?address=${address}`, admin);
  for (const name of NAMES) assert.ok(csv.text.includes(name), csv.text.slice(0, 300));
});
