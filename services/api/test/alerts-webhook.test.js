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
