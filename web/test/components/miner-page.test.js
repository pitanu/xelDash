// A miner's page: its hashrate from all its rigs, blocks expected a day and found, rewards, luck, its workers and on-time, a CSV of
// its blocks; and a plain message for an address that never connected.
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { createElement as h } from "react";
import { cleanup, fakeApi, render, settle } from "../dom/render.js";
import Miner from "../../src/pages/Miner.jsx";

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
const w = (/** @type {string} */ name, /** @type {string} */ h1) => ({ name, lastSeen: hoursAgo(0.01), hashrate5m: h1, hashrate1h: h1, accepted1h: "100", rejected1h: "1", reportedHashrate: null });
const block = (/** @type {string} */ status, /** @type {number} */ n) => ({ hash: `${n}`.padStart(64, "0"), height: String(8270000 + n), topoheight: null, status,
  reward: "30000000", foundAt: hoursAgo(n), address: A, worker: "rig1", effort: 0.9 });

test("a miner's figures: hashrate of all its rigs, blocks expected and found, luck, its workers, and its blocks as CSV", async () => {
  fakeApi({
    [`/api/v1/miners/${encodeURIComponent(A)}`]: { address: A, firstSeen: hoursAgo(500), lastSeen: hoursAgo(0.01), workers: [w("rig1", "5000"), w("rig2", "3000")],
      luck: { trackedSince: hoursAgo(400), expectedBlocks: 10, blocksFound: 11, luck: 1.1, round: { startedAt: hoursAgo(2), effort: 0.4 } }, bestShare: null },
    "/api/v1/hashrate": { bucketSeconds: 900, points: [] },
    "/api/v1/blocks": { blocks: [block("main-chain", 1), block("side", 2), block("rejected", 3)],
      totals: { reward: "60000000", byStatus: { "main-chain": { blocks: 1, reward: "30000000" }, side: { blocks: 1, reward: "30000000" } } } },
    "/api/v1/rewards": { range: "90d", points: [] },
    "/api/v1/activity": { range: "7d", periodMinutes: 10080, onMinutes: 5040, dutyCycle: 0.5, averageOnMinutesPerDay: 720,
      hashrateWhileOn: 8000, expectedBlocks: 5, foundBlocks: 6, luck: 1.2, bridgeMinutes: 3, stretches: [] },
    "/api/v1/overview": { network: { difficulty: "250000000" }, node: { miner_reward: "30000000", network: "mainnet" } },
  });
  const view = await render(h(Miner, { address: A }));
  await settle();
  const text = view.text();
  assert.match(text, new RegExp(A));
  assert.match(text, /Hashrate, last hour8 KH\/s/, "the rigs added up");
  assert.match(text, /Expected blocks a day2[.,]8/, "8 KH/s × 86,400 s ÷ 250M");
  assert.match(text, /Blocks found2/, "rejected blocks are not counted");
  assert.match(text, /1 main chain/);
  assert.match(text, /rig1/);
  assert.match(text, /rig2/);
  assert.match(text, /On-time/);
  assert.match(text, /110%/, "luck: 11 found of 10 expected");
  assert.ok(view.container.querySelector(`a[href="/api/v1/blocks.csv?address=${encodeURIComponent(A)}"]`), "all its blocks as CSV");
});

test("an address that never connected is said plainly", async () => {
  fakeApi({ [`/api/v1/miners/${encodeURIComponent(A)}`]: { status: 404, body: { error: "not_found" } } });
  const view = await render(h(Miner, { address: A }));
  await settle();
  assert.match(view.text(), /No miner with address .* has connected/);
});
