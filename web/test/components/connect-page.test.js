// The Connect page: a visitor types their own address, and every setting and command uses it; once a worker on that address
// connects, it is listed.
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { createElement as h } from "react";
import { cleanup, fakeApi, interact, render, settle } from "../dom/render.js";
import Connect from "../../src/pages/Connect.jsx";

afterEach(cleanup);

const MINE = `xel:${"m".repeat(59)}`;
fakeApi({
  "/api/v1/connect": { address: `xel:${"o".repeat(59)}`, network: "mainnet", host: "mine.example.org", stratumPort: 3333, getworkPort: 8090, tlsPort: 3334, reachableFromNetwork: true, publicMode: true, view: "public" },
  "/api/v1/front-door": { configured: false },
  [`/api/v1/miners/${encodeURIComponent(MINE)}`]: { address: MINE, workers: [{ name: "rig7", lastSeen: new Date().toISOString() }] },
});

/** @param {HTMLInputElement} input @param {string} value */
function type(input, value) {
  const setter = /** @type {(v: string) => void} */ (Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set);
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

test("a visitor's own address goes into the settings and commands, and their worker shows once it connects", async () => {
  const view = await render(h(Connect));
  await settle();
  assert.doesNotMatch(view.text(), /x{3}o{10}/, "a visitor does not get the operator's address");
  assert.match(view.text(), /xel:YOUR_ADDRESS/);
  const input = /** @type {HTMLInputElement} */ (view.container.querySelector("#connect-address"));
  await interact(() => type(input, "xel:typo"));
  assert.match(view.text(), /does not look like a mainnet address/);
  await interact(() => type(input, MINE));
  await settle();
  assert.ok(view.text().includes(`-u ${MINE}`), "the Rigel command uses the typed address");
  assert.match(view.text(), /rig7/, "the worker on that address is listed");
});

test("a pasted pool address or whole user name is explained, and the dashboard's port is called out", async () => {
  const view = await render(h(Connect));
  await settle();
  assert.match(view.text(), /Not this page's port \(\d+\): that is the dashboard/);
  const input = /** @type {HTMLInputElement} */ (view.container.querySelector("#connect-address"));
  await interact(() => type(input, "stratum+tcp://mine.example.org:3333"));
  assert.match(view.text(), /That is the pool address/);
  await interact(() => type(input, `${MINE}.rig7`));
  await settle();
  assert.match(view.text(), /Only the address is needed here/);
  assert.ok(view.text().includes(`-u ${MINE}`), "the address before the dot is used");
  assert.match(view.text(), /rig7/);
});
