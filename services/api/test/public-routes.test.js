// Public mode end to end against a real PostgreSQL (see packages/db/test/database.test.js for how to start one): the real API server,
// every GET route, data that holds IP addresses in every place one can be stored. A visitor must never receive one; the operator's
// admin web must still see them (which also proves this test would notice a leak).
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
const hex = (n) => randomBytes(n).toString("hex");

// Documentation addresses (RFC 5737, RFC 3849): never real miners.
const WORKER_IP = "203.0.113.77";
const BAN_IP = "203.0.113.78";
const BAN_EVENT_IP = "203.0.113.79";
const PROBLEM_IP = "203.0.113.80";
const REFUSED_IP = "2001:db8::7a";
const SEEDED = [WORKER_IP, BAN_IP, BAN_EVENT_IP, PROBLEM_IP, REFUSED_IP];
// Any dotted IPv4 address, for addresses this test did not seed (other tests share the database).
const ANY_IPV4 = /(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?![\d.])/;

let base;
let server;
let pool;
const address = `xet:${hex(20)}`;

test.before(async () => {
  if (!url) return;
  const script = fileURLToPath(new URL("../../../packages/db/src/migrate.js", import.meta.url));
  execFileSync(process.execPath, [script], { env: { ...process.env, DATABASE_URL: url }, encoding: "utf8" });
  // The API reads its settings when it is imported: set them first. Nodes and Stratum are names that do not resolve, so those
  // routes answer quickly with their "unavailable" responses (which must not leak anything either).
  Object.assign(process.env, {
    DATABASE_URL: url, XELDASH_PUBLIC_MODE: "true", XELIS_NETWORK: "devnet", XELDASH_VERSION_CHECK: "off", XELDASH_PRICE: "off",
    XELIS_RPC_URLS: "http://node.invalid:8080/json_rpc", STRATUM_HEALTH_URL: "http://stratum.invalid:8096/healthz",
    STRATUM_PROBE_HOST: "stratum.invalid", CONFIG_DIR: await mkdtemp(join(tmpdir(), "xeldash-public-")),
  });
  const db = await import("@xeldash/db");
  pool = db.createPool(url);
  await db.ensureWorker(pool, { address, name: "rig1", ip: WORKER_IP });
  await db.recordBan(pool, { ip: BAN_IP, reason: "invalid shares", until: new Date(Date.now() + 3_600_000) });
  await db.recordServiceEvent(pool, "ip_banned", { ip: BAN_EVENT_IP, reason: "invalid shares", until: new Date(Date.now() + 3_600_000).toISOString() });
  await db.recordServiceEvent(pool, "login_problem", { reason: "invalid_address", ip: PROBLEM_IP, address: "xel:typo" });
  await db.recordServiceEvent(pool, "connection_refused", { ip: REFUSED_IP, reason: "not on your local network" });
  ({ server } = await import("../src/server.js"));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(undefined)));
  base = `http://127.0.0.1:${/** @type {import("node:net").AddressInfo} */ (server.address()).port}`;
});
test.after(async () => {
  await new Promise((resolve) => (server ? server.close(() => resolve(undefined)) : resolve(undefined)));
  await pool?.end();
  await database?.drop();
});

const ROUTES = () => [
  "/health", "/api/v1/status", "/api/v1/connect", "/api/v1/price", "/api/v1/overview", "/api/v1/hashrate", "/api/v1/miners",
  `/api/v1/miners/${address}`, `/api/v1/miners/${address}/workers/rig1`, `/api/v1/hashrate?address=${address}&worker=rig1`,
  "/api/v1/blocks", "/api/v1/blocks.csv", `/api/v1/blocks?address=${address}`, "/api/v1/uptime", "/api/v1/mining-health",
  `/api/v1/activity?address=${address}&range=24h`, `/api/v1/activity.csv?address=${address}&worker=rig1&range=7d`,
  `/api/v1/block-days?address=${address}&range=1y&tz=Europe%2FHelsinki`, "/api/v1/block-days?range=90d",
  "/api/v1/front-door", "/api/v1/version", "/api/v1/rewards", "/api/v1/problems", "/api/v1/events?limit=200", "/api/v1/nope",
];

/** @param {string} path @param {Record<string, string>} [headers] */
async function body(path, headers = {}) {
  const response = await fetch(base + path, { headers });
  return { status: response.status, text: await response.text() };
}

