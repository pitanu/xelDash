import { createServer } from "node:net";
import { createPool } from "@xeldash/db";
import { createWorkerAuthorizer } from "./authorize-worker.js";
import { ChainWatcher } from "./chain-watcher.js";
import { DaemonClient } from "./daemon-client.js";
import { MiningJobProvider } from "./job-provider.js";
import { LineFramer } from "./line-framer.js";
import { StratumSession } from "./session.js";
import { createShareSubmitter } from "./share-submitter.js";

const host = process.env.STRATUM_HOST ?? "0.0.0.0";
const port = Number.parseInt(process.env.STRATUM_PORT ?? "3333", 10);
const handshakeTimeoutMs = Number.parseInt(process.env.STRATUM_HANDSHAKE_TIMEOUT_MS ?? "10000", 10);
const maxQueuedRequests = Number.parseInt(process.env.STRATUM_MAX_QUEUED_REQUESTS ?? "32", 10);
const jobRefreshIntervalMs = Number.parseInt(process.env.STRATUM_JOB_REFRESH_MS ?? "5000", 10);
const shareDifficulty = Number(process.env.STRATUM_SHARE_DIFFICULTY ?? "1000000");
if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
  throw new Error("STRATUM_PORT must be an integer from 1 to 65535");
}
if (!Number.isSafeInteger(handshakeTimeoutMs) || handshakeTimeoutMs < 1000
    || !Number.isSafeInteger(maxQueuedRequests) || maxQueuedRequests < 1
    || !Number.isSafeInteger(jobRefreshIntervalMs) || jobRefreshIntervalMs < 1000) {
  throw new Error("Stratum handshake timeout, queue limit, or job refresh interval is invalid");
}

const pool = createPool();
const daemon = new DaemonClient();
const authorizeAddress = createWorkerAuthorizer({ daemon, pool });
const jobProvider = new MiningJobProvider({ daemon, shareDifficulty });
const submitShare = createShareSubmitter({ daemon, pool });
/** @type {Map<import("node:net").Socket, StratumSession>} */
const sessions = new Map();

// Push fresh work to every session as soon as the daemon sees a new block. Per-session
// polling (STRATUM_JOB_REFRESH_MS) stays as the fallback and picks up template changes.
const chainWatcher = new ChainWatcher({
  rpcUrl: daemon.endpoint,
  onNewBlock: () => {
    for (const session of sessions.values()) void session.refreshJob();
  },
});
chainWatcher.start();

const server = createServer((socket) => {
  const framer = new LineFramer();
  const handshakeTimer = setTimeout(() => {
    console.warn(`Closing unauthenticated Stratum connection from ${socket.remoteAddress ?? "unknown"}`);
    socket.destroy();
  }, handshakeTimeoutMs);
  handshakeTimer.unref();
  socket.once("close", () => clearTimeout(handshakeTimer));
  const session = new StratumSession({
    socket,
    authorizeAddress,
    createJob: (input) => jobProvider.create(input),
    submitShare,
    jobRefreshIntervalMs,
    defaultAddress: process.env.XELIS_DEFAULT_ADDRESS ?? "",
    onAuthorized: () => clearTimeout(handshakeTimer),
  });
  sessions.set(socket, session);
  socket.once("close", () => {
    session.close();
    sessions.delete(socket);
  });
  let queue = Promise.resolve();
  let queuedRequests = 0;

  socket.setNoDelay(true);
  socket.on("data", (chunk) => {
    try {
      const lines = framer.push(chunk, maxQueuedRequests - queuedRequests);
      if (queuedRequests + lines.length > maxQueuedRequests) {
        console.warn(`Closing Stratum connection from ${socket.remoteAddress ?? "unknown"}: request queue limit exceeded`);
        socket.destroy();
        return;
      }
      for (const line of lines) {
        queuedRequests += 1;
        queue = queue.then(async () => {
          if (!socket.destroyed) await session.handleLine(line);
        }).catch((error) => {
          console.warn("Closing Stratum connection after request failure:", error instanceof Error ? error.message : String(error));
          socket.destroy();
        }).finally(() => {
          queuedRequests -= 1;
        });
      }
    } catch (error) {
      console.warn("Closing malformed Stratum connection:", error instanceof Error ? error.message : String(error));
      socket.destroy();
    }
  });
  socket.on("error", (error) => console.warn("Stratum socket error:", error.message));
});

server.listen(port, host, () => {
  console.info(`xelDash Stratum server listening on ${host}:${port}`);
  console.info(`Using fixed share difficulty ${shareDifficulty}; vardiff is not enabled.`);
});

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  chainWatcher.stop();
  const closed = new Promise((resolve) => server.close(resolve));
  for (const [socket, session] of sessions) {
    session.close();
    socket.destroy();
  }
  await closed;
  await pool.end();
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
