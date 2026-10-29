// The on-time card: time on and its share of the range, hashrate while on, blocks expected against found, the estimate for running
// around the clock, and a strip of the days in this browser's hours, with a table view.
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { createElement as h } from "react";
import { cleanup, fakeApi, getByText, interact, render, settle } from "../dom/render.js";
import ActivityCard from "../../src/components/ActivityCard.jsx";

afterEach(cleanup);

const ADDRESS = `xel:${"a".repeat(59)}`;
const at = (/** @type {number} */ hour) => { const d = new Date(); d.setHours(hour, 0, 0, 0); return d; };
// Today from 09:00 to 15:00 local time: six hours on.
const today = [[at(9).toISOString(), at(15).toISOString()]];
const week = { range: "7d", periodMinutes: 7 * 1440, onMinutes: 360, dutyCycle: 360 / (7 * 1440), averageOnMinutesPerDay: 360 / 7,
  hashrateWhileOn: 10_000, expectedBlocks: 0.25, foundBlocks: 1, luck: 4, bridgeMinutes: 3, stretches: today };

test("a rig's time on, its speed while on, and blocks from that work; the strip and table show today's hours", async () => {
  fakeApi({
    [`/api/v1/activity?address=${encodeURIComponent(ADDRESS)}&worker=rig1&range=7d`]: week,
    [`/api/v1/activity?address=${encodeURIComponent(ADDRESS)}&worker=rig1&range=24h`]: { ...week, range: "24h", periodMinutes: 1440, dutyCycle: 0.25, averageOnMinutesPerDay: 360 },
    "/api/v1/overview": { network: { difficulty: "250000000" }, node: { miner_reward: "30000000", network: "mainnet" } },
  });
  const view = await render(h(ActivityCard, { address: ADDRESS, worker: "rig1" }));
  await settle();
  const text = view.text();
  assert.match(text, /When this rig was mining/);
  assert.match(text, /On6 h/);
  assert.match(text, /3[.,]6% of 168 h/, "six hours of a week");
  assert.match(text, /Hashrate while on10([.,]0)? KH\/s/);
  assert.match(text, /1 of 0[.,]25/, "in this browser's number format");
  assert.match(text, /luck 400%/);
  assert.match(text, /At that speed around the clock: ≈ [\d.,]+ XEL a day/);
  // Seven rows, today last, with its 09–15 hours filled.
  const cells = view.container.querySelectorAll("[role=img] .grid-cols-24");
  assert.equal(cells.length, 7);
  const todayCells = [...cells[6].children];
  assert.equal(todayCells.filter((c) => /: 1 h$/.test(c.getAttribute("title") ?? "")).length, 6, "six full hours");
  assert.match(todayCells[9].getAttribute("title") ?? "", /09:00: 1 h$/);
  assert.match(todayCells[15].getAttribute("title") ?? "", /15:00: 0 min$/);
  await interact(() => getByText(view.container, "Show as table").click());
  assert.match(view.text(), /6 h09–15/);
  await interact(() => getByText(view.container, "24 h", "button").click());
  await settle();
  assert.equal(view.container.querySelectorAll("[role=img] .grid-cols-24").length, 2, "a day's range shows yesterday and today");
  assert.match(view.text(), /25% of 24 h/);
  const csv = getByText(view.container, "Download as CSV", "a");
  assert.equal(csv.getAttribute("href"), `/api/v1/activity.csv?address=${encodeURIComponent(ADDRESS)}&worker=rig1&range=24h`, "the rig and range shown");
});

test("an address with no work yet: dashes, not zeros that look measured", async () => {
  fakeApi({
    [`/api/v1/activity?address=${encodeURIComponent(ADDRESS)}&range=7d`]: { ...week, onMinutes: 0, dutyCycle: 0, averageOnMinutesPerDay: 0,
      hashrateWhileOn: null, expectedBlocks: 0, foundBlocks: 0, luck: null, stretches: [] },
    "/api/v1/overview": { network: { difficulty: "250000000" }, node: { miner_reward: "30000000" } },
  });
  const view = await render(h(ActivityCard, { address: ADDRESS }));
  await settle();
  assert.match(view.text(), /When this address was mining/);
  assert.match(view.text(), /Hashrate while on—/);
  assert.doesNotMatch(view.text(), /around the clock/);
});
