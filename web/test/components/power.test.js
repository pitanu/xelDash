// Electricity per rig (src/power.js, PowerCard, the price in Settings): energy from the time on, cost at the price per kWh, the
// reward its work was expected to find valued at the XEL price, and profit; the rig's watts entered on its page with the admin
// token; a miner's rigs added up; nothing for a public server's visitor.
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { createElement as h } from "react";
import { cleanup, fakeApi, getByText, interact, render, settle } from "../dom/render.js";
import { powerFigures } from "../../src/power.js";
import PowerCard from "../../src/components/PowerCard.jsx";
import PowerPriceSetting from "../../src/components/PowerPriceSetting.jsx";

afterEach(cleanup);

const A = `xel:${"a".repeat(59)}`;
const power = (/** @type {Record<string, number>} */ watts, price = 0.25) => ({ available: true, currency: "eur", pricePerKwh: price, watts, currencies: ["usd", "eur"], actionsEnabled: true });
const activity = (/** @type {number} */ onMinutes, /** @type {number} */ expectedBlocks) => ({ range: "7d", onMinutes, expectedBlocks, stretches: [] });
/** An amount in euros as any locale writes it. @param {string} n e.g. "0.75" */
const eur = (n) => `(?:€\\s?)?${n.replace(".", "[.,]")}(?:\\s?€)?`;
const operator = { address: null, network: "mainnet", publicMode: false, view: "operator" };

test("the figures: 300 W for 10 hours is 3 kWh; 0.1 block of a 1.5 XEL reward at 2 € is 0.30 €", () => {
  const f = powerFigures({ onMinutes: 600, expectedBlocks: 0.1, watts: 300, pricePerKwh: 0.25, rewardAtomic: 150_000_000, xelPrice: 2 });
  assert.equal(f.kwh, 3);
  assert.equal(f.cost, 0.75);
  assert.ok(Math.abs(/** @type {number} */ (f.rewardXel) - 0.15) < 1e-12);
  assert.ok(Math.abs(/** @type {number} */ (f.value) - 0.3) < 1e-12);
  assert.ok(Math.abs(/** @type {number} */ (f.profit) + 0.45) < 1e-12, "a loss");
  assert.ok(Math.abs(/** @type {number} */ (f.perHour?.cost) - 0.075) < 1e-12);
  assert.ok(Math.abs(/** @type {number} */ (f.breakEvenPrice) - 5) < 1e-9, "0.75 € for 0.15 XEL: 5 € a XEL");
  const noPrice = powerFigures({ onMinutes: 600, expectedBlocks: 0.1, watts: 300, pricePerKwh: 0.25, rewardAtomic: 150_000_000, xelPrice: null });
  assert.equal(noPrice.value, null);
  assert.equal(noPrice.profit, null, "no XEL price: a cost but no profit");
  assert.equal(noPrice.cost, 0.75);
  assert.equal(powerFigures({ onMinutes: 0, expectedBlocks: 0, watts: 300, pricePerKwh: null, rewardAtomic: null, xelPrice: null }).perHour, null);
});

