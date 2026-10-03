import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { DurableStore, isConnectionError } from "../src/store.js";

const check = (name, ok, extra = "") => assert.ok(ok, extra ? `${name} (${extra})` : name);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const quiet = { info() {}, warn() {} };

function fakeDb() {
  const state = { up: true, workers: new Map(), nextId: 1, calls: [] };
  const down = () => { const e = new Error("connect ECONNREFUSED 127.0.0.1:5432"); e.code = "ECONNREFUSED"; return e; };
  const api = {
    state,
    async ensureWorker(_pool, { address, name, ip }) {
      if (!state.up) throw down();
      const key = `${address}/${name}`;
      if (!state.workers.has(key)) state.workers.set(key, { minerId: 1n, workerId: BigInt(state.nextId++) });
      state.calls.push(["worker", key, ip ?? null]);
      return state.workers.get(key);
    },
    async recordShare(_pool, s) {
      if (!state.up) throw down();
      if (s.workerId === null) throw new TypeError("no id");
      state.calls.push(["share", String(s.workerId), s.nonce, s.createdAt ?? null, s.accepted]);
      return { recorded: true, duplicate: false, accepted: s.accepted };
    },
    async recordBlock(_pool, b) { if (!state.up) throw down(); state.calls.push(["block", b.hash, b.workerId === null ? null : String(b.workerId), b.foundAt?.toISOString?.() ?? null]); },
    async recordServiceEvent(_pool, type, payload, at) { if (!state.up) throw down(); state.calls.push(["event", type, at ? new Date(at).toISOString() : null]); },
    async recordBan(_pool, ban) { if (!state.up) throw down(); state.calls.push(["ban", ban.ip]); },
    async recordReportedHashrate() { if (!state.up) throw down(); },
  };
  return api;
}
const pool = (db) => ({ query: async () => { if (!db.state.up) { const e = new Error("connect ECONNREFUSED"); e.code = "ECONNREFUSED"; throw e; } return { rows: [] }; } });
async function waitFor(fn, ms = 5000) { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await sleep(50); } return false; }

test("connection errors are told apart from rejected statements", () => {
// ---- error classification
check("connection errors recognised", isConnectionError({ code: "ECONNREFUSED" }) && isConnectionError({ code: "57P01" }) && isConnectionError(new Error("Connection terminated unexpectedly")) && isConnectionError({ errors: [{ code: "ENOTFOUND" }] }));
check("other errors are not", !isConnectionError({ code: "23505" }) && !isConnectionError(new TypeError("bad")) && !isConnectionError(null));

});

test("online, outage and recovery: nothing is lost and order is kept", async () => {
const dir = await mkdtemp(join(tmpdir(), "journal-"));
const db = fakeDb();
const store = new DurableStore({ pool: pool(db), dir, db, logger: quiet, probeMs: 100 });
await store.init();

// ---- 1. online: straight to the database
const known = await store.ensureWorker({ address: "xel:a", name: "rig1", ip: "10.0.0.5" });
await store.recordShare({ workerId: known.workerId, jobId: "j1", nonce: "n1", difficulty: "1000", accepted: true }, { address: "xel:a", name: "rig1" });
check("online writes go to the database", db.state.calls.length === 2 && store.status().pending === 0);

// ---- 2. outage
db.state.up = false;
const again = await store.ensureWorker({ address: "xel:a", name: "rig1", ip: "10.0.0.5" });
check("a known worker logs in from the cache", String(again.workerId) === String(known.workerId));
const fresh = await store.ensureWorker({ address: "xel:b", name: "new-rig", ip: "10.0.0.9" });
check("an unknown worker gets a provisional identity", fresh.workerId === null && fresh.minerId === null);
const t0 = Date.now();
const r1 = await store.recordShare({ workerId: known.workerId, jobId: "j1", nonce: "n2", difficulty: "1000", accepted: true }, { address: "xel:a", name: "rig1" });
const r2 = await store.recordShare({ workerId: null, jobId: "j1", nonce: "n3", difficulty: "1000", accepted: true }, { address: "xel:b", name: "new-rig" });
const dup = await store.recordShare({ workerId: known.workerId, jobId: "j1", nonce: "n2", difficulty: "1000", accepted: true }, { address: "xel:a", name: "rig1" });
check("writes during the outage are instant (no waiting for the database)", Date.now() - t0 < 500);
check("shares are journaled", r1.journaled && r2.journaled);
check("a repeated share is caught while journaling", dup.duplicate === true);
const blockAt = new Date(Date.now() - 1234);
await store.recordBlock({ hash: "ab".repeat(32), height: 10, minerId: null, workerId: null, status: "submitted", foundAt: blockAt }, { address: "xel:b", name: "new-rig" });
await store.recordServiceEvent("block_submitted", { height: 10 });
await store.recordBan({ ip: "1.2.3.4", reason: "test", until: new Date(Date.now() + 60000) });
check("blocks, events and bans are journaled", store.status().pending >= 6, `pending=${store.status().pending}`);
check("the store reports it is offline", store.status().online === false);

// ---- 3. recovery
db.state.up = true;
check("the journal drains by itself when the database is back", await waitFor(() => store.status().online && store.status().pending === 0));
const calls = db.state.calls;
const shareCalls = calls.filter((c) => c[0] === "share");
check("every journaled share was recorded (2 of 2, not the duplicate)", shareCalls.filter((c) => ["n2", "n3"].includes(c[2])).length === 2);
const n3 = shareCalls.find((c) => c[2] === "n3");
check("the provisional worker was created and its share recorded under the real id", n3 && n3[1] === String(db.state.workers.get("xel:b/new-rig").workerId));
check("shares keep their original time", shareCalls.every((c) => c[3] === null || !Number.isNaN(Date.parse(c[3]))) && shareCalls.find((c) => c[2] === "n2")[3] !== null);
const blk = calls.find((c) => c[0] === "block");
check("the block was recorded with its worker and original find time", blk && blk[2] === String(db.state.workers.get("xel:b/new-rig").workerId) && blk[3] === blockAt.toISOString());
check("the event and the ban were recorded", calls.some((c) => c[0] === "event" && c[1] === "block_submitted" && c[2]) && calls.some((c) => c[0] === "ban"));
const order = calls.map((c) => c[0] + ":" + (c[2] ?? c[1])).join(" ");
check("records were applied in the order they happened", order.indexOf("share:n2") < order.indexOf("block"), "");
check("the journal files are gone", await stat(join(dir, "journal.jsonl")).then(() => false, () => true));
await store.recordShare({ workerId: known.workerId, jobId: "j2", nonce: "n9", difficulty: "1000", accepted: true }, { address: "xel:a", name: "rig1" });
check("direct writes resume", db.state.calls.at(-1)[2] === "n9");
check("the known workers are saved for the next start", await waitFor(async () => { await store.stop(); return (await readFile(join(dir, "workers.json"), "utf8")).includes("xel:a"); }));

  await rm(dir, { recursive: true, force: true });
});

