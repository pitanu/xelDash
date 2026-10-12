import assert from "node:assert/strict";
import test from "node:test";
import { createShareSubmitter } from "../src/share-submitter.js";

const ZERO_HASH = async () => Buffer.alloc(32);

function setup({ submitted }) {
  const found = [];
  const calls = [];
  const store = {
    recordBlock: async () => {},
    recordServiceEvent: async () => {},
    recordShare: async () => ({ duplicate: false }),
  };
  const daemon = { submitBlock: async () => { calls.push("submit"); return submitted; } };
  const submit = createShareSubmitter({
    daemon: /** @type {any} */ (daemon),
    store: /** @type {any} */ (store),
    logger: { warn() {}, info() {} },
    hashMinerWork: ZERO_HASH,
    onBlockAccepted: (block) => found.push(block),
  });
  const job = {
    algorithm: "xel/v3", jobId: "j1", height: 42, template: "00", nodeId: "daemon",
    shareDifficulty: "1", networkDifficulty: "1", buildMinerWork: () => Buffer.alloc(112),
  };
  const share = () => submit({ worker: { workerId: "1", address: "xet:test" }, workerName: "rig", job, nonce: "00", algorithm: "xel/v3" });
  return { share, found, calls };
}

test("a block the node accepts refreshes every rig's work at once", async () => {
  const { share, found, calls } = setup({ submitted: true });
  const result = await share();
  assert.equal(result.accepted, true);
  assert.equal(result.block.accepted, true);
  assert.deepEqual(calls, ["submit"]);
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
