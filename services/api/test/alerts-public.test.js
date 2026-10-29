// Alerts on a public server: cluster alerts leave out the shared address (text and webhook data), and there are no alerts about
// individual workers (they are other people's rigs). The same alerts on a normal server keep both.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { alertConfigFromEnv, startAlerts } from "../src/alerts.js";

const VIP = "192.168.1.250/24";
const quiet = { info() {}, warn() {} };

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

/** Events by id, and a count of how often the worker-offline check asked the database. */
function fakePool(events) {
  const counts = { workerQueries: 0 };
  const pool = {
    query: async (/** @type {string} */ sql, /** @type {unknown[]} */ params = []) => {
      if (/FROM service_events WHERE id/.test(sql)) return { rows: events[String(params[0])] ? [{ payload: events[String(params[0])] }] : [] };
      if (/FROM worker_stats_1m/.test(sql)) {
        counts.workerQueries++;
        return { rows: [{ address: "xel:abc", name: "rig1", last_share: new Date(0) }] };
      }
      return { rows: [] };
    },
  };
  return { pool: /** @type {import("pg").Pool} */ (/** @type {unknown} */ (pool)), counts };
}

/** @param {() => boolean} done */
async function until(done) {
  for (let i = 0; i < 100 && !done(); i++) await new Promise((r) => setTimeout(r, 20));
}

for (const publicMode of [true, false]) {
  test(`${publicMode ? "a public" : "a normal"} server's cluster alert ${publicMode ? "leaves out" : "names"} the shared address`, async () => {
    const hook = await webhook();
    const { pool } = fakePool({ 1: { server: "main-1", vip: VIP }, 2: { server: "main-1", vip: VIP } });
    const config = alertConfigFromEnv({ ALERT_WEBHOOK_URL: hook.url, ALERT_EVENTS: "cluster", XELDASH_PUBLIC_MODE: String(publicMode) });
    assert.equal(config.publicMode, publicMode);
    const alerts = startAlerts({ pool, config, logger: quiet });
    alerts?.handleNotification(JSON.stringify({ type: "event", id: "1", eventType: "cluster_active" }));
    alerts?.handleNotification(JSON.stringify({ type: "event", id: "2", eventType: "cluster_fault" }));
    await until(() => hook.received.length >= 2);
    alerts?.stop();
    hook.close();
    assert.equal(hook.received.length, 2);
    for (const body of hook.received) {
      const text = JSON.stringify(body);
      if (publicMode) {
        assert.doesNotMatch(text, /192\.168\.1\.250/, "neither the text nor the webhook data has the address");
        assert.equal(body.vip, undefined);
        assert.match(body.text, /the shared address/);
        assert.equal(body.server, "main-1", "the rest of the data is kept");
      } else {
        assert.match(body.text, /192\.168\.1\.250/);
        assert.equal(body.vip, VIP);
      }
    }
  });
}

test("a public server sends no alerts about individual workers, even when they are selected", async () => {
  const hook = await webhook();
  for (const kind of ["worker_offline", "worker_unusual", "worker_rejects"]) {
    for (const publicMode of [true, false]) {
      const { pool, counts } = fakePool({});
      const config = alertConfigFromEnv({ ALERT_WEBHOOK_URL: hook.url, ALERT_EVENTS: kind, XELDASH_PUBLIC_MODE: String(publicMode) });
      const alerts = startAlerts({ pool, config, logger: quiet });
      await until(() => counts.workerQueries > 0);
      await new Promise((r) => setTimeout(r, 50));
      alerts?.stop();
      assert.equal(counts.workerQueries > 0, !publicMode, `${kind}: ${publicMode ? "the worker check does not even run" : "the worker check runs"}`);
    }
  }
  hook.close();
});
