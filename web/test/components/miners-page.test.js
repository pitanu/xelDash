// The Miners page with a few addresses: summary tiles, a card per address with its figures and workers, and a search box.
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { createElement as h } from "react";
import { cleanup, fakeApi, interact, render } from "../dom/render.js";
import Miners from "../../src/pages/Miners.jsx";

afterEach(cleanup);

const A = `xel:${"a".repeat(59)}`;
const B = `xel:${"b".repeat(59)}`;
const now = new Date().toISOString();
const miner = (/** @type {string} */ address, /** @type {string} */ worker) => ({
  address, firstSeen: now, lastSeen: now, luck: null, bestShare: null,
  workers: [{ name: worker, lastSeen: now, hashrate5m: "1000", hashrate1h: "1200", accepted1h: "100", rejected1h: "1", reportedHashrate: null }],
});
fakeApi({
  "/api/v1/miners": { miners: [
    { address: A, lastSeen: now, workers: "2", hashrate1h: "3000", accepted1h: "300", rejected1h: "3", blocks: "4" },
    { address: B, lastSeen: now, workers: "1", hashrate1h: "1000", accepted1h: "100", rejected1h: "1", blocks: "1" },
  ] },
  [`/api/v1/miners/${encodeURIComponent(A)}`]: miner(A, "rig-a"),
  [`/api/v1/miners/${encodeURIComponent(B)}`]: miner(B, "rig-b"),
  [`/api/v1/rewards?range=30d&address=${encodeURIComponent(A)}`]: { range: "30d", points: [{ day: now, blocks: 2, reward: "150000000", expectedBlocks: 1 }] },
  [`/api/v1/rewards?range=30d&address=${encodeURIComponent(B)}`]: { range: "30d", points: [] },
  // A on a quarter of the last day; B never on.
  [`/api/v1/activity?address=${encodeURIComponent(A)}&range=24h`]: { range: "24h", periodMinutes: 1440, onMinutes: 360, dutyCycle: 0.25, stretches: [] },
  [`/api/v1/activity?address=${encodeURIComponent(B)}&range=24h`]: { range: "24h", periodMinutes: 1440, onMinutes: 0, dutyCycle: 0, stretches: [] },
});

test("a few addresses: totals in tiles, and a card per address with its hashrate, blocks, 30-day earnings and workers", async () => {
  const view = await render(h(Miners));
  // The page text runs together: each tile's label, number and detail follow each other.
  const text = view.text();
  assert.match(text, /Miners22 seen in the last 2 minutes/, "how many addresses, and how many seen just now");
  assert.match(text, /Workers3with shares/);
  assert.match(text, /Rejected · 1 h0(\.|,)99%4 of 404 shares/);
  assert.match(text, /rig-a/);
  assert.match(text, /rig-b/);
  assert.match(text, /Earned · 30 d1(\.|,)5 XEL/, "A earned 1.5 XEL");
  assert.match(text, /On · 24 h25%/, "A mined a quarter of the last day");
  assert.match(text, /On · 24 h0[.,]0%/, "B not at all");
  assert.equal(view.container.querySelectorAll(`a[href="#/miner/${encodeURIComponent(A)}"]`).length, 1, "the address links to its page");
});

test("the search box narrows the cards to matching addresses", async () => {
  const view = await render(h(Miners));
  const input = /** @type {HTMLInputElement} */ (view.container.querySelector("input[type=search]"));
  await interact(() => {
    const setter = /** @type {(v: string) => void} */ (Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set);
    setter.call(input, "bbbb");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  assert.doesNotMatch(view.text(), /rig-a/);
  assert.match(view.text(), /rig-b/);
});
