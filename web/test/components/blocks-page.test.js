// The Blocks page: luck over 7 and 30 days, the orphan rate, the effort of each recent block, and the status filter on the table.
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { createElement as h } from "react";
import { cleanup, fakeApi, getByText, interact, render } from "../dom/render.js";
import Blocks from "../../src/pages/Blocks.jsx";

afterEach(cleanup);

const block = (/** @type {number} */ height, /** @type {string} */ status, /** @type {number} */ effort) => ({
  hash: String(height).padStart(64, "0"), height: String(height), topoheight: null, status, reward: status === "orphaned" ? null : "30000000",
  foundAt: new Date(Date.now() - (1000 - height) * 3_600_000).toISOString(), address: `xel:${"a".repeat(59)}`, worker: "rig1", effort,
});
const day = (/** @type {number} */ blocks, /** @type {number} */ expected) => ({ day: new Date().toISOString(), blocks, reward: "0", expectedBlocks: expected });

fakeApi({
  "/api/v1/blocks?limit=200": { blocks: [block(999, "main-chain", 0.5), block(998, "orphaned", 2.5), block(997, "side", 1.2)], totals: { reward: "60000000", byStatus: { "main-chain": { blocks: 1, reward: "30000000" }, side: { blocks: 1, reward: "30000000" } } } },
  "/api/v1/overview": { node: { miner_reward: "30000000" }, network: { difficulty: "1000" }, blocks: [{ status: "main-chain", count: "6" }, { status: "side", count: "2" }, { status: "orphaned", count: "2" }] },
  // 30 days: 23 with nothing expected, then the last 7 with 1 block expected a day and 14 found in all (2 in the last 7 days).
  "/api/v1/rewards?range=30d": { range: "30d", points: [...Array(23).fill(0).map(() => day(0, 0)), ...Array(5).fill(0).map(() => day(0, 1)), day(1, 1), day(1, 1)] },
  "/api/v1/rewards?range=90d": { range: "90d", points: [] },
});

test("luck over 7 and 30 days, the orphan rate, and each recent block's effort", async () => {
  const view = await render(h(Blocks));
  const text = view.text();
  assert.match(text, /7 days29%/, "2 found of 7 expected");
  assert.match(text, /30 days29%/);
  assert.match(text, /Blocks found10/);
  assert.match(text, /Orphan rate20%/, "2 orphaned of 10 final");
  // The chart draws once it has a width, which the test page never gives it; its table lists the same blocks, newest first.
  await interact(() => getByText(view.container, "Show as table", "button").click());
  const effort = view.container.querySelector("table:has(th) tbody")?.closest("div.mt-2");
  assert.ok(effort, "the effort table");
  assert.deepEqual([...effort.querySelectorAll("tbody tr td:nth-child(3)")].map((td) => td.textContent), ["50%", "250%", "120%"]);
  await interact(() => getByText(view.container, "Hide table", "button").click());
});

test("the table can show one kind of block", async () => {
  const view = await render(h(Blocks));
  const rows = () => view.container.querySelectorAll("tbody tr").length;
  assert.equal(rows(), 3);
  await interact(() => getByText(view.container, "Orphaned", "[aria-pressed]").click());
  assert.equal(rows(), 1);
  await interact(() => getByText(view.container, "Pending", "[aria-pressed]").click());
  assert.match(view.text(), /No blocks of this kind/);
  await interact(() => getByText(view.container, "All", "[aria-pressed]").click());
  assert.equal(rows(), 3);
});
