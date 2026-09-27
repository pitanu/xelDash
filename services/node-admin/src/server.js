import { createServer } from "node:http";
import { MiningFallback } from "./fallback.js";
import { DaemonSettings } from "./settings.js";
import { SnapshotManager, message, tokensMatch } from "./snapshot.js";

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

const dataDir = process.env.DATA_DIR ?? "/data";
const manager = new SnapshotManager({ dataDir, network, snapshotUrl, checksumUrl });
const settings = new DaemonSettings({ dataDir });
const fallback = new MiningFallback({ configDir: process.env.CONFIG_DIR ?? "/config", network, env: process.env });
await manager.init();
await fallback.init();
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
  try {
    path = new URL(request.url ?? "/", "http://localhost").pathname.replace(/^\/api\/v1\/node/, "") || "/";
  } catch {
    send(response, 400, { error: "bad_request" });
    return;
  }
  try {
    if (request.method === "GET" && path === "/healthz") {
      send(response, ready ? 200 : 503, { ready });
      return;
    }
    if (request.method === "GET" && path === "/snapshot/status") {
      send(response, 200, { ...(await manager.status()), actionsEnabled: Boolean(adminToken), auto });
      return;
    }
    if (request.method === "GET" && path === "/settings") {
      send(response, 200, { ...(await settings.status()), actionsEnabled: Boolean(adminToken) });
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
    if (request.method === "PUT" && path === "/snapshot/upload") {
      const size = Number(request.headers["content-length"]);
      if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_UPLOAD_BYTES) {
        send(response, 411, { error: "The upload needs a Content-Length" });
        return;
      }
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
      if (manager.busy) {
        send(response, 409, { error: `Another snapshot operation is running (${manager.state.phase})` });
        return;
      }
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
  if (auto && snapshotUrl) {
    if (await manager.bootstrap()) console.info("No chain data yet: downloading the snapshot before the node starts.");
  } else {
    await manager.clearBootstrap();
  }
  ready = true;
});

async function shutdown() {
  manager.shutdown();
  server.close();
}
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
