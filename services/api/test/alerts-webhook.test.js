// What a webhook receives for each alert: { event, text, ...fields, sentAt }, with the fields listed in docs/OPERATIONS.md#webhook-alerts.
// These are promised from 1.0.0: a field may be added, but none listed here is renamed or removed. The payloads below are the ones the
// services record (Stratum, the block tracker, node-admin), so a change there that would change the webhook fails here.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { alertConfigFromEnv, startAlerts } from "../src/alerts.js";

const quiet = { info() {}, warn() {} };
const ADDRESS = `xel:${"a".repeat(59)}`;
const HASH = "ab".repeat(32);
const nodes = { daemon: "syncing", daemon2: "unreachable" };

/** Each recorded event, what the alert is called, and the fields its webhook body has besides event, text and sentAt. */
const CASES = [
  ["block_submitted", { hash: HASH, height: 100, jobId: "1a", workerName: "rig1" }, "block_found", ["hash", "height", "jobId", "workerName", "address"]],
  ["block_rejected", { hash: HASH, height: 100, jobId: "1a", workerName: "rig1", error: "Invalid PoW" }, "block_rejected", ["hash", "height", "jobId", "workerName", "error"]],
  ["block_side", { hash: HASH, height: 100 }, "block_side", ["hash", "height"]],
  ["node_syncing", { topoheight: 10, networkTopoheight: 20, peers: 8, nodes, reason: "syncing" }, "mining_paused", ["topoheight", "networkTopoheight", "peers", "nodes", "reason"]],
  ["node_unreachable", { nodes, reason: "unreachable" }, "mining_paused", ["nodes", "reason"]],
  ["node_ready", { node: "daemon", nodes: { daemon: "ready" } }, "mining_resumed", ["node", "nodes"]],
  ["node_switched", { from: "daemon", to: "daemon2", nodes: { daemon: "syncing", daemon2: "ready" } }, "node_switched", ["from", "to", "nodes"]],
  ["node_update_started", { target: "1.25.0", trigger: "dashboard", nodes: ["daemon2", "daemon"] }, "node_update", ["target", "trigger", "nodes", "outcome"]],
  ["node_update_done", { target: "1.25.0", trigger: "dashboard", nodes: ["daemon2", "daemon"], switched: ["daemon2", "daemon"] }, "node_update", ["target", "trigger", "nodes", "switched", "outcome"]],
  ["node_update_failed", { target: "1.25.0", trigger: "scheduled", nodes: ["daemon2", "daemon"], node: "daemon2", error: "exited" }, "node_update", ["target", "trigger", "nodes", "node", "error", "outcome"]],
  ["chain_copy_failed", { from: "daemon", to: "daemon2", error: "disk full" }, "node_update", ["from", "to", "error", "outcome"]],
  ["disk_low", { nodes: ["daemon"], freeBytes: 9e9, totalBytes: 5e11, level: "low", source: "host" }, "disk_low", ["nodes", "freeBytes", "totalBytes", "level", "source"]],
  ["node_no_peers", { node: "daemon2", network: "mainnet", topoheight: 9405331, peerlessSince: new Date(Date.now() - 5 * 60_000).toISOString() }, "node_no_peers", ["node", "network", "topoheight", "peerlessSince"]],
  ["node_peers_back", { node: "daemon2", network: "mainnet", topoheight: 9405400, peerlessSince: new Date(Date.now() - 6 * 60_000).toISOString() }, "node_peers_back", ["node", "network", "topoheight", "peerlessSince"]],
  ["cluster_active", { server: "main", vip: "192.168.1.250" }, "cluster_active", ["server", "vip"]],
  ["cluster_standby", { server: "main", vip: "192.168.1.250" }, "cluster_standby", ["server", "vip"]],
  ["cluster_fault", { server: "main", vip: "192.168.1.250" }, "cluster_fault", ["server", "vip"]],
];

/** A local webhook that collects what it receives. */
async function webhook() {
  /** @type {any[]} */
  const received = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (c) => { body += c; });
    request.on("end", () => { received.push(JSON.parse(body)); response.end("ok"); });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(undefined)));
  server.unref();
  return { url: `http://127.0.0.1:${/** @type {import("node:net").AddressInfo} */ (server.address()).port}/hook`, received, close: () => server.close() };
}

