import test from "node:test";
import assert from "node:assert/strict";
import { applyJournalRecord, applyJournalRecords, ensureWorker, journalRecordProblem, recordBlock, recordShare, recordServiceEvent } from "../src/index.js";

const NOW = Date.parse("2026-10-03T12:00:00Z");
const at = "2026-10-03T11:59:00.000Z";
const key = { address: "xet:" + "a".repeat(40), name: "rig1" };

const share = (over = {}) => ({ t: "share", s: 1000, at, key, jobId: "j1", nonce: "n1", difficulty: "1000", accepted: true, ...over });
const block = (over = {}) => ({ t: "block", s: 1000, at, hash: "ab".repeat(32), status: "submitted", foundAt: at, key, ...over });

test("good records of every kind are accepted", () => {
  for (const r of [
    { t: "worker", s: 1, at, address: key.address, name: "rig", ip: "10.0.0.5" },
    { t: "worker", s: 1, at, address: key.address, name: "rig", ip: null },
    share(), share({ accepted: false, rejectReason: "stale" }), share({ difficulty: "12.5", networkDifficulty: "300" }),
    block(), block({ key: null }),
    { t: "event", s: 1, at, type: "block_submitted", payload: { height: 1 } },
    { t: "ban", s: 1, at, ip: "10.0.0.9", reason: "x", until: at },
  ]) assert.equal(journalRecordProblem(r, NOW), null, JSON.stringify(r).slice(0, 80));
});

test("records that must never be applied are named as such", () => {
  const bad = [
    [null, "not an object"], ["x", "not an object"],
    [share({ s: 0 }), "bad sequence number"], [share({ s: -5 }), "bad sequence number"], [share({ s: 1.5 }), "bad sequence number"],
    [share({ s: (NOW + 2 * 86_400_000) * 1000 }), "bad sequence number"],
    [share({ at: "yesterday" }), "bad time"], [share({ at: 5 }), "bad time"],
    [share({ key: { address: "", name: "x" } }), "bad share"], [share({ jobId: "" }), "bad share"], [share({ nonce: "x".repeat(200) }), "bad share"],
    [share({ accepted: "yes" }), "bad share"],
    [share({ difficulty: "-1" }), "bad difficulty"], [share({ difficulty: 5 }), "bad difficulty"], [share({ difficulty: "1e9" }), "bad difficulty"],
    [share({ networkDifficulty: "0" }), "bad network difficulty"],
    [share({ accepted: false }), "bad reject reason"],
    [block({ hash: "ZZ".repeat(32) }), "bad block"], [block({ status: "" }), "bad block"], [block({ foundAt: "never" }), "bad block"],
    [block({ key: { address: 5 } }), "bad block worker"],
    [{ t: "event", s: 1, at, type: "x", payload: "no" }, "bad event"],
    [{ t: "event", s: 1, at, type: "x", payload: { big: "x".repeat(9000) } }, "bad event"],
    [{ t: "ban", s: 1, at, ip: "1.2.3.4", reason: "x", until: "later" }, "bad ban"],
    [{ t: "worker", s: 1, at, address: key.address, name: "x".repeat(200) }, "bad worker"],
    [{ t: "mystery", s: 1, at }, "unknown record type"],
  ];
  for (const [record, why] of bad) assert.equal(journalRecordProblem(record, NOW), why, JSON.stringify(record)?.slice(0, 90));
});

/** A stand-in for the database functions that remembers what it was asked. */
function fakeApi() {
  const calls = [];
  let nextId = 1;
  return {
    calls,
    ensureWorker: async (_pool, w) => { calls.push(["ensureWorker", w.address, w.name, w.ip ?? null]); return { minerId: 7n, workerId: BigInt(nextId++) }; },
    recordShare: async (_pool, s) => { calls.push(["recordShare", String(s.workerId), s.nonce, s.createdAt]); },
    recordShares: async (_pool, shares) => { calls.push(["recordShares", ...shares.map((s) => s.nonce)]); },
    recordBlock: async (_pool, b) => { calls.push(["recordBlock", b.hash, b.workerId === null ? null : String(b.workerId), b.foundAt.toISOString()]); },
    recordServiceEvent: async (_pool, type, payload, when) => { calls.push(["recordServiceEvent", type, when.toISOString()]); },
    recordBan: async (_pool, ban) => { calls.push(["recordBan", ban.ip, ban.until.toISOString()]); },
  };
}

test("a share from a worker with no id yet creates the worker once, then reuses it", async () => {
  const api = fakeApi();
  const workers = new Map();
  await applyJournalRecord(null, share({ nonce: "a" }), workers, { api });
  await applyJournalRecord(null, share({ nonce: "b" }), workers, { api });
  assert.equal(api.calls.filter((c) => c[0] === "ensureWorker").length, 1);
  assert.deepEqual(api.calls.filter((c) => c[0] === "recordShare").map((c) => c[1]), ["1", "1"]);
  assert.equal(api.calls[1][3], at, "the share keeps the time it happened");
});

test("a block and a ban keep their own times; a block without a worker stays without one", async () => {
  const api = fakeApi();
  await applyJournalRecord(null, block({ key: null }), new Map(), { api });
  await applyJournalRecord(null, { t: "ban", s: 1, at, ip: "10.0.0.9", reason: "x", until: "2026-10-03T12:15:00.000Z" }, new Map(), { api });
  assert.deepEqual(api.calls[0], ["recordBlock", "ab".repeat(32), null, at]);
  assert.deepEqual(api.calls[1], ["recordBan", "10.0.0.9", "2026-10-03T12:15:00.000Z"]);
});