test("a restart finds the journal the last process left", async () => {
// ---- 4. a restart with a journal left behind
const dir2 = await mkdtemp(join(tmpdir(), "journal-"));
const db2 = fakeDb();
db2.state.up = false;
const s1 = new DurableStore({ pool: pool(db2), dir: dir2, db: db2, logger: quiet, probeMs: 100 });
await s1.init();
await s1.ensureWorker({ address: "xel:c", name: "w", ip: null });
await s1.recordShare({ workerId: null, jobId: "j", nonce: "k1", difficulty: "5", accepted: true }, { address: "xel:c", name: "w" });
await s1.recordServiceEvent("node_unreachable", {});
const pendingBefore = s1.status().pending;
await s1.stop(); // the process ends here, with the journal on disk
const s2 = new DurableStore({ pool: pool(db2), dir: dir2, db: db2, logger: quiet, probeMs: 100 });
await s2.init();
check("a new process finds the records the last one left", s2.status().pending === pendingBefore && !s2.status().online, `pending=${s2.status().pending}`);
db2.state.up = true;
check("and records them when the database answers", await waitFor(() => s2.status().online && s2.status().pending === 0));
check("including the worker that never had an id", db2.state.workers.has("xel:c/w") && db2.state.calls.some((c) => c[0] === "share" && c[2] === "k1"));
await s2.stop();

  await rm(dir2, { recursive: true, force: true });
});

test("the size limit never drops blocks or events", async () => {
// ---- 5. the size limit never drops blocks or events
const dir3 = await mkdtemp(join(tmpdir(), "journal-"));
const db3 = fakeDb();
db3.state.up = false;
const s3 = new DurableStore({ pool: pool(db3), dir: dir3, db: db3, logger: quiet, probeMs: 100, maxBytes: 600 });
await s3.init();
for (let i = 0; i < 20; i++) await s3.recordShare({ workerId: 1n, jobId: "j", nonce: `x${i}`, difficulty: "1", accepted: true }, { address: "xel:d", name: "w" });
await s3.recordBlock({ hash: "cd".repeat(32), height: 1, status: "submitted", foundAt: new Date() }, { address: "xel:d", name: "w" });
await s3.recordServiceEvent("block_submitted", {});
check("shares past the limit are dropped", s3.status().dropped > 0, `dropped=${s3.status().dropped}`);
db3.state.up = true;
await waitFor(() => s3.status().online && s3.status().pending === 0);
check("but the block and the event are kept", db3.state.calls.some((c) => c[0] === "block") && db3.state.calls.some((c) => c[0] === "event"));
await s3.stop();

  await rm(dir3, { recursive: true, force: true });
});

test("a refused statement is not an outage", async () => {
// ---- 6. a refused statement is not an outage
const db4 = fakeDb();
db4.recordShare = async () => { const e = new Error("duplicate key"); e.code = "23505"; throw e; };
const s4 = new DurableStore({ pool: pool(db4), dir: null, db: db4, logger: quiet });
let rethrown = false;
await s4.recordShare({ workerId: 1n, jobId: "j", nonce: "n", difficulty: "1", accepted: true }, { address: "a", name: "b" }).catch(() => { rethrown = true; });
check("a rejected statement is raised, not journaled", rethrown && s4.status().online);

});