/** Recorded events by id, and the miner address behind a found block. @param {Record<string, unknown>} events */
function fakePool(events) {
  const pool = {
    query: async (/** @type {string} */ sql, /** @type {unknown[]} */ params = []) => {
      if (/FROM service_events WHERE id/.test(sql)) return events[String(params[0])] ? { rows: [{ payload: events[String(params[0])] }] } : { rows: [] };
      if (/FROM blocks b/.test(sql)) return { rows: [{ address: ADDRESS }] };
      return { rows: [] };
    },
  };
  return /** @type {import("pg").Pool} */ (/** @type {unknown} */ (pool));
}

/** @param {() => boolean} done */
async function until(done, ms = 3_000) {
  for (let waited = 0; waited < ms && !done(); waited += 20) await new Promise((r) => setTimeout(r, 20));
}

/** @param {Record<string, unknown>} body */
const fields = (body) => Object.keys(body).filter((k) => !["event", "text", "sentAt"].includes(k)).sort();

test("each alert's webhook body has its event, a text, its documented fields and the time it was sent", async () => {
  const hook = await webhook();
  const events = Object.fromEntries(CASES.map(([, payload], i) => [String(i + 1), payload]));
  // One sender per alert: each sends at most one message a second and drops a flood, so they would not all arrive from one.
  const senders = CASES.map(([type], i) => {
    const alerts = startAlerts({ pool: fakePool(events), config: alertConfigFromEnv({ ALERT_WEBHOOK_URL: hook.url }) /* every kind, the default */, logger: quiet });
    alerts?.handleNotification(JSON.stringify({ type: "event", id: String(i + 1), eventType: type }));
    return alerts;
  });
  await until(() => hook.received.length >= CASES.length);
  for (const alerts of senders) alerts?.stop();
  hook.close();
  assert.equal(hook.received.length, CASES.length, "one webhook call per alert");
  for (const [type, , event, expected] of CASES) {
    const body = hook.received.find((b) => b.event === event && JSON.stringify(fields(b)) === JSON.stringify([...expected].sort()));
    assert.ok(body, `${type} → ${event} with ${expected.join(", ")}; received: ${JSON.stringify(hook.received.filter((b) => b.event === event).map(fields))}`);
    assert.equal(typeof body.text, "string");
    assert.ok(!Number.isNaN(Date.parse(body.sentAt)), "sentAt is a time");
  }
  const outcomes = hook.received.filter((b) => b.event === "node_update").map((b) => b.outcome).sort();
  assert.deepEqual(outcomes, ["copy_failed", "done", "failed", "started"]);
  assert.equal(hook.received.find((b) => b.event === "block_found").address, ADDRESS);
});

/**
 * A worker that is mining at the first check, silent at the second and back from the third, and the days it usually mines then.
 * @param {number} daysOn
 */
function workerPool(daysOn) {
  let checks = 0;
  const pool = {
    query: async (/** @type {string} */ sql) => {
      if (/generate_series/.test(sql)) return { rows: [{ days_on: daysOn }] };
      // The offline check's query only (the rejected-share check reads the same table).
      if (/max\(s\.bucket\) AS last_share/.test(sql)) {
        checks++;
        const lastShare = new Date(checks === 2 ? Date.now() - 60 * 60_000 : Date.now());
        return { rows: [{ address: ADDRESS, id: 7, name: "rig1", last_share: lastShare }] };
      }
      return { rows: [] };
    },
  };
  return /** @type {import("pg").Pool} */ (/** @type {unknown} */ (pool));
}

test("a worker's alerts: offline, off at a time it usually mines, and back", async () => {
  const hook = await webhook();
  const alerts = startAlerts({ pool: workerPool(6), config: alertConfigFromEnv({ ALERT_WEBHOOK_URL: hook.url, ALERT_EVENTS: "worker_offline,worker_unusual" }),
    logger: quiet, workerCheckMs: 50 });
  await until(() => hook.received.length >= 3, 8_000);
  alerts?.stop();
  hook.close();
  assert.deepEqual(hook.received.map((b) => b.event), ["worker_offline", "worker_unusual", "worker_online"]);
  assert.deepEqual(fields(hook.received[0]), ["address", "lastShare", "worker"]);
  assert.deepEqual(fields(hook.received[1]), ["address", "days", "daysOn", "lastShare", "worker"]);
  assert.deepEqual(fields(hook.received[2]), ["address", "worker"]);
  assert.equal(hook.received[1].daysOn, 6);
  assert.equal(hook.received[1].days, 7);
  assert.match(hook.received[1].text, /rig1 .* at a time it was mining on 6 of the last 7 days/);
});

