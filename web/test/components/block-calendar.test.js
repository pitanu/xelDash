// The block calendar: blocks found each day in this browser's time zone, the totals over it, and a table of the days with blocks.
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { createElement as h } from "react";
import { cleanup, fakeApi, getByText, interact, render, settle } from "../dom/render.js";
import BlockCalendar from "../../src/components/BlockCalendar.jsx";
import { localDayKey } from "../../src/block-days.js";

afterEach(cleanup);

const ADDRESS = `xel:${"a".repeat(59)}`;
const daysAgo = (/** @type {number} */ n) => { const d = new Date(); d.setDate(d.getDate() - n); return d; };
const tz = encodeURIComponent(Intl.DateTimeFormat().resolvedOptions().timeZone);

test("an address's blocks by day: totals, the best day, a darker square for it, and the table", async () => {
  const calls = fakeApi({
    [`/api/v1/block-days?address=${encodeURIComponent(ADDRESS)}&range=1y&tz=${tz}`]: { range: "1y", timeZone: "UTC",
      days: [{ day: localDayKey(daysAgo(10)), blocks: 1, orphaned: 0 }, { day: localDayKey(daysAgo(2)), blocks: 4, orphaned: 1 }] },
    [`/api/v1/block-days?address=${encodeURIComponent(ADDRESS)}&range=90d&tz=${tz}`]: { range: "90d", timeZone: "UTC", days: [] },
  });
  const view = await render(h(BlockCalendar, { address: ADDRESS }));
  await settle();
  const text = view.text();
  assert.match(text, /Blocks this address found each day/);
  assert.match(text, /Blocks found5in the last 1 y/);
  assert.match(text, /Days with a block2of 11 days since the first/, "counted from the first block, ten days ago, to today");
  assert.match(text, /Average a day0[.,]45blocks, since /, "5 blocks over those 11 days, not over the year");
  assert.match(text, /Best day4 blocks/);
  const squares = [...view.container.querySelectorAll("[role=img] .aspect-square")];
  assert.equal(squares.length, 365, "a square a day");
  const best = squares[squares.length - 3];
  assert.equal(best.getAttribute("data-level"), "4", "the busiest day, two days ago, is the darkest");
  assert.equal(squares[squares.length - 11].getAttribute("data-level"), "1", "a quarter of it, the lightest");
  assert.equal(squares.filter((s) => s.getAttribute("data-level") === "0").length, 363);
  // The dashboard's own tooltip, on hover or tap (not the browser's slow title, which touch screens never show).
  await interact(() => best.dispatchEvent(new window.Event("pointerover", { bubbles: true })));
  const tip = view.container.querySelector("[role=tooltip]");
  assert.ok(tip, "a tooltip for the day under the pointer");
  assert.match(tip.textContent ?? "", /^4 blocks1 orphaned/);
  assert.match(tip.textContent ?? "", new RegExp(String(daysAgo(2).getDate())));
  // Arrow keys move it: down to the next day, up back again.
  const grid = /** @type {HTMLElement} */ (view.container.querySelector("[role=img]"));
  await interact(() => grid.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
  assert.match(view.container.querySelector("[role=tooltip]")?.textContent ?? "", /^0 blocks/, "the day after");
  await interact(() => grid.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true })));
  assert.match(view.container.querySelector("[role=tooltip]")?.textContent ?? "", /^4 blocks/);  await interact(() => getByText(view.container, "Show as table").click());
  assert.equal(view.container.querySelectorAll("table tbody tr").length, 2, "the days with blocks");
  await interact(() => getByText(view.container, "90 d", "button").click());
  await settle();
  assert.equal(view.container.querySelectorAll("[role=img] .aspect-square").length, 90);
  assert.match(view.text(), /No blocks in the last 90 d/);
  assert.ok(calls.every((c) => c.path.includes(`tz=${tz}`)), "the browser's time zone is sent");
});

test("the whole pool's calendar asks without an address", async () => {
  const calls = fakeApi({ [`/api/v1/block-days?range=1y&tz=${tz}`]: { range: "1y", timeZone: "UTC", days: [] } });
  const view = await render(h(BlockCalendar, {}));
  await settle();
  assert.match(view.text(), /Blocks this pool found each day/);
  assert.match(view.text(), /Best day—/);
  assert.equal(calls[0].path, `/api/v1/block-days?range=1y&tz=${tz}`);
});
