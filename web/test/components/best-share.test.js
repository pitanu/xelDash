// The best share card: this round's, the last day's and the best ever, a dot per bucket on a scale that always reaches a block, a
// table view, and nothing at all while best share is turned off.
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { createElement as h } from "react";
import { cleanup, interact, render } from "../dom/render.js";
import { BestShareCard, bestShareScale } from "../../src/components/BestShareChart.jsx";
import { formatBestShare } from "../../src/format.js";

// The chart draws once it knows its width.
globalThis.ResizeObserver = window.ResizeObserver = /** @type {any} */ (class {
  /** @param {(entries: { contentRect: { width: number } }[]) => void} callback */
  constructor(callback) { this.callback = callback; }
  observe() { this.callback([{ contentRect: { width: 640 } }]); }
  disconnect() {}
});

afterEach(cleanup);

const hoursAgo = (n) => new Date(Date.now() - n * 3_600_000).toISOString();
const points = [
  { time: hoursAgo(4), best: 0.004 },
  { time: hoursAgo(3), best: null },
  { time: hoursAgo(2), best: 0.38 },
  { time: hoursAgo(1), best: 1.7 },
];

test("the figures, a dot for each bucket with a share, and the line a block reaches", async () => {
  const view = await render(h(BestShareCard, { best: { round: 0.38, ever: 1.7 }, points }));
  const text = view.text();
  assert.match(text, /Best share/);
  assert.ok(text.includes(`This round${formatBestShare(0.38)}`), text);
  assert.ok(text.includes(`Best ever${formatBestShare(1.7)}`));
  assert.doesNotMatch(text, /Last 24 hours/, "a miner's card has no day figure");
  assert.match(text, /A block/);
  assert.match(text, /does not make the next block more likely/);
  assert.equal(view.container.querySelectorAll("circle").length, 3, "the empty bucket has no dot");
  assert.equal(view.container.querySelector("[title='Closest to a block']")?.textContent, "Best share");
});

test("the table lists the buckets with a share, newest first, and names a block", async () => {
  const view = await render(h(BestShareCard, { best: { round: 0.38, day: 0.38, ever: 1.7 }, points }));
  const button = [...view.container.querySelectorAll("button")].find((b) => /Show as table/.test(b.textContent ?? ""));
  assert.ok(button);
  await interact(() => button.click());
  const rows = [...view.container.querySelectorAll("tbody tr")].map((r) => r.textContent);
  assert.equal(rows.length, 3);
  assert.match(rows[0] ?? "", /\(a block\)/);
});

test("turned off (the API sends null), there is nothing", async () => {
  const view = await render(h(BestShareCard, { best: null, points }));
  assert.equal(view.text(), "");
});

test("the scale is powers of ten that always include a block", () => {
  assert.deepEqual(bestShareScale([0.004, 0.38]).ticks, [0.001, 0.01, 0.1, 1]);
  assert.deepEqual(bestShareScale([0.00002, 1.7]), { from: -5, to: 1, ticks: [1e-5, 1e-4, 1e-3, 1e-2, 1e-1, 1, 10] });
  assert.deepEqual(bestShareScale([]).ticks, [0.001, 0.01, 0.1, 1]);
});
