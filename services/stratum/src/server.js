import { createServer } from "node:net";
import { createPool, listActiveBans, recordBan, recordServiceEvent } from "@xeldash/db";
import { createWorkerAuthorizer } from "./authorize-worker.js";
import { BlockTracker } from "./block-tracker.js";
import { ChainWatcher } from "./chain-watcher.js";
import { DaemonClient } from "./daemon-client.js";
import { IpGuard, MessageRateLimiter, ipGuardConfigFromEnv, normalizeIp } from "./ip-guard.js";
import { MiningJobProvider } from "./job-provider.js";
import { LineFramer } from "./line-framer.js";
import { StratumSession } from "./session.js";
import { createShareSubmitter } from "./share-submitter.js";
import { vardiffConfigFromEnv } from "./vardiff.js";

const host = process.env.STRATUM_HOST ?? "0.0.0.0";
const port = Number.parseInt(process.env.STRATUM_PORT ?? "3333", 10);
const handshakeTimeoutMs = Number.parseInt(process.env.STRATUM_HANDSHAKE_TIMEOUT_MS ?? "10000", 10);
const maxQueuedRequests = Number.parseInt(process.env.STRATUM_MAX_QUEUED_REQUESTS ?? "32", 10);
const jobRefreshIntervalMs = Number.parseInt(process.env.STRATUM_JOB_REFRESH_MS ?? "5000", 10);
const vardiff = vardiffConfigFromEnv(process.env);
const ipGuardConfig = ipGuardConfigFromEnv(process.env);
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
const jobProvider = new MiningJobProvider({ daemon });
const submitShare = createShareSubmitter({ daemon, pool });
/** @type {Map<import("node:net").Socket, StratumSession>} */
const sessions = new Map();
const ipGuard = new IpGuard(ipGuardConfig, {
  onBan: ({ ip, reason, until }) => {
    console.warn(`Banning ${ip} until ${until.toISOString()}: ${reason}`);
    for (const socket of sessions.keys()) {
      if (normalizeIp(socket.remoteAddress) === ip) socket.destroy();
    }
    recordBan(pool, { ip, reason, until })
      .then(() => recordServiceEvent(pool, "ip_banned", { ip, reason, until: until.toISOString() }))
      .catch((error) => console.warn("Failed to record ban:", error instanceof Error ? error.message : String(error)));
  },
});
listActiveBans(pool)
  .then((bans) => ipGuard.loadBans(bans))
  .catch((error) => console.warn("Failed to load bans:", error instanceof Error ? error.message : String(error)));
setInterval(() => ipGuard.prune(), 60_000).unref();
const blockTracker = new BlockTracker({ daemon, pool });
blockTracker.start();

// Push fresh work to every session as soon as the daemon sees a new block. Per-session
// polling (STRATUM_JOB_REFRESH_MS) stays as the fallback and picks up template changes.
// A new block can also advance the stable height, so check submitted blocks too.
const chainWatcher = new ChainWatcher({
  rpcUrl: daemon.endpoint,
  onNewBlock: () => {
    for (const session of sessions.values()) void session.refreshJob();
    blockTracker.check();
  },
});
chainWatcher.start();

const server = createServer((socket) => {
  const ip = normalizeIp(socket.remoteAddress);
  const refused = ipGuard.connect(ip);
  if (refused) {
    console.warn(`Refusing Stratum connection from ${ip}: ${refused}`);
    socket.destroy();
    return;
  }
  socket.once("close", () => ipGuard.disconnect(ip));
  const limiter = new MessageRateLimiter(ipGuardConfig);
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
    vardiff,
    defaultAddress: process.env.XELIS_DEFAULT_ADDRESS ?? "",
    onAuthorized: () => clearTimeout(handshakeTimer),
    onSubmission: (valid) => ipGuard.record(ip, valid),
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
      if (!limiter.take(lines.length)) {
        console.warn(`Closing Stratum connection from ${ip}: message rate limit exceeded`);
        ipGuard.record(ip, false);
        socket.destroy();
        return;
      }
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
  console.info(`Vardiff: start ${vardiff.startDifficulty}, min ${vardiff.minDifficulty}, one share per ${vardiff.targetShareSeconds}s`);
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
  await blockTracker.stop();
  await pool.end();
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
