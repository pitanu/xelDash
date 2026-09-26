import { createServer } from "node:net";
import { createServer as createTlsServer } from "node:tls";
import {
  createPool, listActiveBans, notifyLive, recordBan, recordReportedHashrate, recordServiceEvent, retentionConfigFromEnv,
  runRetention,
} from "@xeldash/db";
import { createWorkerAuthorizer } from "./authorize-worker.js";
import { BlockTracker } from "./block-tracker.js";
import { ChainWatcher } from "./chain-watcher.js";
import { DaemonClient } from "./daemon-client.js";
import { startGetworkServer } from "./getwork.js";
import { IpGuard, MessageRateLimiter, ipGuardConfigFromEnv, normalizeIp } from "./ip-guard.js";
import { MiningJobProvider } from "./job-provider.js";
import { LineFramer } from "./line-framer.js";
import { StratumSession } from "./session.js";
import { SyncMonitor } from "./sync-monitor.js";
import { tlsConfigFromEnv } from "./tls-config.js";
import { createShareSubmitter } from "./share-submitter.js";
import { vardiffConfigFromEnv } from "./vardiff.js";

const host = process.env.STRATUM_HOST ?? "0.0.0.0";
const port = Number.parseInt(process.env.STRATUM_PORT ?? "3333", 10);
const handshakeTimeoutMs = Number.parseInt(process.env.STRATUM_HANDSHAKE_TIMEOUT_MS ?? "10000", 10);
const maxQueuedRequests = Number.parseInt(process.env.STRATUM_MAX_QUEUED_REQUESTS ?? "32", 10);
const jobRefreshIntervalMs = Number.parseInt(process.env.STRATUM_JOB_REFRESH_MS ?? "5000", 10);
const vardiff = vardiffConfigFromEnv(process.env);
const ipGuardConfig = ipGuardConfigFromEnv(process.env);
const retention = retentionConfigFromEnv(process.env);
const tls = tlsConfigFromEnv(process.env);
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
/** @type {Map<{ remoteAddress?: string, destroy: () => void }, StratumSession>} */
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

// Hourly: roll minute stats into hourly rows, then delete raw shares and minute stats past
// retention. Stratum owns this because it is the service that writes those tables.
let retentionRunning = false;
async function retentionPass() {
  if (retentionRunning) return;
  retentionRunning = true;
  try {
    const result = await runRetention(pool, retention);
    if (result.shares > 0 || result.minuteStats > 0) console.info("Retention pass", result);
  } catch (error) {
    console.warn("Retention pass failed:", error instanceof Error ? error.message : String(error));
  } finally {
    retentionRunning = false;
  }
}
setTimeout(retentionPass, 60_000).unref();
setInterval(retentionPass, 3_600_000).unref();
const blockTracker = new BlockTracker({ daemon, pool });
blockTracker.start();

// Push fresh work to every session as soon as the daemon sees a new block. Per-session
// polling (STRATUM_JOB_REFRESH_MS) stays as the fallback and picks up template changes.
// A new block can also advance the stable height, so check submitted blocks too.
const chainWatcher = new ChainWatcher({
  rpcUrl: daemon.endpoint,
  onNewBlock: (block) => {
    for (const session of sessions.values()) void session.refreshJob();
    blockTracker.check();
    // Network blocks are not stored as events; tell live dashboards directly.
    notifyLive(pool, { type: "block", height: block.height ?? null, hash: block.hash ?? null }).catch(() => {});
  },
});
chainWatcher.start();

// Miners may report hashrate every few seconds; store at most one value per worker per 30 s.
const HASHRATE_WRITE_INTERVAL_MS = 30_000;
/** @type {Map<string, number>} */
const hashrateWrites = new Map();

/**
 * A mining session with this server's job source, share pipeline, vardiff and abuse limits.
 * Stratum and getwork connections both use it.
 * @param {import("./session.js").StratumSocket} socket @param {string} ip @param {() => void} [onAuthorized]
 */
