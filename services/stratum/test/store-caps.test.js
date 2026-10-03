import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DurableStore } from "../src/store.js";

const check = (name, ok, extra = "") => assert.ok(ok, extra ? `${name} (${extra})` : name);
const down = () => { const e = new Error("connect ECONNREFUSED"); e.code = "ECONNREFUSED"; return e; };
test("the journal is capped by kind so a flood cannot fill the disk", async () => {
const calls = [];
const db = {
  ensureWorker: async () => { throw down(); }, recordShare: async () => { throw down(); }, recordBlock: async () => { throw down(); },
  recordServiceEvent: async () => { throw down(); }, recordBan: async () => { throw down(); }, recordReportedHashrate: async () => { throw down(); },
};
const dir = await mkdtemp(join(tmpdir(), "cap-"));
const store = new DurableStore({ pool: { query: async () => { throw down(); } }, dir, db, logger: { info() {}, warn() {} }, probeMs: 60_000, maxBytes: 1000 });
await store.init();
for (let i = 0; i < 40; i++) await store.recordShare({ workerId: 1n, jobId: "j", nonce: `n${i}`, difficulty: "1", accepted: true }, { address: "a", name: "w" });
const afterShares = (await stat(join(dir, "journal.jsonl"))).size;
check("shares stop at the limit", afterShares <= 1000, `size=${afterShares}`);
for (let i = 0; i < 400; i++) await store.recordServiceEvent("login_problem", { reason: "invalid_address", address: "x".repeat(20), i });
const afterEvents = (await stat(join(dir, "journal.jsonl"))).size;
check("a flood of events stops at twice the limit, not at the disk", afterEvents <= 2000 && afterEvents > afterShares, `size=${afterEvents}`);
const blockBefore = store.status().pending;
for (let i = 0; i < 3; i++) await store.recordBlock({ hash: String(i).repeat(64).slice(0, 64), height: i, status: "submitted", foundAt: new Date() }, { address: "a", name: "w" });
const afterBlocks = (await stat(join(dir, "journal.jsonl"))).size;
check("blocks are still kept when everything else is full", store.status().pending === blockBefore + 3 && afterBlocks > 2000, `pending +${store.status().pending - blockBefore}`);
await store.stop();
await rm(dir, { recursive: true, force: true });
});
