// The operator's own dashboard, and what the page shows before it knows which kind of server it is on.
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { createElement as h } from "react";
import { cleanup, fakeApi, render, settle } from "../dom/render.js";
import App from "../../src/App.jsx";

afterEach(cleanup);

/** @type {(value: unknown) => void} */
let answerConnect = () => {};
const connectAnswer = new Promise((resolve) => (answerConnect = resolve));
fakeApi({
  "/api/v1/connect": () => connectAnswer,
  "/api/v1/version": { current: "0.2.0", latest: "0.3.0", available: true, url: "https://example.org/release" },
});

/** @param {HTMLElement} container */
// The top menu (the phone's tab bar repeats the same links).
const navLinks = (container) => [...container.querySelectorAll("nav.topnav a")].map((a) => a.textContent);

test("until the kind of server is known, operator links and pages stay hidden; then the full menu appears", async () => {
  window.location.hash = "#/settings";
  const view = await render(h(App));
  assert.deepEqual(navLinks(view.container), ["Overview", "Miners", "Blocks", "Health"]);
  assert.equal(view.container.querySelector("main")?.textContent, "", "the operator page does not flash up");
  assert.doesNotMatch(view.text(), /Not available here/, "nor does the public refusal");

  answerConnect({ address: null, network: "mainnet", host: null, stratumPort: 3333, getworkPort: 8090, tlsPort: null, reachableFromNetwork: false, publicMode: false, view: "operator" });
  await settle();
  assert.deepEqual(navLinks(view.container), ["Overview", "Miners", "Blocks", "Health", "Nodes", "Settings"]);
  assert.doesNotMatch(view.text(), /Not available here/);
  assert.match(view.text(), /xelDash 0\.3\.0 is available/, "the operator is told about updates");
});

test("the current section is marked in the menu, a worker page under Miners", async () => {
  window.location.hash = "#/miner/xel%3Aabc/worker/rig1";
  const view = await render(h(App));
  const current = [...view.container.querySelectorAll("nav.topnav a[aria-current=page]")].map((a) => a.textContent);
  assert.deepEqual(current, ["Miners"]);
});

test("a mistyped link, or one with a broken %-escape, shows Page not found instead of failing", async () => {
  for (const hash of ["#/nope", "#/miner/%E0%A4%A", "#/miner/xel%3Aabc/worker/%ZZ"]) {
    window.location.hash = hash;
    const view = await render(h(App));
    assert.match(view.text(), /Page not found/, hash);
    await view.unmount();
  }
});