test("a rig's page: its cost and profit over the range, and its watts entered with the admin token", async () => {
  sessionStorage.setItem("xeldash.adminToken", "admintoken0123456789abcdef");
  try {
    /** @type {Record<string, number>} */
    const watts = { [`${A}/rig1`]: 300 };
    const calls = fakeApi({
      "/api/v1/connect": operator,
      "/api/v1/node/power": () => power(watts),
      "PUT /api/v1/node/power/worker": ({ body }) => { watts[`${A}/rig1`] = body.watts; return power(watts); },
      "/api/v1/overview": { network: { difficulty: "1" }, node: { miner_reward: "150000000" } },
      [`/api/v1/activity?address=${encodeURIComponent(A)}&worker=rig1&range=7d`]: activity(600, 0.1),
      "/api/v1/price?currency=eur": { enabled: true, price: { price: 2 } },
    });
    const view = await render(h(PowerCard, { address: A, worker: "rig1" }));
    await settle();
    const text = view.text();
    assert.match(text, /Energy3 kWh/);
    assert.match(text, /10 h on at 300 W/);
    assert.match(text, new RegExp(`Cost${eur("0.75")}`));
    assert.match(text, new RegExp(`Expected reward${eur("0.30")}`));
    assert.match(text, /Profit[−-]?s?€?s?[−-]?0[.,]45/);
    assert.match(text, new RegExp(`Breaks even at ${eur("5.00")} per XEL`));
    const field = /** @type {HTMLInputElement} */ (view.container.querySelector("input[aria-label='Power draw in watts']"));
    await interact(() => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      set?.call(field, "450");
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await interact(() => getByText(view.container, "Save", "button").click());
    await settle();
    const put = calls.find((c) => c.method === "PUT");
    assert.deepEqual(put?.body, { address: A, worker: "rig1", watts: 450 });
    assert.match(view.text(), /at 450 W/, "the figures follow the new power draw");
  } finally {
    sessionStorage.removeItem("xeldash.adminToken");
  }
});

test("a miner's page: every rig with a power draw, added up; a rig without one is not guessed at", async () => {
  fakeApi({
    "/api/v1/connect": operator,
    "/api/v1/node/power": power({ [`${A}/rig1`]: 300, [`${A}/rig2`]: 100, "xel:other/rig9": 999 }),
    "/api/v1/overview": { network: { difficulty: "1" }, node: { miner_reward: "150000000" } },
    [`/api/v1/activity?address=${encodeURIComponent(A)}&worker=rig1&range=7d`]: activity(600, 0.1),
    [`/api/v1/activity?address=${encodeURIComponent(A)}&worker=rig2&range=7d`]: activity(1200, 0.1),
    "/api/v1/price?currency=eur": { enabled: true, price: { price: 2 } },
  });
  const view = await render(h(PowerCard, { address: A }));
  await settle();
  const rows = [...view.container.querySelectorAll("tbody tr")].map((r) => (r.textContent ?? "").replace(/\s+/g, " "));
  assert.equal(rows.length, 3, "rig1, rig2 and the total; not another address's rig");
  assert.match(rows[0], new RegExp(`^rig1300 W10 h3 kWh${eur("0.75")}`));
  assert.match(rows[1], new RegExp(`^rig2100 W20 h2 kWh${eur("0.50")}`));
  assert.match(rows[2], new RegExp(`^All5 kWh${eur("1.25")}${eur("0.60")}`));
});

test("no XEL price (testnet, or the price off): the cost alone, said plainly; no electricity price: where to set it", async () => {
  /** @type {number | null} */
  let price = 0.25;
  fakeApi({
    "/api/v1/connect": operator,
    "/api/v1/node/power": () => power({ [`${A}/rig1`]: 300 }, /** @type {any} */ (price)),
    "/api/v1/overview": { network: { difficulty: "1" }, node: { miner_reward: "150000000" } },
    [`/api/v1/activity?address=${encodeURIComponent(A)}&worker=rig1&range=7d`]: activity(600, 0.1),
    "/api/v1/price?currency=eur": { enabled: false, reason: "network", price: null },
  });
  const view = await render(h(PowerCard, { address: A, worker: "rig1" }));
  await settle();
  assert.match(view.text(), /No XEL price here/);
  assert.match(view.text(), new RegExp(`Cost${eur("0.75")}`), "the cost all the same");
  await cleanup();
  price = null;
  const unpriced = await render(h(PowerCard, { address: A, worker: "rig1" }));
  await settle();
  assert.match(unpriced.text(), /Set the price of electricity in Settings/);
  assert.match(unpriced.text(), /Energy3 kWh/, "the energy is known without a price");
});

test("Settings: the price per kWh and its currency, saved with the admin token", async () => {
  const calls = fakeApi({ "/api/v1/node/power": power({}, /** @type {any} */ (null)), "PUT /api/v1/node/power": ({ body }) => ({ ...power({}, body.pricePerKwh), currency: body.currency }) });
  const view = await render(h(PowerPriceSetting, { token: "admintoken0123456789abcdef", onUnauthorized() {} }));
  await settle();
  const field = /** @type {HTMLInputElement} */ (view.container.querySelector("input[aria-label='Price per kWh']"));
  await interact(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(field, "0.31");
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await interact(() => getByText(view.container, "Save", "button").click());
  await settle();
  assert.deepEqual(calls.find((c) => c.method === "PUT")?.body, { currency: "eur", pricePerKwh: 0.31 });
});
