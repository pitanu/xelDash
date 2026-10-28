// The Worker page: when the rig was first and last seen, its hashrate (the 24-hour figure called an average), shares and the
// rejected ones by reason in words, its blocks, and a plain message for a worker that does not exist.
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { createElement as h } from "react";
import { cleanup, fakeApi, render, settle } from "../dom/render.js";
import Worker from "../../src/pages/Worker.jsx";

// The charts draw once they know their width.
globalThis.ResizeObserver = window.ResizeObserver = /** @type {any} */ (class {
  /** @param {(entries: { contentRect: { width: number } }[]) => void} callback */
  constructor(callback) { this.callback = callback; }
  observe() { this.callback([{ contentRect: { width: 640 } }]); }
  disconnect() {}
});

afterEach(cleanup);

const A = `xel:${"a".repeat(59)}`;
const hoursAgo = (/** @type {number} */ n) => new Date(Date.now() - n * 3_600_000).toISOString();
const worker = {
  name: "rig1", firstSeen: hoursAgo(72), lastSeen: hoursAgo(0.01), lastIp: "192.168.1.30", reportedHashrate: "8100",
  hashrate: { "5m": "7900", "1h": "7800", "24h": "1950" },
  shares: { accepted1h: "700", rejected1h: "2", accepted24h: "4000", rejected24h: "40" },
  rejectReasons24h: [{ reason: "stale", count: "30" }, { reason: "low_difficulty", count: "10" }],
  bestShare: null,
};
const block = { hash: "ab".repeat(32), height: "8270000", topoheight: "9500000", status: "main-chain", reward: "30000000",
  foundAt: hoursAgo(5), address: A, worker: "rig1", effort: 0.8 };

test("a rig's figures: hashrate with the 24-hour one an average, shares, rejected shares in words, and its blocks", async () => {
  fakeApi({
    [`/api/v1/miners/${encodeURIComponent(A)}/workers/rig1`]: worker,
    "/api/v1/hashrate": { bucketSeconds: 900, points: [] },
    "/api/v1/blocks": { blocks: [block], totals: { reward: "30000000", byStatus: { "main-chain": { blocks: 1, reward: "30000000" } } } },
    "/api/v1/activity": { range: "7d", periodMinutes: 10080, onMinutes: 2520, dutyCycle: 0.25, averageOnMinutesPerDay: 360,
      hashrateWhileOn: 7800, expectedBlocks: 0.5, foundBlocks: 1, luck: 2, bridgeMinutes: 3, stretches: [] },
    "/api/v1/overview": { network: { difficulty: "250000000" }, node: { miner_reward: "30000000", network: "mainnet" } },
  });
  const view = await render(h(Worker, { address: A, name: "rig1" }));
  await settle();
  const text = view.text();
  assert.match(text, /rig1/);
  assert.match(text, /192\.168\.1\.30/, "the operator sees the rig's last address");
  assert.match(text, /Hashrate, last hour7[.,]8 KH\/s/);
  assert.match(text, /24 h average: 1[.,]95 KH\/s/, "the whole-day figure says it is an average");
  assert.match(text, /miner reports 8[.,]1 KH\/s/);
  assert.match(text, /Accepted shares, 24 h4[  ,.]?000/);
  assert.match(text, /1[.,]0% of submissions/, "40 of 4,040");
  assert.match(text, /Stale \(arrived after a new block\)30/);
  assert.match(text, /Below share target10/);
  assert.match(text, /On-time/);
  assert.match(text, /8[  ,.]?270[  ,.]?000/, "its block");
  assert.ok(view.container.querySelector(`a[href="#/miner/${A}"]`), "back to the address");
});

test("a worker name that does not exist for the address is said plainly", async () => {
  fakeApi({ [`/api/v1/miners/${encodeURIComponent(A)}/workers/ghost`]: { status: 404, body: { error: "not_found" } } });
  const view = await render(h(Worker, { address: A, name: "ghost" }));
  await settle();
  assert.match(view.text(), /No worker named ghost for this address/);
});
