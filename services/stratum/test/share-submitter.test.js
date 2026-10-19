import assert from "node:assert/strict";
import test from "node:test";
import { STRATUM_ERRORS } from "../src/protocol.js";
import { createShareSubmitter } from "../src/share-submitter.js";

const ZERO_HASH = async () => Buffer.alloc(32);

function setup({ submitted }) {
  const found = [];
  const calls = [];
  const recorded = [];
  const store = {
    recordBlock: async () => {},
    recordServiceEvent: async () => {},
    recordShare: async (share) => { recorded.push(share); return { duplicate: false }; },
  };
  const daemon = { submitBlock: async () => { calls.push("submit"); return submitted; } };
  const submit = createShareSubmitter({
    daemon: /** @type {any} */ (daemon),
    store: /** @type {any} */ (store),
    logger: { warn() {}, info() {} },
    hashMinerWork: async (work) => { calls.push("hash"); return ZERO_HASH(work); },
    onBlockAccepted: (block) => found.push(block),
  });
  const job = {
    algorithm: "xel/v3", jobId: "j1", height: 42, template: "00", nodeId: "daemon",
    shareDifficulty: "1", networkDifficulty: "1", buildMinerWork: () => Buffer.alloc(112),
  };
  const share = (duplicate = false) => submit({ worker: { workerId: "1", address: "xet:test" }, workerName: "rig", job, nonce: "00", algorithm: "xel/v3", duplicate });
  return { share, found, calls, recorded };
}

test("a block the node accepts refreshes every rig's work at once", async () => {
  const { share, found, calls } = setup({ submitted: true });
  const result = await share();
  assert.equal(result.accepted, true);
  assert.equal(result.block.accepted, true);
  assert.deepEqual(calls, ["hash", "submit"]);
  assert.equal(found.length, 1);
  assert.equal(found[0].height, 42);
  assert.equal(found[0].hash, result.block.hash);
});

test("a block the node refuses does not refresh work", async () => {
  const { share, found } = setup({ submitted: false });
  const result = await share();
  assert.equal(result.block.accepted, false);
  assert.equal(found.length, 0);
});

test("a duplicate is recorded as rejected without being hashed or submitted again", async () => {
  const { share, calls, recorded } = setup({ submitted: true });
  const result = await share(true);
  assert.equal(result.error.code, STRATUM_ERRORS.DUPLICATE_SHARE);
  assert.deepEqual(calls, [], "no hash, no block");
  assert.equal(recorded.length, 1);
  assert.deepEqual([recorded[0].accepted, recorded[0].rejectReason], [false, "duplicate"]);
});

test("best share: how close a share came to a block, from its hash", async () => {
  const { bestShareOf } = await import("../src/share-submitter.js");
  const MAX = (1n << 256n) - 1n;
  // A hash exactly at a difficulty's target achieves that difficulty: at the network's, it is a block.
  assert.ok(Math.abs(bestShareOf(MAX / 1000n, 1000n) - 1) < 1e-9);
  assert.ok(Math.abs(bestShareOf(MAX / 250n, 1000n) - 0.25) < 1e-9, "a quarter of a block");
  assert.ok(bestShareOf(MAX / 5000n, 1000n) > 4.99, "better than a block");
  assert.equal(bestShareOf(0n, 1000n), 1e9, "a zero hash is capped, not infinite");
});

test("an accepted share carries its best share, a rejected one none, and none when turned off", async () => {
  /** @param {boolean} bestShare @param {Buffer} hash @param {string} shareDifficulty */
  async function recorded(bestShare, hash, shareDifficulty = "1") {
    const shares = [];
    const submit = createShareSubmitter({
      daemon: /** @type {any} */ ({ submitBlock: async () => true }),
      store: /** @type {any} */ ({ recordBlock: async () => {}, recordServiceEvent: async () => {}, recordShare: async (s) => { shares.push(s); return { duplicate: false }; } }),
      logger: { warn() {}, info() {} }, hashMinerWork: async () => hash, bestShare,
    });
    const job = { algorithm: "xel/v3", jobId: "j1", height: 42, template: "00", nodeId: "daemon", shareDifficulty, networkDifficulty: "1000000",
      buildMinerWork: () => Buffer.alloc(112) };
    await submit({ worker: { workerId: "1", address: "xet:test" }, workerName: "rig", job, nonce: "00", algorithm: "xel/v3" });
    return shares[0];
  }
  // A hash of 2^240: achieved difficulty (2^256 - 1) / 2^240 = 65535, so about 6.6% of a network difficulty of a million.
  const hash = Buffer.alloc(32);
  hash[1] = 1;
  const accepted = await recorded(true, hash);
  assert.equal(accepted.accepted, true);
  assert.ok(Math.abs(accepted.bestShare - 65535 / 1e6) < 1e-12, String(accepted.bestShare));
  const lowDifficulty = await recorded(true, hash, "100000");
  assert.equal(lowDifficulty.accepted, false);
  assert.equal(lowDifficulty.bestShare, null);
  assert.equal((await recorded(false, hash)).bestShare, null);
});