function newSession(socket, ip, onAuthorized = () => {}) {
  return new StratumSession({
    socket,
    authorizeAddress,
    createJob: (input) => jobProvider.create(input),
    submitShare,
    jobRefreshIntervalMs,
    vardiff,
    defaultAddress: process.env.XELIS_DEFAULT_ADDRESS ?? "",
    onAuthorized,
    onSubmission: (valid) => ipGuard.record(ip, valid),
    onHashrate: ({ worker, hashrate }) => {
      const key = String(worker.workerId);
      const now = Date.now();
      if (now - (hashrateWrites.get(key) ?? 0) < HASHRATE_WRITE_INTERVAL_MS) return;
      hashrateWrites.set(key, now);
      recordReportedHashrate(pool, worker.workerId, hashrate)
        .catch((error) => console.warn("Failed to record reported hashrate:", error instanceof Error ? error.message : String(error)));
    },
    canMine: () => (syncMonitor.ready ? null : syncMonitor.reason),
  });
}

/**
 * One Stratum connection. Plain and TLS listeners share this, so limits, bans and sessions
 * behave the same on both.
 * @param {import("node:net").Socket} socket
 */
function handleConnection(socket) {
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
  const session = newSession(socket, ip, () => clearTimeout(handshakeTimer));
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
}

// Work is only issued while the node is caught up. When it falls behind or stops responding,
// every miner is disconnected so it retries (or fails over to a backup pool) instead of
// hashing on an old chain; logins are refused until the node is ready again.
const syncMonitor = new SyncMonitor({
  daemon,
  onChange: (state, detail) => {
    if (state !== "ready") {
      for (const socket of sessions.keys()) socket.destroy();
    }
    if (state === "ready" && detail.previous === "unknown") return;
    const type = state === "ready" ? "node_ready" : state === "syncing" ? "node_syncing" : "node_unreachable";
    recordServiceEvent(pool, type, detail)
      .catch((error) => console.warn("Failed to record node state:", error instanceof Error ? error.message : String(error)));
  },
});
await syncMonitor.start();

const server = createServer(handleConnection);
const tlsServer = tls
  ? createTlsServer({ cert: tls.cert, key: tls.key, minVersion: "TLSv1.2" }, handleConnection)
  : null;
// Failed handshakes (plain Stratum sent to the TLS port, untrusted certs) never reach a session.
tlsServer?.on("tlsClientError", (error, socket) => {
  const code = /** @type {{ code?: string }} */ (error).code;
  console.warn(`TLS handshake failed from ${normalizeIp(socket.remoteAddress)}: ${code ?? error.message}`);
});

server.listen(port, host, () => {
  console.info(`xelDash Stratum server listening on ${host}:${port}`);
  console.info(`Vardiff: start ${vardiff.startDifficulty}, min ${vardiff.minDifficulty}, one share per ${vardiff.targetShareSeconds}s`);
  // The dashboard reads the latest start event as Stratum's uptime.
  recordServiceEvent(pool, "stratum_started", { port, tlsPort: tls?.port ?? null })
    .catch((error) => console.warn("Failed to record start event:", error instanceof Error ? error.message : String(error)));
});
if (tlsServer && tls) {
  tlsServer.listen(tls.port, host, () => {
    console.info(`xelDash Stratum TLS listening on ${host}:${tls.port} (certificate ${tls.certFile})`);
  });
}

// Getwork for miners that do not speak Stratum (the official xelis_miner).
const getworkEnabled = (process.env.GETWORK_ENABLED ?? "true").toLowerCase() !== "false";
const getworkPort = Number.parseInt(process.env.GETWORK_PORT ?? "8090", 10);
if (!Number.isSafeInteger(getworkPort) || getworkPort < 1 || getworkPort > 65535) {
  throw new Error("GETWORK_PORT must be an integer from 1 to 65535");
}
const getwork = getworkEnabled
  ? startGetworkServer({ host, port: getworkPort, ipGuard, rateLimit: ipGuardConfig, sessions, createSession: newSession })
  : null;

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  chainWatcher.stop();
  syncMonitor.stop();
  const closed = Promise.all([
    new Promise((resolve) => server.close(resolve)),
    tlsServer ? new Promise((resolve) => tlsServer.close(resolve)) : null,
    getwork?.close(),
  ]);
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