test("worker_unusual alone: quiet for a rig that is often off at this time, and its return is said only after an alert", async () => {
  for (const [daysOn, expected] of /** @type {[number, string[]][]} */ ([[4, []], [5, ["worker_unusual", "worker_online"]]])) {
    const hook = await webhook();
    const alerts = startAlerts({ pool: workerPool(daysOn), config: alertConfigFromEnv({ ALERT_WEBHOOK_URL: hook.url, ALERT_EVENTS: "worker_unusual" }),
      logger: quiet, workerCheckMs: 50 });
    await until(() => hook.received.length >= expected.length && expected.length > 0, expected.length ? 8_000 : 1_500);
    alerts?.stop();
    hook.close();
    assert.deepEqual(hook.received.map((b) => b.event), expected, `mining on ${daysOn} of 7 days`);
  }
});

/**
 * A worker's last 15 minutes at each check, in turn (accepted, rejected), then the last one again; and its reject reasons.
 * @param {[number, number][]} checks
 */
function rejectPool(checks) {
  let n = 0;
  const pool = {
    query: async (/** @type {string} */ sql) => {
      if (/FROM worker_rejects_1m/.test(sql)) return { rows: [{ reason: "stale", count: 25 }, { reason: "low_difficulty", count: 5 }] };
      if (/HAVING sum\(s\.accepted\)/.test(sql)) {
        const [accepted, rejected] = checks[Math.min(n++, checks.length - 1)];
        return { rows: [{ address: ADDRESS, id: 7, name: "rig1", accepted, rejected }] };
      }
      return { rows: [] };
    },
  };
  return /** @type {import("pg").Pool} */ (/** @type {unknown} */ (pool));
}

test("a worker's rejected shares: an alert with the reasons when there are many, and one when they are few again", async () => {
  const hook = await webhook();
  // Normal, then 30 of 130 rejected (23%), then 6 of 106 (5.7%, still above the 5% to clear), then 2 of 102.
  const alerts = startAlerts({ pool: rejectPool([[100, 1], [100, 30], [100, 6], [100, 2]]),
    config: alertConfigFromEnv({ ALERT_WEBHOOK_URL: hook.url, ALERT_EVENTS: "worker_rejects" }), logger: quiet, workerCheckMs: 50 });
  await until(() => hook.received.length >= 2, 8_000);
  alerts?.stop();
  hook.close();
  assert.deepEqual(hook.received.map((b) => b.event), ["worker_rejects", "worker_rejects_ok"]);
  assert.deepEqual(fields(hook.received[0]), ["accepted", "address", "minutes", "percent", "reasons", "rejected", "worker"]);
  assert.deepEqual(fields(hook.received[1]), ["accepted", "address", "minutes", "percent", "rejected", "worker"]);
  assert.equal(hook.received[0].percent, 23.1);
  assert.deepEqual(hook.received[0].reasons, { stale: 25, low_difficulty: 5 });
  assert.match(hook.received[0].text, /rig1 .* 30 of 130 shares rejected \(23\.1%\) in the last 15 minutes: 25 stale \(work for an old block\), 5 below the share difficulty/);
  assert.equal(hook.received[1].percent, 2);
});

test("a few rejected shares are not an alert: fewer than 20, or under 10%", async () => {
  const hook = await webhook();
  const alerts = startAlerts({ pool: rejectPool([[10, 0], [10, 15], [400, 30]]),
    config: alertConfigFromEnv({ ALERT_WEBHOOK_URL: hook.url, ALERT_EVENTS: "worker_rejects" }), logger: quiet, workerCheckMs: 50 });
  await until(() => false, 1_000);
  alerts?.stop();
  hook.close();
  assert.deepEqual(hook.received, [], "15 of 25 is 60% but only 15; 30 of 430 is 7%");
});

