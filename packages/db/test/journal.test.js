import test from "node:test";
import assert from "node:assert/strict";
import { applyJournalRecord, ensureWorker, journalRecordProblem, recordBlock, recordShare, recordServiceEvent } from "../src/index.js";

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
