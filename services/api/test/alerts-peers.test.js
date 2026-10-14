// A node that loses its peers, and finds them again, becomes an alert when `node_peers` is selected, and nothing otherwise.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { alertConfigFromEnv, startAlerts } from "../src/alerts.js";

const quiet = { info() {}, warn() {} };

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

/** @param {Record<string, unknown>} events */
function fakePool(events) {
  const pool = {
    query: async (/** @type {string} */ sql, /** @type {unknown[]} */ params = []) =>
      /FROM service_events WHERE id/.test(sql) && events[String(params[0])] ? { rows: [{ payload: events[String(params[0])] }] } : { rows: [] },
  };
  return /** @type {import("pg").Pool} */ (/** @type {unknown} */ (pool));
}

/** @param {() => boolean} done */
async function until(done) {
  for (let i = 0; i < 100 && !done(); i++) await new Promise((r) => setTimeout(r, 20));
}

const events = {
  1: { node: "daemon2", network: "mainnet", topoheight: 9405331, peerlessSince: new Date(Date.now() - 5 * 60_000).toISOString() },
  2: { node: "daemon2", network: "mainnet", topoheight: 9405400, peerlessSince: new Date(Date.now() - 6 * 60_000).toISOString() },
};

test("a node without peers, and with them again, is announced when node_peers is selected", async () => {
  const hook = await webhook();
  const alerts = startAlerts({ pool: fakePool(events), config: alertConfigFromEnv({ ALERT_WEBHOOK_URL: hook.url, ALERT_EVENTS: "node_peers" }), logger: quiet });
  alerts?.handleNotification(JSON.stringify({ type: "event", id: "1", eventType: "node_no_peers" }));
  alerts?.handleNotification(JSON.stringify({ type: "event", id: "2", eventType: "node_peers_back" }));
  await until(() => hook.received.length >= 2);
  alerts?.stop();
  hook.close();
  assert.deepEqual(hook.received.map((b) => b.event), ["node_no_peers", "node_peers_back"]);
  assert.match(hook.received[0].text, /Node daemon2 has had no peers for 5 minutes/);
  assert.match(hook.received[0].text, /P2P port \(2125\)/);
  assert.match(hook.received[1].text, /daemon2 is connected to other nodes again/);
});

test("without node_peers selected, nothing is sent", async () => {
  const hook = await webhook();
  const alerts = startAlerts({ pool: fakePool(events), config: alertConfigFromEnv({ ALERT_WEBHOOK_URL: hook.url, ALERT_EVENTS: "block_found" }), logger: quiet });
  alerts?.handleNotification(JSON.stringify({ type: "event", id: "1", eventType: "node_no_peers" }));
  await new Promise((r) => setTimeout(r, 200));
  alerts?.stop();
  hook.close();
  assert.equal(hook.received.length, 0);
});
