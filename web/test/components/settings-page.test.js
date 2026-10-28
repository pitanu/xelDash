// The Settings page: the operator's groups (Appearance; Mining; Notifications and display) and the cards below them, and a public
// server's visitors, who get only how the dashboard looks and sounds for them, with nothing about mining, alerts or the nodes.
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { createElement as h } from "react";
import { cleanup, fakeApi, render, settle } from "../dom/render.js";
import Settings from "../../src/pages/Settings.jsx";

afterEach(cleanup);

const ADDRESS = `xel:${"a".repeat(59)}`;
const routes = (/** @type {"operator" | "public"} */ view) => ({
  "/api/v1/connect": { address: view === "operator" ? ADDRESS : null, network: "mainnet", host: null, stratumPort: 3333, getworkPort: 8090,
    tlsPort: null, reachableFromNetwork: false, publicMode: view === "public", view },
  "/api/v1/status": { node: { network: "mainnet" }, nodes: [], services: { stratum: { ok: true }, database: { ok: true }, daemon: { ok: true } }, bans: [] },
  "/api/v1/node/fallback": { enabled: true, url: "https://node.xelis.io/json_rpc", actionsEnabled: true },
  "/api/v1/node/mining-address": { address: ADDRESS, source: "setup", actionsEnabled: true },
  "/api/v1/node/auto-update": { enabled: false, available: true, actionsEnabled: true },
  "/api/v1/price": { enabled: false, reason: "off", currencies: ["usd", "eur"], price: null },
});

test("the operator gets the three groups, the payout address, and the cards below them", async () => {
  fakeApi(routes("operator"));
  const view = await render(h(Settings, { publicView: false }));
  await settle();
  const text = view.text();
  for (const group of ["Appearance", "Mining", "Notifications and display"]) assert.match(text, new RegExp(group), group);
  assert.match(text, /Default payout address/);
  assert.match(text, /xel:a{6}/, "the address it mines to");
  assert.match(text, /Fall back to the public node/);
  assert.match(text, /Set up alerts/);
  assert.match(text, /Colour theme/);
  assert.match(text, /Support xelDash/, "mainnet: where to send a thank-you");
});

test("a public server's visitor gets how the dashboard looks and sounds, and nothing of the operator's", async () => {
  fakeApi(routes("public"));
  const view = await render(h(Settings, { publicView: true }));
  await settle();
  const text = view.text();
  assert.match(text, /Saved in this browser only/);
  assert.match(text, /Colour theme/);
  for (const operatorOnly of ["Default payout address", "Fall back to the public node", "Set up alerts", "Where to send alerts", "Backup"]) {
    assert.doesNotMatch(text, new RegExp(operatorOnly), `${operatorOnly} is the operator's`);
  }
});
