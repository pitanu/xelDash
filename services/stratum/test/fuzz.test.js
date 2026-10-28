// Random input where Stratum reads untrusted bytes: the line framer and a logged-in session. Seeded, so a failure can be repeated
// (the seed is in the message); a few thousand cases each, to stay quick.
import test from "node:test";
import assert from "node:assert/strict";
import { LineFramer } from "../src/line-framer.js";
import { StratumSession } from "../src/session.js";

/** A small seeded random generator (an LCG): the same seed gives the same cases. @param {number} seed */
function random(seed) {
  let s = seed >>> 0 || 1;
  const next = () => ((s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 2 ** 32);
  return { next, int: (/** @type {number} */ n) => Math.floor(next() * n), pick: (/** @type {any[]} */ a) => a[Math.floor(next() * a.length)] };
}

/** The lines a whole stream holds, the way the framer should find them: split at \n, a trailing \r dropped, empty lines skipped. */
function expectedLines(/** @type {Buffer} */ all) {
  const parts = [];
  let start = 0;
  for (let i = 0; i < all.length; i++) {
    if (all[i] !== 0x0a) continue;
    let line = all.subarray(start, i);
    if (line.length && line[line.length - 1] === 0x0d) line = line.subarray(0, -1);
    if (line.length) parts.push(line.toString("utf8"));
    start = i + 1;
  }
  return { lines: parts, rest: all.length - start };
}

test("the framer finds the same lines however the bytes are split, and only ever refuses with a RangeError", () => {
  const MAX = 64;
  for (let seed = 1; seed <= 2000; seed++) {
    const r = random(seed);
    // Random bytes with carriage returns and invalid UTF-8; how common newlines are varies, so some lines run over the limit.
    const newlines = r.pick([0.3, 0.05, 0.01]);
    const all = Buffer.from(Array.from({ length: r.int(400) },
      () => (r.next() < newlines ? 0x0a : r.pick([0x0d, 0x7b, 0x22, 0xff, 0xc3, 0x00, r.int(256)]))));
    const framer = new LineFramer(MAX);
    /** @type {string[]} */
    const got = [];
    let refused = null;
    let at = 0;
    try {
      while (at < all.length) {
        const size = 1 + r.int(50);
        got.push(...framer.push(all.subarray(at, at + size)));
        at += size;
      }
    } catch (error) {
      refused = error;
    }
    const whole = expectedLines(all);
    // The limit is on raw bytes (latin1 keeps one character per byte; decoded text can be longer: invalid UTF-8 becomes U+FFFD).
    const tooLong = whole.rest > MAX || all.toString("latin1").split("\n").some((part) => part.length > MAX);
    if (refused) {
      assert.ok(refused instanceof RangeError, `seed ${seed}: ${refused}`);
      assert.ok(tooLong, `seed ${seed}: refused a stream with no line over the limit`);
      continue;
    }
    assert.ok(!tooLong || at < all.length, `seed ${seed}: an over-long line was not refused`);
    assert.deepEqual(got, whole.lines, `seed ${seed}`);
  }
});

test("too many lines in one batch is refused with a RangeError, never by another error", () => {
  const framer = new LineFramer();
  assert.throws(() => framer.push("a\nb\nc\n", 2), RangeError);
  assert.deepEqual(new LineFramer().push("a\nb\n", 2), ["a", "b"]);
});

const ADDRESS = "xet:" + "q".repeat(58);

test("no random request makes a session's handlers fail: every input is checked before it is used", async () => {
  const VALUES = [null, true, false, 0, -1, 1e308, Number.NaN, 2 ** 53, "", "x", "rig1", ADDRESS, `${ADDRESS}.rig1`, `solo:${ADDRESS}`,
    "0123456789abcdef", "d=5000", "d=-1", "d=abc", "x".repeat(300), [], {}, [1, 2], { a: 1 }, "\u0000", "é", "1.5", "9".repeat(40)];
  const METHODS = ["mining.subscribe", "mining.authorize", "mining.submit", "mining.hashrate", "mining.pong", "mining.extranonce.subscribe", "x"];
  for (let seed = 1; seed <= 120; seed++) {
    const r = random(seed);
    /** @param {number} [depth] @returns {unknown} */
    const value = (depth = 0) => (depth < 2 && r.next() < 0.2 ? Array.from({ length: r.int(4) }, () => value(depth + 1)) : r.pick(VALUES));
    /** @type {string[]} */
    const failures = [];
    let jobCounter = 0;
    const session = new StratumSession({
      socket: { remoteAddress: "10.0.0.5", destroyed: false, write: () => {} },
      authorizeAddress: async ({ address }) => ({ minerId: 1n, workerId: 7n, address, publicKey: "ab".repeat(32) }),
      createJob: async ({ shareDifficulty, extraNonce, publicKey }) => ({
        jobId: `job${++jobCounter}`, template: "t", timestampHex: "0000000000000064", headerWorkHash: "11".repeat(32), algorithm: "xel/v3",
        networkDifficulty: "1000000", height: 1, topoheight: 1, nodeId: 0, shareDifficulty,
        extraNonce: Buffer.from(extraNonce, "hex"), publicKey: Buffer.from(publicKey, "hex"), buildMinerWork: () => Buffer.alloc(112),
      }),
      submitShare: async () => (r.next() < 0.5 ? { accepted: true } : { error: { code: 23, message: "Low difficulty share" } }),
      vardiff: { startDifficulty: 1000, minDifficulty: 100, targetShareSeconds: 10, retargetSeconds: 60, retargetShares: 20 },
      logger: { info() {}, warn: (/** @type {string} */ message, /** @type {any} */ detail) => failures.push(`${message} ${detail?.method}: ${detail?.error}`) },
    });
    const lines = [JSON.stringify({ id: 1, method: "mining.subscribe", params: ["fuzz/1", ["xel/v3"]] })];
    if (r.next() < 0.7) lines.push(JSON.stringify({ id: 2, method: "mining.authorize", params: [ADDRESS, "rig1", ""] }));
    for (let i = 0; i < 40; i++) {
      /** @type {Record<string, unknown>} */
      const message = { method: r.pick(METHODS), params: r.next() < 0.1 ? value() : Array.from({ length: r.int(5) }, () => value()) };
      const id = r.pick([1, "a", null, 2 ** 60, {}, [], undefined]);
      if (id !== undefined) message.id = id;
      if (r.next() < 0.05) message.jsonrpc = r.pick(["2.0", "1.0", 2]);
      lines.push(r.next() < 0.05 ? r.pick(["{", "null", "[]", "\"x\"", "{\"method\":1}", "x".repeat(10)]) : JSON.stringify(message));
    }
    for (let [i, line] of lines.entries()) {
      // Real job ids too, so submits reach the share path.
      const job = i > 2 && r.next() < 0.3 ? r.pick([...session.jobs.values()]) : null;
      if (job) {
        line = JSON.stringify({ id: 9, method: "mining.submit", params: [r.pick(["rig1", `${ADDRESS}.rig1`, "nobody", 5]),
          r.pick([job.jobId, `${job.jobId}x`]), r.pick(["0123456789abcdef", r.int(2 ** 31).toString(16).padStart(16, "0"), "zz", 7])] });
      }
      await session.handleLine(line);
    }
    session.close();
    assert.deepEqual(failures, [], `seed ${seed}`);
  }
});
