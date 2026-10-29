import test, { afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { createElement as h } from "react";
import { cleanup, fakeApi, getByText, interact, render, type } from "../dom/render.js";
import Setup from "../../src/pages/Setup.jsx";
import { consumeTokenFromUrl } from "../../src/session-token.js";
import { TOKEN_KEY } from "../../src/components/AdminUnlock.jsx";

afterEach(async () => {
  await cleanup();
  mock.timers.reset();
  sessionStorage.clear();
});

const ADDRESS = "xel:" + "a".repeat(59);
const TOKEN = "t".repeat(32);

const status = ({ node = /** @type {any} */ ({ network: "mainnet", height: 3_100_000, topoheight: 3_200_000, networkTopoheight: 3_200_000, peers: 12, syncing: false }), stratum = { ok: true, paused: false } } = {}) =>
  ({ node, services: { stratum, api: { ok: true }, database: { ok: true } } });
const connect = (address = /** @type {string | null} */ (null)) =>
  ({ address, network: "mainnet", host: null, stratumPort: 3333, getworkPort: 8090, tlsPort: null, reachableFromNetwork: false, publicMode: false, view: "operator" });

/** Everything the setup page asks for, for a node that is ready and a server nobody has mined on yet; `overrides` change any of it. */
function routes(overrides = {}) {
  return {
    "/api/v1/status": status(),
    "/api/v1/miners": { miners: [] },
    "/api/v1/node/snapshot/status": { bootstrapping: false, state: { phase: "idle" } },
    "/api/v1/connect": connect(),
    "/api/v1/problems": { problems: [] },
    "/api/v1/front-door": { configured: false },
    "GET /api/v1/node/mining-address": { address: null, prefix: "xel", actionsEnabled: true },
    ...overrides,
  };
}

/** The four steps as [title, marker, headline] text, in order. @param {HTMLElement} container */
function steps(container) {
  return [...container.querySelectorAll("ol > li")].map((li) => ({
    marker: li.querySelector("[aria-label]")?.getAttribute("aria-label"),
    text: (li.textContent ?? "").replace(/\s+/g, " "),
  }));
}

/** A number as the page shows it: in the computer's locale, like formatInteger, with spaces evened out like steps(). @param {number} n */
const num = (n) => n.toLocaleString().replace(/\s+/g, " ");

test("a ready node with no miner yet: step 1 done, the address asked for, and the first miner awaited", async () => {
  fakeApi(routes());
  const view = await render(h(Setup));
  const [network, address, miner, share] = steps(view.container);
  assert.equal(network.marker, "Done");
  assert.ok(network.text.includes(`Block ${num(3_100_000)}, 12 other nodes connected.`), network.text);
  assert.equal(address.marker, "Not started");
  assert.match(address.text, /Add your wallet address/);
  assert.equal(miner.marker, "In progress");
  assert.match(miner.text, /Waiting for your first miner/);
  assert.equal(share.marker, "Not started");
  assert.match(view.text(), /1 of 4 done/);
  assert.match(view.text(), /Get started/);
});

test("while the snapshot downloads, step 1 shows how much has arrived, with a progress bar", async () => {
  fakeApi(routes({
    "/api/v1/status": status({ node: null, stratum: { ok: true, paused: true } }),
    "/api/v1/node/snapshot/status": { bootstrapping: true, state: { phase: "downloading", bytes: 2_500_000_000, total: 10_000_000_000 } },
  }));
  const view = await render(h(Setup));
  const [network, , miner] = steps(view.container);
  assert.equal(network.marker, "In progress");
  assert.match(network.text, /Downloading a snapshot of the blockchain/);
  assert.match(network.text, /of 10/);
  const bar = view.container.querySelector("ol > li [role=progressbar]");
  assert.equal(bar?.getAttribute("aria-valuenow"), "25");
  assert.match(miner.text, /Ready once the network is connected/);
});

test("the time left is estimated from how fast the download goes, once there are 20 seconds to go on", async () => {
  mock.timers.enable({ apis: ["setInterval", "Date"], now: Date.parse("2026-10-13T12:00:00Z") });
  let bytes = 1_000_000_000;
  fakeApi(routes({
    "/api/v1/status": status({ node: null, stratum: { ok: true, paused: true } }),
    // 50 MB a second: every 4-second poll has 200 MB more.
    "/api/v1/node/snapshot/status": () => ({ bootstrapping: true, state: { phase: "downloading", bytes: (bytes += 200_000_000), total: 10_000_000_000 } }),
  }));
  const view = await render(h(Setup));
  assert.doesNotMatch(view.text(), /left/, "no guess from a single reading");
  for (let i = 0; i < 6; i++) await interact(() => mock.timers.tick(4_000));
  // 10 GB - 2.4 GB at 50 MB/s is about 152 s.
  assert.match(steps(view.container)[0].text, /About 3 min left/);
});

test("catching up shows how far behind the node is, and how far along", async () => {
  fakeApi(routes({
    "/api/v1/status": status({ node: { network: "mainnet", height: 1_500_000, topoheight: 1_600_000, networkTopoheight: 3_200_000, peers: 8, syncing: true }, stratum: { ok: true, paused: true } }),
  }));
  const view = await render(h(Setup));
  const text = steps(view.container)[0].text;
  assert.ok(text.includes(`Catching up with the network${num(1_600_000)} blocks behind (50% done).`), text);
});

test("a node with no peers is pointed at the internet connection", async () => {
  fakeApi(routes({ "/api/v1/status": status({ node: { network: "mainnet", height: 1, topoheight: 1, networkTopoheight: 0, peers: 0, syncing: false }, stratum: { ok: true, paused: true } }) }));
  const view = await render(h(Setup));
  assert.match(steps(view.container)[0].text, /Looking for other XELIS nodes.*check your internet connection/);
});

test("with an address saved, a miner connected and shares accepted, every step is done", async () => {
  fakeApi(routes({
    "/api/v1/connect": connect(ADDRESS),
    "/api/v1/miners": { miners: [{ address: ADDRESS, accepted1h: "42" }] },
  }));
  const view = await render(h(Setup));
  assert.deepEqual(steps(view.container).map((s) => s.marker), ["Done", "Done", "Done", "Done"]);
  assert.match(view.text(), /4 of 4 done/);
  assert.match(view.text(), /42 accepted in the last hour\./);
  assert.match(view.text(), /xelDash is set up and a miner is connected/);
  assert.ok(view.text().includes(`rigel -a xelishashv3 -o stratum+tcp://xeldash.test:3333 -u ${ADDRESS} -w rig1`));
});

test("the address field stays locked until the admin token is checked, and a wrong token says so", async () => {
  const calls = fakeApi(routes({
    "POST /api/v1/node/token/check": () => ({ status: 401, body: { error: "unauthorized" } }),
  }));
  const view = await render(h(Setup));
  const field = /** @type {HTMLInputElement} */ (getByText(view.container, "Your XELIS address"));
  assert.equal(field.disabled, true);
  await type(/** @type {HTMLInputElement} */ (getByText(view.container, "Admin token")), "not-the-token");
  await interact(() => getByText(view.container, "Unlock").click());
  assert.match(view.text(), /That token is not right\. Check XELDASH_ADMIN_TOKEN in \.env\./);
  assert.equal(field.disabled, true);
  assert.equal(sessionStorage.getItem(TOKEN_KEY), null, "a refused token is not kept");
  assert.ok(calls.some((c) => c.method === "POST" && c.path === "/api/v1/node/token/check"));
});

test("the installer's token in the link unlocks the page, and leaves the address bar", async () => {
  window.history.replaceState(null, "", `/#/setup?token=${TOKEN}`);
  consumeTokenFromUrl();
  assert.equal(window.location.hash, "#/setup");
  assert.equal(sessionStorage.getItem(TOKEN_KEY), TOKEN);

  fakeApi(routes());
  const view = await render(h(Setup));
  const field = /** @type {HTMLInputElement} */ (getByText(view.container, "Your XELIS address"));
  assert.equal(field.disabled, false);
  assert.equal(view.container.querySelector("input[type=password]"), null, "no token is asked for");
});

test("an address the node turns down shows its reason, and nothing is saved", async () => {
  sessionStorage.setItem(TOKEN_KEY, TOKEN);
  const calls = fakeApi(routes({
    "PUT /api/v1/node/mining-address": { status: 422, body: { error: "This is a testnet address; this server is on mainnet." } },
  }));
  const view = await render(h(Setup));
  await type(/** @type {HTMLInputElement} */ (getByText(view.container, "Your XELIS address")), "xet:abc");
  await interact(() => getByText(view.container, "Save address").click());
  assert.equal(view.container.querySelector("[role=alert]")?.textContent, "This is a testnet address; this server is on mainnet.");
  const put = calls.find((c) => c.method === "PUT");
  assert.deepEqual(put?.body, { address: "xet:abc" });
  assert.match(steps(view.container)[1].text, /Add your wallet address/);
});

test("a saved address moves step 2 to done and shows it with a way to change it", async () => {
  sessionStorage.setItem(TOKEN_KEY, TOKEN);
  let saved = /** @type {string | null} */ (null);
  fakeApi(routes({
    "/api/v1/connect": () => connect(saved),
    "PUT /api/v1/node/mining-address": ({ body }) => {
      saved = body.address;
      return { address: saved };
    },
  }));
  const view = await render(h(Setup));
  await type(/** @type {HTMLInputElement} */ (getByText(view.container, "Your XELIS address")), ADDRESS);
  await interact(() => getByText(view.container, "Save address").click());
  const [, address] = steps(view.container);
  assert.equal(address.marker, "Done");
  assert.ok(address.text.includes(ADDRESS));
  assert.ok(getByText(view.container, "Change"));
});

test("a token the server no longer accepts locks the page again and says why", async () => {
  sessionStorage.setItem(TOKEN_KEY, TOKEN);
  fakeApi(routes({ "PUT /api/v1/node/mining-address": { status: 401, body: { error: "unauthorized" } } }));
  const view = await render(h(Setup));
  await type(/** @type {HTMLInputElement} */ (getByText(view.container, "Your XELIS address")), ADDRESS);
  await interact(() => getByText(view.container, "Save address").click());
  assert.match(view.text(), /The admin token was refused, so nothing was changed\./);
  assert.equal(sessionStorage.getItem(TOKEN_KEY), null);
  assert.equal(/** @type {HTMLInputElement} */ (getByText(view.container, "Your XELIS address")).value, ADDRESS, "what was typed is kept");
});

test("without an admin token configured, the page explains how to turn changes on", async () => {
  fakeApi(routes({ "GET /api/v1/node/mining-address": { address: null, prefix: "xel", actionsEnabled: false } }));
  const view = await render(h(Setup));
  assert.match(view.text(), /Changes are off/);
  assert.match(view.text(), /Set XELDASH_ADMIN_TOKEN in \.env/);
});

test("the connection settings switch between miners, and say when getwork is off", async () => {
  fakeApi(routes({ "/api/v1/connect": { ...connect(ADDRESS), getworkPort: null } }));
  const view = await render(h(Setup));
  assert.match(view.text(), /Right now only this computer can connect\./);
  await interact(() => getByText(view.container, "xelis_miner", "[aria-pressed]").click());
  assert.match(view.text(), /Getwork is switched off on this server/);
  await interact(() => getByText(view.container, "Other", "[aria-pressed]").click());
  assert.ok(view.text().includes(`${ADDRESS}.rig1`));
});
