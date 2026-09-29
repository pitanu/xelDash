import { createServer } from "node:http";
import { MiningFallback } from "./fallback.js";
import { closeEvents, recordEvent } from "./events.js";
import { Node } from "./nodes.js";
import { Releases } from "./releases.js";
import { AutoUpdate } from "./autoupdate.js";
import { ScheduledUpgrade } from "./schedule.js";
import { RollingUpgrade, nodeView } from "./upgrade.js";
import { message, tokensMatch } from "./snapshot.js";

const port = Number.parseInt(process.env.SNAPSHOT_PORT ?? "8095", 10);
const network = (process.env.XELIS_NETWORK ?? "devnet").toLowerCase();
const MIN_TOKEN_LENGTH = 20;
const configuredToken = process.env.XELDASH_ADMIN_TOKEN?.trim() || null;
// A short token could be guessed over the LAN; such a token leaves actions off.
const adminToken = configuredToken && configuredToken.length >= MIN_TOKEN_LENGTH ? configuredToken : null;
if (configuredToken && !adminToken) {
  console.warn(`XELDASH_ADMIN_TOKEN is shorter than ${MIN_TOKEN_LENGTH} characters, so node changes stay off. Use e.g. openssl rand -hex 24.`);
}
const auto = (process.env.XELIS_SNAPSHOT_AUTO ?? "false").toLowerCase() === "true";
// The XELIS team publishes a daily snapshot for mainnet only.
const official = network === "mainnet";
const snapshotUrl = process.env.XELIS_SNAPSHOT_URL?.trim() || (official ? "https://node.xelis.io/files/mainnet.zip" : null);
const checksumUrl = process.env.XELIS_SNAPSHOT_CHECKSUM_URL?.trim()
  || (official && !process.env.XELIS_SNAPSHOT_URL ? "https://node.xelis.io/files/mainnet_checksum.txt" : null);
const MAX_UPLOAD_BYTES = 200e9;

// The nodes in this stack, each managed through its own data volume. daemon2 (the redundant
// profile) is listed once it has started at least once.
const nodes = [
  new Node({ id: "daemon", dataDir: process.env.DATA_DIR ?? "/data", network, snapshotUrl, checksumUrl }),
  new Node({ id: "daemon2", dataDir: process.env.DATA2_DIR ?? "/data2", network, snapshotUrl, checksumUrl }),
];
const primary = nodes[0];
const releases = new Releases();
const upgrade = new RollingUpgrade({ releases });
const configDir = process.env.CONFIG_DIR ?? "/config";
const fallback = new MiningFallback({ configDir, network, env: process.env });
for (const node of nodes) await node.snapshots.init().catch((error) => console.warn(`${node.id}: ${message(error)}`));
await fallback.init();

/**
 * The node a request is about (?node=, the first node by default). Unknown nodes, and daemon2
 * before it has ever started, are not found.
 * @param {URLSearchParams} params @param {string} [name]
 */
function nodeFrom(params, name = "node") {
  const id = params.get(name) ?? primary.id;
  const node = nodes.find((n) => n.id === id);
  return node && (node === primary || node.present) ? node : null;
}

/** One heavy disk operation at a time across all nodes (download, upload, unpack or copy). */
/** Present nodes in update order: every other node first, the usual mining node last. */
function updateOrder() {
  const present = nodes.filter((n) => n === primary || n.present);
  return [...present.filter((n) => n !== primary), primary];
}

// Optional (off by default): keep both local nodes on the latest release automatically.
// A switch at a block height, for network upgrades.
const scheduled = new ScheduledUpgrade({ configDir, releases, upgrade, order: updateOrder });
const autoUpdate = new AutoUpdate({
  configDir, releases, upgrade, nodes: () => nodes, order: updateOrder, scheduled: () => scheduled.pending(), env: process.env,
});

function busyNode() {
  return nodes.find((node) => node.snapshots.busy) ?? null;
}

/** @param {import("node:http").ServerResponse} response */
function refuseIfBusy(response) {
  const busy = busyNode();
  if (busy) send(response, 409, { error: `${busy.id} is busy (${busy.snapshots.state.phase}); wait for it to finish` });
  return Boolean(busy);
}
let ready = false;

