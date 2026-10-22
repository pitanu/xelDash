// Stratum's Prometheus metrics: the text format, totals that never name a miner unless per-worker metrics are chosen (and never in
// public mode), the token, and the refusal of a public server's metrics port opened beyond this computer without one.
import test from "node:test";
import assert from "node:assert/strict";
import { Metrics, isLoopback, metricsConfigFromEnv, noMetrics, startMetricsServer } from "../src/metrics.js";

const quiet = { info() {}, warn() {} };
const ADDRESS = "xel:5fuu8nkxq6cz3jn8ph3zfwn3hyn4wf8jzcdvsw509t2dxtg4vuaqq3vv9hy";

/** A metrics registry with a few of each kind, as Stratum fills it. */
function sample() {
  const metrics = new Metrics();
  const shares = metrics.counter("xeldash_shares_total", "Shares by result.");
  const perWorker = metrics.counter("xeldash_worker_shares_total", "Shares by worker.", { perWorker: true });
  const seconds = metrics.histogram("xeldash_share_seconds", "Time per share.", [0.01, 0.1, 1]);
  shares.inc({ result: "accepted" }, 3);
  shares.inc({ result: "stale" });
  perWorker.inc({ address: ADDRESS, worker: "rig \"1\"\n", result: "accepted" });
  for (const value of [0.005, 0.05, 0.5, 5]) seconds.observe(value);
  metrics.collect(() => [{ name: "xeldash_connections", help: "Connections.", type: "gauge", samples: [{ value: 7 }] },
    { name: "xeldash_node_peers", help: "Peers.", type: "gauge", samples: [{ labels: { node: "daemon" }, value: 8 }] }]);
  return metrics;
}

