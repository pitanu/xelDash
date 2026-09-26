import { createServer } from "node:http";
import { SnapshotManager, message, tokensMatch } from "./snapshot.js";

const port = Number.parseInt(process.env.SNAPSHOT_PORT ?? "8095", 10);
const network = (process.env.XELIS_NETWORK ?? "devnet").toLowerCase();
const adminToken = process.env.XELDASH_ADMIN_TOKEN?.trim() || null;
const auto = (process.env.XELIS_SNAPSHOT_AUTO ?? "false").toLowerCase() === "true";
// The XELIS team publishes a daily snapshot for mainnet only.
const official = network === "mainnet";
const snapshotUrl = process.env.XELIS_SNAPSHOT_URL?.trim() || (official ? "https://node.xelis.io/files/mainnet.zip" : null);
const checksumUrl = process.env.XELIS_SNAPSHOT_CHECKSUM_URL?.trim()
  || (official && !process.env.XELIS_SNAPSHOT_URL ? "https://node.xelis.io/files/mainnet_checksum.txt" : null);
const MAX_UPLOAD_BYTES = 200e9;

const manager = new SnapshotManager({ dataDir: process.env.DATA_DIR ?? "/data", network, snapshotUrl, checksumUrl });
await manager.init();
let ready = false;

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
  const header = request.headers.authorization ?? "";
  return header.startsWith("Bearer ") && tokensMatch(header.slice(7), adminToken);
}

const server = createServer(async (request, response) => {
  const path = new URL(request.url ?? "/", "http://localhost").pathname.replace(/^\/api\/v1\/snapshot/, "") || "/";
  try {
    if (request.method === "GET" && path === "/healthz") {
      send(response, ready ? 200 : 503, { ready });
      return;
    }
    if (request.method === "GET" && path === "/status") {
      send(response, 200, { ...(await manager.status()), actionsEnabled: Boolean(adminToken), auto });
      return;
    }
    if (!adminToken) {
      send(response, 403, { error: "Snapshot actions are off. Set XELDASH_ADMIN_TOKEN in .env to enable them." });
      return;
    }
    if (!authorized(request)) {
      send(response, 401, { error: "Wrong or missing admin token" });
      return;
    }

    if (request.method === "PUT" && path === "/upload") {
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
    if (request.method === "POST" && path === "/download") {
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
    if (request.method === "POST" && path === "/cancel") {
      send(response, 200, { cancelled: manager.cancel() });
      return;
    }
    if (request.method === "POST" && path === "/restart") {
      await manager.requestRestart();
      send(response, 202, { ok: true });
      return;
    }
    if (request.method === "POST" && path === "/discard-staged") {
      await manager.discardStaged();
      send(response, 200, { ok: true });
      return;
    }
    if (request.method === "POST" && path === "/discard-previous") {
      await manager.discardPrevious();
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
  console.info(`xelDash snapshot service on :${port} (network ${network}, snapshot source: ${snapshotUrl ?? "none published for this network"})`);
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
