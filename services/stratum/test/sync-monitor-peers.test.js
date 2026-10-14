// A node without peers on mainnet or testnet is reported after a while (not in the first seconds after a start), and again when it
// has peers back; on a private devnet having none is normal and nothing is said. Mining is never paused for it.
import test from "node:test";
import assert from "node:assert/strict";
import { SyncMonitor } from "../src/sync-monitor.js";

const quiet = { info() {}, warn() {} };

/** @param {string} network */
function setup(network) {
  const state = { peers: 0, now: 0 };
  /** @type {[boolean, any][]} */
  const told = [];
  const daemon = {
    getInfo: async () => ({ height: 10, topoheight: 100, stableheight: 90, network }),
    getP2pStatus: async () => ({ peer_count: state.peers, median_topoheight: 100 }),
  };
  const monitor = new SyncMonitor({
    daemon: /** @type {any} */ (daemon), logger: quiet, peerlessMs: 120_000, now: () => state.now,
    onPeers: (peerless, detail) => told.push([peerless, detail]),
  });
  /** @param {number} at seconds since the start */
  const checkAt = async (at) => {
    state.now = at * 1000;
    await monitor.check();
  };
  return { state, told, monitor, checkAt };
}

test("on mainnet, a node with no peers for two minutes is reported once, and again when it has peers back", async () => {
  const { state, told, monitor, checkAt } = setup("mainnet");
  await checkAt(0);
  await checkAt(60);
  assert.equal(told.length, 0, "a node that just started is given time to find peers");
  assert.equal(monitor.ready, true, "mining is not paused for it");
  await checkAt(120);
  assert.equal(told.length, 1);
  assert.equal(told[0][0], true);
  assert.equal(told[0][1].peerlessSince, new Date(0).toISOString());
  await checkAt(180);
  assert.equal(told.length, 1, "said once, not on every check");
  state.peers = 8;
  await checkAt(190);
  assert.equal(told.length, 2);
  assert.equal(told[1][0], false);
});

test("peers found within the two minutes: nothing is said", async () => {
  const { state, told, checkAt } = setup("testnet");
  await checkAt(0);
  state.peers = 3;
  await checkAt(30);
  state.peers = 0;
  await checkAt(60);
  await checkAt(170);
  assert.equal(told.length, 0, "the two minutes start again from the latest time it had none");
  await checkAt(180);
  assert.equal(told.length, 1);
});

test("on a private devnet, no peers is normal: nothing is said", async () => {
  const { told, checkAt } = setup("devnet");
  for (const at of [0, 120, 600, 3600]) await checkAt(at);
  assert.equal(told.length, 0);
});
