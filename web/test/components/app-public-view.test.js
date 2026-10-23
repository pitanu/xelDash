// A visitor on a public server (XELDASH_PUBLIC_MODE): no administration, no setup guide, a page on how to mine here.
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { createElement as h } from "react";
import { cleanup, fakeApi, render, settle } from "../dom/render.js";
import App from "../../src/App.jsx";

afterEach(cleanup);

const calls = fakeApi({
  "/api/v1/connect": { address: null, network: "mainnet", host: "mine.example.org", stratumPort: 3333, getworkPort: 8090, tlsPort: 3334, reachableFromNetwork: true, publicMode: true, view: "public" },
  "/api/v1/version": { current: "0.2.0", latest: "0.3.0", available: true, url: "https://example.org/release" },
});

/** @param {string} hash */
async function open(hash) {
  window.location.hash = hash;
  const view = await render(h(App));
  await settle();
  return view;
}

/** @param {HTMLElement} container */
// The top menu (the phone's tab bar repeats the same links).
const navLinks = (container) => [...container.querySelectorAll("nav.topnav a")].map((a) => a.textContent);

test("the menu offers the public pages, Mine here and Settings, and none of the operator's", async () => {
  const view = await open("#/");
  assert.deepEqual(navLinks(view.container), ["Overview", "Miners", "Blocks", "Health", "Mine here", "Settings"]);
});

test("a visitor's Settings are this browser's appearance only: no alerts, node or mining settings", async () => {
  const view = await open("#/settings");
  assert.match(view.text(), /Appearance/);
  assert.match(view.text(), /Colour theme/);
  assert.match(view.text(), /Saved in this browser only/);
  assert.doesNotMatch(view.text(), /Alerts|Where to send alerts|Default payout|daemon|Unlock changes|Backup/i);
});

for (const page of ["/nodes", "/node-data", "/setup"]) {
  test(`#${page} is not available to a visitor`, async () => {
    const view = await open(`#${page}`);
    assert.match(view.text(), /Not available here/);
    assert.match(view.text(), /administration is only open to its operator/);
  });
}

test("a visitor is never told to update xelDash, and nothing asks node administration for anything", async () => {
  const view = await open("#/");
  assert.doesNotMatch(view.text(), /is available \(you have/);
  for (const page of ["#/settings", "#/nodes", "#/setup", "#/health", "#/connect"]) {
    window.location.hash = page;
    await settle();
  }
  assert.deepEqual(calls.filter((c) => c.path.startsWith("/api/v1/node/")).map((c) => c.path), []);
  await view.unmount();
});
