// A node without peers on mainnet or testnet is reported after a while (not in the first seconds after a start), and again when it
// has peers back; on a private devnet having none is normal and nothing is said. Mining is not paused for it, except just after the
// node starts: until it first finds peers (at most two minutes) it cannot know how far behind it is.
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
  assert.equal(monitor.ready, false, "until it finds some, it cannot know whether it is behind");
  assert.match(monitor.reason, /looking for peers/);
  await checkAt(120);
  assert.equal(told.length, 1);
  await checkAt(125);
  assert.equal(monitor.ready, true, "after two minutes with none, mining is not paused for it");
  assert.equal(told[0][0], true);
  assert.equal(told[0][1].peerlessSince, new Date(0).toISOString());
  await checkAt(180);
  assert.equal(told.length, 1, "said once, not on every check");
  state.peers = 8;
  await checkAt(190);
  assert.equal(told.length, 2);
  assert.equal(told[1][0], false);
});

test("just started on mainnet: looking for peers, then ready once they show it caught up; losing them later does not pause it", async () => {
  const { state, monitor, checkAt } = setup("mainnet");
  await checkAt(0);
  assert.equal(monitor.state, "syncing");
  state.peers = 8;
  await checkAt(5);
  await checkAt(10);
  assert.equal(monitor.ready, true);
  state.peers = 0;
  await checkAt(15);
  await checkAt(20);
  assert.equal(monitor.ready, true, "it had peers: still caught up, and the operator is told if it stays like this");
});

test("a node that restarts looks for peers again before it counts as caught up", async () => {
  const { state, monitor, checkAt } = setup("mainnet");
  state.peers = 8;
  await checkAt(0);
  assert.equal(monitor.ready, true);
  const daemon = /** @type {any} */ (monitor.daemon);
  const getInfo = daemon.getInfo;
  daemon.getInfo = async () => { throw new Error("connection refused"); };
  await checkAt(5);
  await checkAt(10);
  assert.equal(monitor.state, "unreachable");
  daemon.getInfo = getInfo;
  state.peers = 0;
  await checkAt(15);
  await checkAt(20);
  assert.equal(monitor.state, "syncing");
  assert.match(monitor.reason, /looking for peers/);
});

test("on a private devnet, a node with no peers is ready at once", async () => {
  const { monitor, checkAt } = setup("devnet");
  await checkAt(0);
  assert.equal(monitor.ready, true);
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