test("a worker that cannot be created makes the record permanently unappliable, and the cache is told", async () => {
  const noId = { ...fakeApi(), ensureWorker: async () => ({ minerId: null, workerId: null }) };
  await assert.rejects(applyJournalRecord(null, share(), new Map(), { api: noId }), TypeError);
  await assert.rejects(applyJournalRecord(null, { t: "mystery" }, new Map(), { api: fakeApi() }), /Unknown journal record type/);
  const remembered = [];
  await applyJournalRecord(null, { t: "worker", s: 1, at, address: key.address, name: "rig", ip: null }, new Map(), { api: fakeApi(), remember: (k, ids) => remembered.push([k, ids.workerId]) });
  assert.equal(remembered.length, 1);
});

test("the database functions refuse bad input before touching the database", async () => {
  const pool = { connect: () => { throw new Error("must not be reached"); }, query: () => { throw new Error("must not be reached"); } };
  await assert.rejects(ensureWorker(pool, { address: "" }), TypeError);
  await assert.rejects(ensureWorker(pool, { address: "x", name: "" }), TypeError);
  await assert.rejects(ensureWorker(pool, { address: "x", name: "n".repeat(129) }), TypeError);
  const good = { workerId: "1", jobId: "j", nonce: "n", difficulty: "10", accepted: true };
  for (const bad of [{ workerId: 1 }, { jobId: "" }, { nonce: "" }, { accepted: "true" }, { accepted: false }, { difficulty: 10 }, { difficulty: "0" }, { difficulty: "0.0" }, { difficulty: "1.1234567890123" }, { networkDifficulty: "0" }]) {
    await assert.rejects(recordShare(pool, { ...good, ...bad }), TypeError, JSON.stringify(bad));
  }
  await assert.rejects(recordBlock(pool, { hash: "short", status: "submitted" }), TypeError);
  await assert.rejects(recordBlock(pool, { hash: "ab".repeat(32), status: "" }), TypeError);
  await assert.rejects(recordServiceEvent(pool, ""), TypeError);
});

const down = () => Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
const isFatal = (/** @type {any} */ error) => error?.code === "ECONNREFUSED";
const event = (type) => ({ t: "event", s: 1, at, type, payload: {} });

test("a replay writes runs of shares in batches, in order with the records around them", async () => {
  const api = fakeApi();
  const settled = [];
  const records = [share({ nonce: "a" }), share({ nonce: "b" }), share({ nonce: "c" }), event("between"), share({ nonce: "d" })];
  await applyJournalRecords(null, records, new Map(), { api, isFatal, batch: 2, onApplied: (i) => settled.push(i) });
  assert.deepEqual(api.calls.filter((c) => c[0] !== "ensureWorker").map((c) => `${c[0]}:${c.slice(1, c[0] === "recordShares" ? undefined : 2)}`),
    ["recordShares:a,b", "recordShares:c", "recordServiceEvent:between", "recordShares:d"]);
  assert.deepEqual(settled, [1, 2, 3, 4], "progress only ever moves forward, once records are written");
  assert.equal(api.calls.filter((c) => c[0] === "ensureWorker").length, 1, "the worker is created once");
});

test("a refused batch is retried a share at a time, skipping only the share at fault", async () => {
  const api = fakeApi();
  api.recordShares = async () => { throw Object.assign(new Error("out of range"), { code: "22003" }); };
  api.recordShare = async (_pool, s) => { if (s.nonce === "bad") throw Object.assign(new Error("out of range"), { code: "22003" }); api.calls.push(["recordShare", s.nonce]); };
  const refused = [];
  const settled = [];
  await applyJournalRecords(null, [share({ nonce: "a" }), share({ nonce: "bad" }), share({ nonce: "b" })], new Map(), {
    api, isFatal, onRefused: (r) => refused.push(r.nonce), onApplied: (i) => settled.push(i) });
  assert.deepEqual(api.calls.filter((c) => c[0] === "recordShare").map((c) => c[1]), ["a", "b"]);
  assert.deepEqual(refused, ["bad"]);
  assert.deepEqual(settled, [0, 1, 2]);
});

test("when the database goes away part way, progress stops at the last batch written", async () => {
  const api = fakeApi();
  let batches = 0;
  api.recordShares = async (_pool, shares) => { if (++batches === 2) throw down(); api.calls.push(["recordShares", ...shares.map((s) => s.nonce)]); };
  const settled = [];
  const records = ["a", "b", "c", "d", "e"].map((nonce) => share({ nonce }));
  await assert.rejects(applyJournalRecords(null, records, new Map(), { api, isFatal, batch: 2, onApplied: (i) => settled.push(i) }), /ECONNREFUSED/);
  assert.deepEqual(settled, [1], "a and b are written; the replay resumes at c");
});

test("a record that cannot be applied is skipped after the shares before it are written", async () => {
  const api = fakeApi();
  const order = [];
  const settled = [];
  await applyJournalRecords(null, [share({ nonce: "a" }), { t: "mystery", s: 1, at }, share({ nonce: "b" })], new Map(), {
    api, isFatal, onRefused: (r) => order.push(`refused:${r.t}`), onApplied: (i) => { order.push(`settled:${i}`); settled.push(i); } });
  assert.deepEqual(api.calls.filter((c) => c[0] === "recordShares").map((c) => c.slice(1)), [["a"], ["b"]]);
  assert.deepEqual(order, ["settled:0", "refused:mystery", "settled:1", "settled:2"]);
});