test("the text format: counters by label, a cumulative histogram, and values read when asked", () => {
  const text = sample().render();
  assert.match(text, /# TYPE xeldash_shares_total counter\nxeldash_shares_total\{result="accepted"\} 3\nxeldash_shares_total\{result="stale"\} 1\n/);
  assert.match(text, /xeldash_share_seconds_bucket\{le="0.01"\} 1\nxeldash_share_seconds_bucket\{le="0.1"\} 2\nxeldash_share_seconds_bucket\{le="1"\} 3\n/);
  assert.match(text, /xeldash_share_seconds_bucket\{le="\+Inf"\} 4\nxeldash_share_seconds_sum 5.555\nxeldash_share_seconds_count 4\n/);
  assert.match(text, /# TYPE xeldash_connections gauge\nxeldash_connections 7\n/);
  assert.match(text, /xeldash_node_peers\{node="daemon"\} 8\n/);
  assert.ok(text.endsWith("\n"));
});

test("no miner is named unless per-worker metrics are asked for, and then labels are escaped", () => {
  const metrics = sample();
  const totals = metrics.render();
  assert.doesNotMatch(totals, /xel:|rig|xeldash_worker_shares_total/, "totals only");
  const perWorker = metrics.render({ perWorker: true });
  assert.ok(perWorker.includes(`xeldash_worker_shares_total{address="${ADDRESS}",worker="rig \\"1\\"\\n",result="accepted"} 1`));
});

test("a family stops at its series limit, so made-up worker names cannot grow it without end", () => {
  const metrics = new Metrics();
  const perWorker = metrics.counter("xeldash_worker_shares_total", "Shares by worker.", { perWorker: true, maxSeries: 3 });
  for (let i = 0; i < 10; i++) perWorker.inc({ worker: `w${i}` });
  perWorker.inc({ worker: "w0" });
  const lines = metrics.render({ perWorker: true }).split("\n").filter((l) => l.startsWith("xeldash_worker_shares_total{"));
  assert.deepEqual(lines, ['xeldash_worker_shares_total{worker="w0"} 2', 'xeldash_worker_shares_total{worker="w1"} 1', 'xeldash_worker_shares_total{worker="w2"} 1']);
});

test("off means no-op recorders", () => {
  assert.equal(noMetrics.enabled, false);
  noMetrics.counter("x", "y").inc({ a: "b" });
  noMetrics.histogram("x", "y", [1]).observe(1);
});

test("settings: off by default, on with the metrics profile or XELDASH_METRICS, loopback unless told otherwise", () => {
  assert.equal(metricsConfigFromEnv({}).enabled, false);
  assert.equal(metricsConfigFromEnv({ COMPOSE_PROFILES: "redundant, metrics" }).enabled, true);
  assert.equal(metricsConfigFromEnv({ COMPOSE_PROFILES: "redundant" }).enabled, false);
  assert.equal(metricsConfigFromEnv({ XELDASH_METRICS: "on" }).enabled, true);
  const local = metricsConfigFromEnv({ XELDASH_METRICS: "on" });
  assert.deepEqual([local.bindIp, local.exposed, local.port, local.perWorker], ["127.0.0.1", false, 9464, false]);
  assert.equal(metricsConfigFromEnv({ XELDASH_METRICS_BIND_IP: "0.0.0.0" }).exposed, true);
  assert.throws(() => metricsConfigFromEnv({ XELDASH_METRICS_TOKEN: "short" }), /at least 16/);
  for (const ip of ["127.0.0.1", "127.1.2.3", "::1", "localhost"]) assert.ok(isLoopback(ip), ip);
  for (const ip of ["0.0.0.0", "192.168.1.10", "::"]) assert.ok(!isLoopback(ip), ip);
});

test("the listener: /metrics only, the token when one is set, and public mode never names a miner", async () => {
  const base = metricsConfigFromEnv({ XELDASH_METRICS: "on" });
  const state = { pub: false };
  // Port 0: the system picks a free port, and the server says which once it listens.
  const config = { ...base, port: 0, perWorker: true, token: "a-token-of-twenty-chars" };
  const server = startMetricsServer({ metrics: sample(), config, isPublic: () => state.pub, host: "127.0.0.1", logger: quiet });
  const port = await server.listening;
  const get = (/** @type {string} */ path, /** @type {Record<string, string>} */ headers = {}) => fetch(`http://127.0.0.1:${port}${path}`, { headers });
  try {
    assert.equal((await get("/other")).status, 404);
    assert.equal((await get("/metrics")).status, 401, "no token");
    assert.equal((await get("/metrics", { authorization: "Bearer wrong-token-of-twenty" })).status, 401);
    const auth = { authorization: "Bearer a-token-of-twenty-chars" };
    const lan = await get("/metrics", auth);
    assert.equal(lan.status, 200);
    assert.match(lan.headers.get("content-type") ?? "", /text\/plain; version=0.0.4/);
    assert.ok((await lan.text()).includes(ADDRESS), "per-worker metrics were chosen, on a home server");
    state.pub = true;
    const pub = await (await get("/metrics", auth)).text();
    assert.ok(!pub.includes(ADDRESS) && !pub.includes("xeldash_worker_"), "public mode: never a miner, whatever is set");
    assert.match(pub, /xeldash_shares_total/);
  } finally {
    await server.close();
  }
});

test("public mode refuses a metrics port opened beyond this computer without a token, and serves it with one", async () => {
  const warnings = /** @type {string[]} */ ([]);
  const state = { pub: true };
  const config = { ...metricsConfigFromEnv({ XELDASH_METRICS: "on", XELDASH_METRICS_BIND_IP: "0.0.0.0" }), port: 0 };
  const server = startMetricsServer({ metrics: sample(), config, isPublic: () => state.pub, host: "127.0.0.1", logger: { info() {}, warn: (m) => warnings.push(m) } });
  const port = await server.listening;
  try {
    const refused = await fetch(`http://127.0.0.1:${port}/metrics`);
    assert.equal(refused.status, 503);
    assert.match(warnings[0] ?? "", /XELDASH_METRICS_TOKEN/);
    state.pub = false;
    assert.equal((await fetch(`http://127.0.0.1:${port}/metrics`)).status, 200, "a home server's LAN port is the operator's choice");
  } finally {
    await server.close();
  }
});