test("with a dashboard open, every kind is relayed for its browser to choose from; the channels still get only theirs", async () => {
  const hook = await webhook();
  /** @type {any[]} */
  const relayed = [];
  let open = true;
  const relay = { active: () => open, push: (/** @type {any} */ alert) => relayed.push(alert) };
  // The webhook wants worker_offline only; the dashboard gets worker_unusual too, and its own kind on each.
  const alerts = startAlerts({ pool: workerPool(6), config: alertConfigFromEnv({ ALERT_WEBHOOK_URL: hook.url, ALERT_EVENTS: "worker_offline" }),
    logger: quiet, workerCheckMs: 50, relay });
  await until(() => relayed.length >= 3 && hook.received.length >= 2, 8_000);
  alerts?.stop();
  hook.close();
  assert.deepEqual(relayed.map((a) => [a.event, a.kind]), [["worker_offline", "worker_offline"], ["worker_unusual", "worker_unusual"], ["worker_online", "worker_offline"]]);
  assert.ok(relayed.every((a) => typeof a.text === "string" && !Number.isNaN(Date.parse(a.sentAt))));
  assert.deepEqual(hook.received.map((b) => b.event), ["worker_offline", "worker_online"], "not worker_unusual: the webhook did not choose it");
  open = false;
});

test("with no channel, alerts still run for an open dashboard, and work out nothing while none is open", async () => {
  /** @type {any[]} */
  const relayed = [];
  let open = false;
  const pool = workerPool(6);
  let queries = 0;
  const counting = /** @type {any} */ ({ query: (/** @type {string} */ sql, /** @type {unknown[]} */ p) => { queries++; return pool.query(sql, p); } });
  const alerts = startAlerts({ pool: counting, config: alertConfigFromEnv({}), logger: quiet, workerCheckMs: 50,
    relay: { active: () => open, push: (/** @type {any} */ a) => relayed.push(a) } });
  assert.ok(alerts, "running for the relay");
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(queries, 0, "no dashboard open: no worker checks");
  open = true;
  await until(() => relayed.length >= 1, 8_000);
  alerts?.stop();
  assert.ok(relayed.length >= 1);
  assert.equal(startAlerts({ pool, config: alertConfigFromEnv({}), logger: quiet }), null, "no channel and no relay: nothing runs");
});

test("worker_unusual and worker_rejects are sent only when chosen: not part of the default of every kind", () => {
  assert.equal(alertConfigFromEnv({}).events.has("worker_unusual"), false);
  assert.equal(alertConfigFromEnv({}).events.has("worker_rejects"), false);
  assert.equal(alertConfigFromEnv({}).events.has("worker_offline"), true);
  assert.equal(alertConfigFromEnv({ ALERT_EVENTS: "worker_unusual" }).events.has("worker_unusual"), true);
});

test("a block that becomes final has its fields; several at once come as one alert with a list of them", async () => {
  const hook = await webhook();
  const final = (/** @type {number} */ height, /** @type {string} */ status) => ({ hash: HASH, height, topoheight: height + 3, status, reward: "146000000" });
  const events = { 1: final(100, "main-chain"), 2: final(101, "side"), 3: final(102, "orphaned"), 4: final(103, "main-chain") };
  const alerts = startAlerts({ pool: fakePool(events), config: alertConfigFromEnv({ ALERT_WEBHOOK_URL: hook.url, ALERT_EVENTS: "block_final" }), logger: quiet });
  alerts?.handleNotification(JSON.stringify({ type: "event", id: "1", eventType: "block_final" }));
  await until(() => hook.received.length >= 1, 8_000);
  for (const id of ["2", "3", "4"]) alerts?.handleNotification(JSON.stringify({ type: "event", id, eventType: "block_final" }));
  await until(() => hook.received.length >= 2, 8_000);
  alerts?.stop();
  hook.close();
  assert.deepEqual(fields(hook.received[0]), ["hash", "height", "reward", "status", "topoheight"]);
  assert.deepEqual(fields(hook.received[1]), ["blocks"]);
  assert.deepEqual(hook.received[1].blocks.map((/** @type {any} */ b) => b.status), ["side", "orphaned", "main-chain"]);
});
