import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DurableStore } from "../src/store.js";

const check = (name, ok, extra = "") => assert.ok(ok, extra ? `${name} (${extra})` : name);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const quiet = { info() {}, warn() {} };
async function waitFor(fn, ms = 6000) { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await sleep(30); } return false; }

// A stand-in for the main server's ingest endpoint: applies each record once (by sequence number).
function fakeMain() {
  const m = { up: true, loseReply: false, lastSeq: 0, applied: [], batches: 0, secret: "s".repeat(20) };
  m.fetch = async (url, init = {}) => {
    if (!m.up) throw new Error("connect ECONNREFUSED");
    const auth = init.headers?.["x-cluster-secret"];
    if (auth !== m.secret) return new Response("{}", { status: 401 });
    if (url.endsWith("/ping")) return new Response('{"ok":true}', { status: 200 });
    const body = JSON.parse(init.body);
    m.batches += 1;
    for (const r of body.records) { if (r.s > m.lastSeq) { m.applied.push(r); m.lastSeq = r.s; } }
    if (m.loseReply) { m.loseReply = false; throw new Error("socket hang up"); }
    return new Response(JSON.stringify({ applied: body.records.length }), { status: 200 });
  };
  return m;
}

test("a standby sends its records to the main server, once, in order, and survives outages", async () => {
const dir = await mkdtemp(join(tmpdir(), "remote-"));
const main = fakeMain();
const store = new DurableStore({ pool: null, dir, logger: quiet, probeMs: 50, remote: { url: "http://main", secret: main.secret, instance: "standby-a", batch: 3, flushMs: 20, fetch: main.fetch } });
await store.init();

// 1. a standby never asks a database; a login gets a provisional worker; records reach the main server
const who = await store.ensureWorker({ address: "xel:a", name: "rig", ip: "10.0.0.2" });
check("standby login does not need a database (provisional identity)", who.workerId === null && who.minerId === null);
for (let i = 0; i < 7; i++) await store.recordShare({ workerId: null, jobId: "j", nonce: `n${i}`, difficulty: "10", accepted: true }, { address: "xel:a", name: "rig" });
await store.recordServiceEvent("block_submitted", { height: 5 });
check("records reach the main server", await waitFor(() => main.applied.length === 9 && store.status().pending === 0), `applied=${main.applied.length}`);
check("in batches (3 per batch)", main.batches >= 3, `batches=${main.batches}`);
check("with increasing sequence numbers", main.applied.every((r, i) => i === 0 || r.s > main.applied[i - 1].s));
check("keyed by worker address and name, not by database id", main.applied.filter((r) => r.t === "share").every((r) => r.key.address === "xel:a" && r.key.name === "rig"));
check("the journal is cleared once sent", await waitFor(async () => stat(join(dir, "journal.jsonl")).then(() => false, () => true)));

// 2. the main server goes down
main.up = false;
for (let i = 0; i < 5; i++) await store.recordShare({ workerId: null, jobId: "j2", nonce: `m${i}`, difficulty: "10", accepted: true }, { address: "xel:a", name: "rig" });
await store.recordServiceEvent("block_submitted", { height: 6 });
await sleep(300);
check("while it is down the journal keeps everything", store.status().pending === 6 && !store.status().online, `pending=${store.status().pending}`);
// 3. and returns, but loses the reply of the first batch (so that batch is sent twice)
main.up = true;
main.loseReply = true;
check("the standby catches up by itself", await waitFor(() => store.status().pending === 0 && main.lastSeq > 0 && main.applied.length === 15), `applied=${main.applied.length}`);
check("a batch sent twice (lost reply) is not counted twice", new Set(main.applied.map((r) => r.s)).size === main.applied.length);
check("a standby restarted with a leftover journal sends it", await (async () => {
  main.up = false;
  await store.recordServiceEvent("node_unreachable", {});
  await store.stop();
  const again = new DurableStore({ pool: null, dir, logger: quiet, probeMs: 50, remote: { url: "http://main", secret: main.secret, instance: "standby-a", batch: 3, flushMs: 20, fetch: main.fetch } });
  await again.init();
  main.up = true;
  const ok = await waitFor(() => main.applied.some((r) => r.type === "node_unreachable"));
  await again.stop();
  return ok;
})());

// 4. a wrong secret never sends and never drops data
const dir2 = await mkdtemp(join(tmpdir(), "remote-"));
const bad = new DurableStore({ pool: null, dir: dir2, logger: quiet, probeMs: 50, remote: { url: "http://main", secret: "wrong-secret-wrong-secret", instance: "x", flushMs: 20, fetch: main.fetch } });
await bad.init();
const before = main.applied.length;
await bad.recordServiceEvent("e", {});
await sleep(400);
check("a wrong cluster secret sends nothing, and keeps the record", main.applied.length === before && bad.status().pending === 1);
await bad.stop();

for (const d of [dir, dir2]) await rm(d, { recursive: true, force: true });
});
