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