/** Read a small JSON body (settings), refusing anything large. @param {import("node:http").IncomingMessage} request */
async function readJson(request) {
  let text = "";
  for await (const chunk of request) {
    text += chunk;
    if (text.length > 100_000) throw new Error("Request body too large");
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** @param {import("node:http").ServerResponse} response @param {number} status @param {unknown} body */
function send(response, status, body) {
  const text = JSON.stringify(body);
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(text);
}

/**
 * Every action changes the node's data, so all of them need the admin token. Without one
 * configured, the page only shows status.
 * @param {import("node:http").IncomingMessage} request
 */
function authorized(request) {
  if (!adminToken) return false;
  // Its own header, not Authorization: a login proxy in front (docker/proxy) uses
  // Authorization for the browser's password. As a custom header it also means other
  // websites cannot send it without a CORS preflight, which is never allowed.
  const header = request.headers["x-admin-token"];
  return typeof header === "string" && tokensMatch(header, adminToken);
}

const server = createServer(async (request, response) => {
  /** @type {string} */
  let path;
  /** @type {URLSearchParams} */
  let params;
  try {
    const url = new URL(request.url ?? "/", "http://localhost");
    path = url.pathname.replace(/^\/api\/v1\/node/, "") || "/";
    params = url.searchParams;
  } catch {
    send(response, 400, { error: "bad_request" });
    return;
  }
  try {
    if (request.method === "GET" && path === "/nodes") {
      const list = await Promise.all(nodes.filter((n) => n === primary || n.present).map(async (n) => ({
        ...(await n.status()),
        ...(await releases.nodeStatus(n)),
        running: await nodeView(n.id),
      })));
      send(response, 200, { nodes: list, actionsEnabled: Boolean(adminToken), upgrade: upgrade.state });
      return;
    }
    if (request.method === "GET" && path === "/scheduled-upgrade") {
      send(response, 200, await scheduled.status());
      return;
    }
    if (request.method === "GET" && path === "/auto-update") {
      send(response, 200, { ...(await autoUpdate.status()), actionsEnabled: Boolean(adminToken) });
      return;
    }
    if (request.method === "GET" && path === "/releases") {
      const list = await releases.list().catch((error) => {
        console.warn(`Release list unavailable: ${message(error)}`);
        return null;
      });
      send(response, 200, {
        supported: releases.platform !== null,
        platform: releases.platform,
        available: list !== null,
        releases: (list ?? []).map((r) => ({ version: r.version, publishedAt: r.publishedAt, url: r.url })),
      });
      return;
    }
    const node = nodeFrom(params) ?? primary;
    if (params.has("node") && !nodeFrom(params)) {
      send(response, 404, { error: "Unknown node" });
      return;
    }
    const manager = node.snapshots;
    const settings = node.settings;
    if (request.method === "GET" && path === "/healthz") {
      send(response, ready ? 200 : 503, { ready });
      return;
    }
    if (request.method === "GET" && path === "/snapshot/status") {
      send(response, 200, { ...(await manager.status()), node: node.id, actionsEnabled: Boolean(adminToken), auto: auto && node === primary });
      return;
    }
    if (request.method === "GET" && path === "/settings") {
      send(response, 200, { ...(await settings.status()), node: node.id, actionsEnabled: Boolean(adminToken) });
      return;
    }
    if (request.method === "GET" && path === "/fallback") {
      send(response, 200, { ...(await fallback.status()), actionsEnabled: Boolean(adminToken) });
      return;
    }
    if (!adminToken) {
      send(response, 403, { error: "Node changes are off. Set XELDASH_ADMIN_TOKEN in .env to enable them." });
      return;
    }
    if (!authorized(request)) {
      send(response, 401, { error: "Wrong or missing admin token" });
      return;
    }

    // Lets the dashboard check a token when it is entered, not on the first change.
    if (request.method === "POST" && path === "/token/check") {
      send(response, 200, { ok: true });
      return;
    }
    if (request.method === "POST" && ["/control/stop", "/control/start", "/control/restart"].includes(path)) {
      if (path === "/control/stop") await node.stop();
      else if (path === "/control/start") await node.start();
      else await node.restart();
      recordEvent(`node_${path.slice("/control/".length)}_requested`, { node: node.id });
      send(response, 202, { ok: true, state: node.state });
      return;
    }
    if (request.method === "POST" && path === "/scheduled-upgrade") {
      const body = await readJson(request);
      if (typeof body?.version !== "string" || !/^[0-9]+[.][0-9]+[.][0-9]+$/.test(body.version) || !Number.isSafeInteger(body?.height)) {
        send(response, 400, { error: "Send { \"version\": \"1.26.0\", \"height\": 7900000 }" });
        return;
      }
      send(response, 200, await scheduled.create(body.version, body.height));
      return;
    }
    if (request.method === "DELETE" && path === "/scheduled-upgrade") {
      await scheduled.cancel();
      send(response, 200, { ok: true });
      return;
    }
    if (request.method === "PUT" && path === "/auto-update") {
      const body = await readJson(request);
      if (typeof body?.enabled !== "boolean") {
        send(response, 400, { error: "Send { \"enabled\": true | false }" });
        return;
      }
      send(response, 200, await autoUpdate.setEnabled(body.enabled));
      return;
    }
    if (request.method === "POST" && path === "/upgrade") {
      const body = await readJson(request);
      const target = body?.version;
      if (typeof target !== "string" || !(target === "image" || /^\d+\.\d+\.\d+$/.test(target))) {
        send(response, 400, { error: "Send { \"version\": \"1.26.0\" | \"image\", \"nodes\": [\"daemon2\"] }" });
        return;
      }
      if (target !== "image") await releases.find(target);
      // The whole stack by default: every other node first, the usual mining node last.
      const order = updateOrder();
      const chosen = Array.isArray(body.nodes) ? order.filter((n) => body.nodes.includes(n.id)) : order;
      if (chosen.length === 0) {
        send(response, 400, { error: "No such nodes" });
        return;
      }
      upgrade.start(chosen, target);
      send(response, 202, { ok: true });
      return;
    }
    if (request.method === "POST" && path === "/copy") {
      const source = nodeFrom(params, "from");
      if (!source || source === node) {
        send(response, 400, { error: "Choose another node to copy from (?from=)" });
        return;
      }
      if (refuseIfBusy(response)) return;
      if (source.state !== "running") {
        send(response, 409, { error: `${source.id} is stopped; start it first` });
        return;
      }
      void manager.copyFrom(source).catch(() => {});
      send(response, 202, { ok: true });
      return;
    }
    if (request.method === "PUT" && path === "/snapshot/upload") {
      const size = Number(request.headers["content-length"]);
      if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_UPLOAD_BYTES) {
        send(response, 411, { error: "The upload needs a Content-Length" });
        return;
      }
      if (refuseIfBusy(response)) return;
      // Answered once the file is received and hashed; unpacking continues in the background.
      await manager.upload(request, size).then(
        () => send(response, 200, { ok: true }),
        (error) => send(response, 422, { error: message(error) }),
      );
      return;
    }
    if (request.method === "POST" && path === "/snapshot/download") {
      if (!snapshotUrl) {
        send(response, 409, { error: `No official snapshot is published for ${network}; upload one instead.` });
        return;
      }
      if (refuseIfBusy(response)) return;
      void manager.download().catch(() => {});
      send(response, 202, { ok: true });
      return;
    }
    if (request.method === "POST" && path === "/snapshot/cancel") {
      send(response, 200, { cancelled: manager.cancel() });
      return;
    }
    if (request.method === "POST" && path === "/snapshot/restart") {
      await manager.requestRestart();
      send(response, 202, { ok: true });
      return;
    }
    if (request.method === "POST" && path === "/snapshot/discard-staged") {
      await manager.discardStaged();
      send(response, 200, { ok: true });
      return;
    }
    if (request.method === "POST" && path === "/snapshot/discard-previous") {
      await manager.discardPrevious();
      send(response, 200, { ok: true });
      return;
    }
    if (request.method === "PUT" && path === "/settings") {
      const body = await readJson(request);
      if (!body || typeof body.values !== "object" || body.values === null || Array.isArray(body.values)) {
        send(response, 400, { error: "Send { \"values\": { \"flag\": value } }" });
        return;
      }
      send(response, 200, await settings.save(body.values));
      return;
    }
    if (request.method === "POST" && path === "/settings/apply") {
      // The node checks and applies the saved settings as it restarts.
      await settings.requestRestart();
      send(response, 202, { ok: true });
      return;
    }
    if (request.method === "PUT" && path === "/fallback") {
      const body = await readJson(request);
      if (typeof body?.enabled !== "boolean") {
        send(response, 400, { error: "Send { \"enabled\": true | false }" });
        return;
      }
      send(response, 200, await fallback.write(body.enabled));
      return;
    }
    if (request.method === "POST" && path === "/settings/discard") {
      await settings.discardPending();
      send(response, 200, { ok: true });
      return;
    }
    send(response, 404, { error: "not_found" });
  } catch (error) {
    send(response, 409, { error: message(error) });
  }
});
// Uploads of several gigabytes take a while; do not time the request out.
server.requestTimeout = 0;

server.listen(port, "0.0.0.0", async () => {
  console.info(`xelDash node-admin on :${port} (network ${network}, snapshot source: ${snapshotUrl ?? "none published for this network"})`);
  if (!adminToken) console.info("Snapshot actions are off; set XELDASH_ADMIN_TOKEN to enable uploads and downloads.");
  // Automatic snapshots are for a new stack's first node; a second node can copy from it.
  if (auto && snapshotUrl) {
    if (await primary.snapshots.bootstrap()) console.info("No chain data yet: downloading the snapshot before the node starts.");
  } else {
    await primary.snapshots.clearBootstrap();
  }
  autoUpdate.start();
  scheduled.start();
  ready = true;
});

async function shutdown() {
  autoUpdate.stop();
  scheduled.stop();
  void closeEvents();
  for (const node of nodes) node.snapshots.shutdown();
  server.close();
}
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
