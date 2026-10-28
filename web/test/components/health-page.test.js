// The Health page for the operator: the summary, a card per node in priority order (the one mining marked, the official fallback
// labelled), Stratum and the database, and the disk; and what changes when a node falls behind or mining pauses.
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { createElement as h } from "react";
import { cleanup, fakeApi, render, settle } from "../dom/render.js";
import Health from "../../src/pages/Health.jsx";

afterEach(cleanup);

const node = (/** @type {string} */ label, /** @type {Record<string, unknown>} */ over = {}) => ({
  label, fallback: false, ok: true, version: "1.25.0-b149b57a", network: "mainnet", height: 8340569, topoheight: 9644020,
  stableheight: 8340545, difficulty: "310688800", mempoolSize: 0, averageBlockTimeMs: 4025, blockTimeTargetMs: 5000, peers: 9,
  maxPeers: 32, bestTopoheight: 9644020, networkTopoheight: 9644020, syncing: false, active: false, updateAvailable: false, ...over,
});
const status = (/** @type {Record<string, unknown>} */ over = {}) => {
  const nodes = [node("daemon", { active: true }), node("daemon2", { peers: 8 }), node("node.xelis.io", { fallback: true, peers: 68, version: "1.25.0-e0f88afb" })];
  return { node: nodes[0], nodes, latestRelease: "1.25.0", bans: [],
    services: { daemon: { ok: true }, database: { ok: true }, stratum: { ok: true, startedAt: new Date().toISOString(), paused: null, node: "daemon" } }, ...over };
};
const connect = { address: null, network: "mainnet", host: null, stratumPort: 3333, getworkPort: 8090, tlsPort: null, reachableFromNetwork: false, publicMode: false, view: "operator" };
const disk = { warnBytes: 21474836480, disks: [{ nodes: ["daemon", "daemon2"], free: 130_000_000_000, total: 1_000_000_000_000, source: "computer", virtualized: true, level: "ok" }] };

test("all well: the summary says so, each node has its card in order, the one mining and the fallback are marked", async () => {
  fakeApi({ "/api/v1/status": status(), "/api/v1/connect": connect, "/api/v1/node/disk": disk, "/api/v1/events": { events: [] },
    "/api/v1/node/cluster": { configured: false }, "/api/v1/front-door": { configured: false }, "/api/v1/problems": { problems: [] } });
  const view = await render(h(Health));
  await settle();
  const text = view.text();
  assert.match(text, /All good/);
  assert.match(text, /Accepting miners/);
  assert.match(text, /Mining through daemon/);
  const order = ["daemon", "daemon2", "node.xelis.io"].map((n) => text.indexOf(`${n}In sync`));
  assert.ok(order.every((i) => i >= 0) && order[0] < order[1] && order[1] < order[2], `nodes in priority order: ${order}`);
  assert.match(text, /Official fallback/);
  assert.match(text, /Manage: restart, versions, snapshots/, "the operator can go to the Nodes page");
  assert.match(text, /121[.,]1 GB free of 931[.,]3 GB/, "free disk space, in the browser's number format");
});

test("a node behind and mining paused: the summary and the cards say what is wrong", async () => {
  const behind = status({
    services: { daemon: { ok: true }, database: { ok: true }, stratum: { ok: true, startedAt: new Date().toISOString(), paused: "syncing", node: null } },
  });
  behind.nodes[0] = node("daemon", { syncing: true, topoheight: 9643000, active: true });
  behind.node = behind.nodes[0];
  fakeApi({ "/api/v1/status": behind, "/api/v1/connect": connect, "/api/v1/node/disk": disk, "/api/v1/events": { events: [] },
    "/api/v1/node/cluster": { configured: false }, "/api/v1/front-door": { configured: false }, "/api/v1/problems": { problems: [] } });
  const view = await render(h(Health));
  await settle();
  const text = view.text();
  assert.doesNotMatch(text, /All good/);
  assert.match(text, /Syncing|Behind|Catching up/i);
  assert.match(text, /Paused/i);
});
