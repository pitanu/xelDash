// The Nodes page: both nodes' versions, a card for the chosen node with its state and controls, locked until the admin token is
// entered, and choosing the other node.
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { createElement as h } from "react";
import { cleanup, fakeApi, getByText, interact, render, settle } from "../dom/render.js";
import NodeData from "../../src/pages/NodeData.jsx";

afterEach(cleanup);

const node = (/** @type {string} */ id, /** @type {string[]} */ installed) => ({
  id, present: true, state: "running", dataPresent: true, staged: false, phase: "idle", previousBytes: 0, binary: "1.25.0", pending: null,
  installed, lastResult: { at: "2026-09-28T22:18:01Z", outcome: "applied", message: "1.25.0" },
  running: { version: "1.25.0-b149b57a", height: 8340581, topoheight: 9644033, averageBlockTimeMs: 4560, peers: 9, synced: true },
});
const snapshot = { network: "mainnet", officialAvailable: true, official: { status: 200, size: 9_900_000_000, lastModified: "Tue, 27 Oct 2026 00:00:00 GMT", checkedAt: 0 },
  state: { phase: "idle", source: null, bytes: 0, total: null, startedAt: null, note: null, error: null, sha256: null, checksumMatches: null },
  dataPresent: true, staged: false, previous: false, bootstrapping: false,
  disk: { free: 130_000_000_000, total: 1_000_000_000_000, source: "computer", virtualized: true }, node: "daemon", actionsEnabled: true, auto: true };

function api() {
  return fakeApi({
    "/api/v1/node/nodes": { actionsEnabled: true, nodes: [node("daemon", ["1.25.0"]), node("daemon2", ["1.25.0", "1.24.0"])],
      upgrade: { phase: "idle", target: null, trigger: null, steps: [], startedAt: null, finishedAt: null, error: null } },
    "/api/v1/node/releases": { supported: true, platform: "x86_64-unknown-linux-gnu", available: true,
      releases: [{ version: "1.25.0", publishedAt: "2026-08-26T21:23:43Z", url: "https://github.com/xelis-project/xelis-blockchain/releases/tag/v1.25.0" }] },
    "/api/v1/node/snapshot/status": snapshot,
    "/api/v1/node/auto-update": { enabled: false, available: true, actionsEnabled: true },
    "/api/v1/node/scheduled-upgrade": { pending: null },
    "/api/v1/status": { node: { network: "mainnet", height: 8340581 }, nodes: [], services: {}, bans: [] },
  });
}

test("both nodes' versions, the chosen node's state, and controls locked until the admin token is given", async () => {
  api();
  const view = await render(h(NodeData));
  await settle();
  const text = view.text();
  assert.match(text, /^Nodes/, "two nodes: plural");
  assert.match(text, /Daemon version/);
  assert.match(text, /daemon1\.25\.0-b149b57a/);
  assert.match(text, /daemon21\.25\.0-b149b57a/);
  assert.match(text, /Node daemon/);
  assert.match(text, /Running/);
  // Without the token there is nothing to press: only a place to enter it.
  assert.equal([...view.container.querySelectorAll("button")].filter((b) => /^(Restart|Stop)$/.test(b.textContent ?? "")).length, 0,
    "locked: no restart or stop without the admin token");
  assert.ok(view.container.querySelector("input[type=password]"), "a place to enter the admin token");
  assert.match(text, /9[.,]9 GB/, "the official snapshot's size");
});

test("with the admin token, the running node can be restarted or stopped", async () => {
  sessionStorage.setItem("xeldash.adminToken", "admintoken0123456789abcdef");
  try {
    api();
    const view = await render(h(NodeData));
    await settle();
    assert.ok(getByText(view.container, "Restart", "button"));
    assert.ok(getByText(view.container, "Stop", "button"));
    assert.match(view.text(), /Lock changes/);
  } finally {
    sessionStorage.removeItem("xeldash.adminToken");
  }
});

test("choosing the other node shows its card", async () => {
  api();
  const view = await render(h(NodeData));
  await settle();
  await interact(() => getByText(view.container, "daemon2", "[aria-pressed]").click());
  await settle();
  assert.match(view.text(), /Node daemon2/);
});
