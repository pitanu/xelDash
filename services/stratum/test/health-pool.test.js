import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { createWorkerAuthorizer } from "../src/authorize-worker.js";
import { startHealthServer } from "../src/health.js";
import { nodeLabel, rpcUrlsFromEnv } from "../src/node-pool.js";

const quiet = { info() {}, warn() {} };

async function freePort() {
  const probe = createServer();
  await new Promise((r) => probe.listen(0, "127.0.0.1", r));
  const { port } = probe.address();
  await new Promise((r) => probe.close(r));
  return port;
}

async function health(check, status) {
  const port = await freePort();
  const server = startHealthServer({ port, host: "127.0.0.1", check, status, logger: quiet });
  await new Promise((r) => setTimeout(r, 80));
  return { url: `http://127.0.0.1:${port}`, close: () => server.close() };
}

test("/healthz is 200 while this server can mine and 503 with the reason while it cannot", async () => {
  let reason = null;
  const h = await health(async () => reason);
  let r = await fetch(`${h.url}/healthz`);
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true });
  reason = "no node is ready";
  r = await fetch(`${h.url}/healthz`);
  assert.equal(r.status, 503);
  assert.deepEqual(await r.json(), { ok: false, reason: "no node is ready" });
  await h.close();
});

test("a health check that throws is a failure, not a crash", async () => {
  const h = await health(async () => { throw new Error("boom"); });
  const r = await fetch(`${h.url}/healthz`);
  assert.equal(r.status, 503);
  assert.equal((await r.json()).reason, "boom");
  assert.equal((await fetch(`${h.url}/healthz`)).status, 503, "and the server is still up");
  await h.close();
});

test("/status adds what the offline page and the dashboard show, and other paths are 404", async () => {
  const h = await health(async () => null, () => ({ rigs: 3, mode: "main", frontDoor: null }));
  const body = await (await fetch(`${h.url}/status`)).json();
  assert.deepEqual(body, { ok: true, reason: null, rigs: 3, mode: "main", frontDoor: null });
  assert.equal((await fetch(`${h.url}/nothing`)).status, 404);
  assert.equal((await fetch(`${h.url}/healthz`, { method: "POST" })).status, 404);
  await h.close();
});

test("node addresses: from XELIS_RPC_URLS or XELIS_RPC_URL, in order, never a duplicate or a strange scheme", () => {
  assert.deepEqual(rpcUrlsFromEnv({}), ["http://daemon:8080/json_rpc"]);
  assert.deepEqual(rpcUrlsFromEnv({ XELIS_RPC_URL: "http://a:8080/json_rpc" }), ["http://a:8080/json_rpc"]);
  assert.deepEqual(rpcUrlsFromEnv({ XELIS_RPC_URLS: "http://a:8080/json_rpc, http://b:8080/json_rpc", XELIS_RPC_URL: "http://z/" }), ["http://a:8080/json_rpc", "http://b:8080/json_rpc"]);
  assert.throws(() => rpcUrlsFromEnv({ XELIS_RPC_URLS: "http://a/x,http://a/x" }), /twice/);
  assert.throws(() => rpcUrlsFromEnv({ XELIS_RPC_URLS: "ftp://a/x" }), /http/);
  assert.throws(() => rpcUrlsFromEnv({ XELIS_RPC_URLS: "not a url" }));
  assert.equal(nodeLabel("http://daemon:8080/json_rpc"), "daemon");
  assert.equal(nodeLabel("http://10.0.0.2:9090/json_rpc"), "10.0.0.2:9090");
});

test("a login: the node checks the address, the store finds the worker, no id yet means provisional", async () => {
  const calls = [];
  const daemon = { getMiningIdentity: async (address) => (address === "bad" ? null : { publicKey: "ab".repeat(32) }) };
  const store = { ensureWorker: async (w) => { calls.push(w); return w.name === "new" ? { minerId: null, workerId: null } : { minerId: 1n, workerId: 2n }; } };
  const authorize = createWorkerAuthorizer({ daemon, store });
  assert.equal(await authorize({ address: "bad", workerName: "w" }), null);
  assert.equal(calls.length, 0, "an address the node refuses never reaches the store");
  const known = await authorize({ address: "xet:a", workerName: "rig", ip: "10.0.0.5" });
  assert.deepEqual([known.workerId, known.provisional, known.publicKey], [2n, false, "ab".repeat(32)]);
  assert.deepEqual(calls[0], { address: "xet:a", name: "rig", ip: "10.0.0.5" });
  assert.equal((await authorize({ address: "xet:a", workerName: "new" })).provisional, true);
});
