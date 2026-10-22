// The Overview's "Blocks found" tile: all the blocks found, and how many of them in the last 24 hours (rejected ones count in neither).
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { createElement as h } from "react";
import { cleanup, fakeApi, render } from "../dom/render.js";
import Overview from "../../src/pages/Overview.jsx";

globalThis.ResizeObserver = window.ResizeObserver = /** @type {any} */ (class {
  /** @param {(entries: { contentRect: { width: number } }[]) => void} callback */
  constructor(callback) { this.callback = callback; }
  observe() { this.callback([{ contentRect: { width: 640 } }]); }
  disconnect() {}
});

afterEach(cleanup);

const overview = {
  node: { height: 9400000, miner_reward: "1460000000" },
  network: { difficulty: "700000000" },
  miners: { active_workers: "1", active_miners: "1" },
  shares: { accepted_1h: "720" },
  miningEstimates: { "1h": { estimatedHashesPerSecond: "8000", expectedTimeToBlockSeconds: 87500 } },
  blocks: [
    { status: "main-chain", count: "20", last_24h: "2" },
    { status: "side", count: "2", last_24h: "1" },
    { status: "submitted", count: "1", last_24h: "1" },
    { status: "rejected", count: "3", last_24h: "3" },
  ],
  luck: { trackedSince: null, expectedBlocks: 0, blocksFound: 0, luck: null, round: { startedAt: null, effort: null }, medianBlockEffort: null },
};

test("Blocks found shows the total and the last 24 hours, rejected blocks left out of both", async () => {
  fakeApi({ "/api/v1/overview": overview, "/api/v1/blocks": { blocks: [], totals: {} }, "/api/v1/events": { events: [] } });
  const view = await render(h(Overview));
  const text = view.text();
  assert.ok(text.includes("Blocks found23"), text.slice(0, 400));
  assert.match(text, /4 in 24 h · 20 main chain · 1 pending/);
});