test("a visitor of a public server never receives an IP address, from any route", { skip, timeout: 60_000 }, async () => {
  for (const path of ROUTES()) {
    // A visitor who claims to be the operator is still a visitor here: the public web server replaces this header anyway.
    for (const headers of [{}, { "x-xeldash-view": "public" }]) {
      const { status, text } = await body(path, headers);
      for (const ip of SEEDED) assert.ok(!text.includes(ip), `${path} (${status}) leaks ${ip}: ${text.slice(0, 300)}`);
      assert.doesNotMatch(text, ANY_IPV4, `${path} (${status}) contains an IPv4 address: ${text.slice(0, 300)}`);
    }
  }
  const problems = JSON.parse((await body("/api/v1/problems")).text);
  assert.deepEqual(problems, { problems: [], hidden: true });
  // Recent events are the operator's (node updates, backups, cluster): a visitor gets none.
  assert.deepEqual(JSON.parse((await body("/api/v1/events?limit=200")).text), { events: [], hidden: true });
  const connect = JSON.parse((await body("/api/v1/connect")).text);
  assert.equal(connect.view, "public");
  assert.equal(connect.publicMode, true);
});

test("the operator's admin web still sees miners' IP addresses (so the test above would notice a leak)", { skip, timeout: 60_000 }, async () => {
  const admin = { "x-xeldash-view": "admin" };
  const worker = await body(`/api/v1/miners/${address}/workers/rig1`, admin);
  assert.ok(worker.text.includes(WORKER_IP), worker.text.slice(0, 300));
  const problems = await body("/api/v1/problems", admin);
  assert.ok(problems.text.includes(PROBLEM_IP) && problems.text.includes(REFUSED_IP), problems.text.slice(0, 300));
  const status = JSON.parse((await body("/api/v1/status", admin)).text);
  assert.ok(status.bans.some((/** @type {{ ip: string }} */ b) => b.ip === BAN_IP));
  const events = await body("/api/v1/events?limit=200", admin);
  assert.ok(events.text.includes(BAN_EVENT_IP));
  assert.equal(JSON.parse((await body("/api/v1/connect", admin)).text).view, "operator");
  // The node is unreachable in this test: the dashboard is told so, not that the API failed.
  const overview = await body("/api/v1/overview", admin);
  assert.equal(overview.status, 503);
  assert.equal(JSON.parse(overview.text).error, "node_unavailable");
});

test("on-time as CSV: one row per stretch, with its length, hashrate and expected blocks, as a download", { skip, timeout: 60_000 }, async () => {
  const { workerId } = await (await import("@xeldash/db")).ensureWorker(pool, { address, name: "csvrig" });
  const now = Math.floor(Date.now() / 60_000) * 60_000;
  // 10 minutes of 6,000 difficulty each, ending 30 minutes ago: 100 H/s while on.
  const times = Array.from({ length: 10 }, (_, i) => new Date(now - (40 - i) * 60_000));
  await pool.query(
    `INSERT INTO worker_stats_1m (bucket, worker_id, accepted, rejected, sum_difficulty, sum_effort)
     SELECT t, $2, 1, 0, 6000, 0.0005 FROM unnest($1::timestamptz[]) AS t ON CONFLICT DO NOTHING`,
    [times, workerId],
  );
  const response = await fetch(`${base}/api/v1/activity.csv?address=${address}&worker=csvrig&range=24h`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/csv/);
  assert.match(response.headers.get("content-disposition") ?? "", /attachment; filename="xeldash-activity-worker-24h\.csv"/);
  const [header, ...rows] = (await response.text()).trim().split("\r\n");
  assert.equal(header, "started_at_utc,ended_at_utc,minutes,hashrate_hs,expected_blocks");
  assert.equal(rows.length, 1);
  const [start, end, minutes, hashrate, expected] = rows[0].split(",");
  assert.equal(start, times[0].toISOString());
  assert.equal(end, new Date(now - 30 * 60_000).toISOString());
  assert.equal(minutes, "10");
  assert.equal(hashrate, "100.00");
  assert.equal(expected, "0.005000");
  assert.equal((await fetch(`${base}/api/v1/activity.csv?range=24h`)).status, 400, "an address is needed");
  assert.equal((await fetch(`${base}/api/v1/activity.csv?address=${address}&range=1y`)).status, 400);
});
