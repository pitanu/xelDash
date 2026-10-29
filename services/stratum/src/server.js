import { rename, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { createServer as createTlsServer } from "node:tls";
import {
  createPool, listActiveBans, notifyLive,
  retentionConfigFromEnv, runRetention,
} from "@xeldash/db";
import { createWorkerAuthorizer } from "./authorize-worker.js";
import { BlockTracker } from "./block-tracker.js";
import { ChainWatcher } from "./chain-watcher.js";
import { watchDefaultAddress } from "./default-address.js";
import { watchFallbackConfig } from "./fallback-config.js";
import { DurableStore } from "./store.js";
import { startGetworkServer } from "./getwork.js";
import { acceptWithProxyHeader, proxyTrustFromEnv } from "./proxy-protocol.js";
import { startHealthServer } from "./health.js";
import { readDefaultGateway } from "./gateway.js";
import { DEFAULT_IP_GUARD, IpGuard, MessageRateLimiter, guardRawConnections, ipGuardConfigFromEnv, normalizeIp } from "./ip-guard.js";
import { MiningJobProvider } from "./job-provider.js";
import { NodeBudget, burstFor } from "./node-budget.js";
import { NodePool, rpcUrlsFromEnv } from "./node-pool.js";
import { LineFramer } from "./line-framer.js";
import { ConnectionPlaces, idleConnections } from "./idle-connections.js";
import { RefusalLog } from "./refusal-log.js";
import { StratumSession } from "./session.js";
import { tlsConfigFromEnv, watchTlsCertificate } from "./tls-config.js";
import { createShareSubmitter } from "./share-submitter.js";
import { Metrics, collectProcessMetrics, metricsConfigFromEnv, noMetrics, startMetricsServer } from "./metrics.js";
import { STRATUM_ERRORS } from "./protocol.js";
import { vardiffConfigFromEnv } from "./vardiff.js";

const host = process.env.STRATUM_HOST ?? "0.0.0.0";
const port = Number.parseInt(process.env.STRATUM_PORT ?? "3333", 10);
const handshakeTimeoutMs = Number.parseInt(process.env.STRATUM_HANDSHAKE_TIMEOUT_MS ?? "10000", 10);
const maxQueuedRequests = Number.parseInt(process.env.STRATUM_MAX_QUEUED_REQUESTS ?? "32", 10);
const jobRefreshIntervalMs = Number.parseInt(process.env.STRATUM_JOB_REFRESH_MS ?? "5000", 10);
// How long shares on jobs replaced by a new block are still accepted (see session.js).
const staleGraceMs = Number.parseInt(process.env.STRATUM_STALE_GRACE_MS ?? "1500", 10);
if (!Number.isSafeInteger(staleGraceMs) || staleGraceMs < 0 || staleGraceMs > 30_000) {
  throw new Error("STRATUM_STALE_GRACE_MS must be an integer from 0 to 30000");
}
const vardiff = vardiffConfigFromEnv(process.env);
const ipGuardConfig = ipGuardConfigFromEnv(process.env);
// Connections Docker forwards from the host (Docker Desktop, or the machine itself) arrive from
// the network's gateway address, whoever really sent them. All of them share that one address,
// so per-address limits and bans would treat every rig as a single client: one misbehaving rig
// could lock out the others. Those limits are switched off for the gateway; the per-connection
// message limits, handshake timeout and queue limits still apply.
const dockerGateway = readDefaultGateway();
if (dockerGateway) {
  ipGuardConfig.exemptIps.push(dockerGateway);
  console.info(`Connections from ${dockerGateway} (Docker's gateway) hide the real client address: per-address limits are off for it`);
}
// Behind the front door of a cluster, connections start with a PROXY line naming the real miner (see proxy-protocol.js).
const proxyTrust = proxyTrustFromEnv(process.env.STRATUM_PROXY_FROM, { gateway: dockerGateway });
if (proxyTrust) console.info(`Connections from ${proxyTrust.text} must start with a PROXY line naming the real miner`);
console.info(`Miners may connect from: ${ipGuardConfig.allowedNetworks}`);
const retention = retentionConfigFromEnv(process.env);
// Raw shares are no longer written (migration 009); the ones an older version left are cleared after RETENTION_RAW_SHARE_DAYS, or
// a day on a public server, where strangers' rigs could have left millions of rows.
const rawShareDaysSet = (process.env.RETENTION_RAW_SHARE_DAYS ?? "").trim() !== "";
const tls = tlsConfigFromEnv(process.env);
if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
  throw new Error("STRATUM_PORT must be an integer from 1 to 65535");
}
if (!Number.isSafeInteger(handshakeTimeoutMs) || handshakeTimeoutMs < 1000
    || !Number.isSafeInteger(maxQueuedRequests) || maxQueuedRequests < 1
    || !Number.isSafeInteger(jobRefreshIntervalMs) || jobRefreshIntervalMs < 1000) {
  throw new Error("Stratum handshake timeout, queue limit, or job refresh interval is invalid");
}

// Public mode (XELDASH_PUBLIC_MODE): anyone may mine here, so every miner must log in with its own address and there is no default.
// A standby or front door is also in public mode when the main server says it is (see followMainAddress), whatever its own .env says.
const envPublicMode = /^(1|true|yes|on)$/i.test((process.env.XELDASH_PUBLIC_MODE ?? "").trim());
if (envPublicMode) console.info("Public mode: miners must log in with their own address; the default address is not used.");

// The address for miners that send none: chosen on the dashboard's setup page, else .env.
const defaultAddress = watchDefaultAddress({
  file: process.env.XELDASH_MINING_ADDRESS_FILE ?? "/config/mining-address.json",
  fallback: process.env.XELIS_DEFAULT_ADDRESS ?? "",
});
await defaultAddress.ready;
/** Whether this server is a public server right now: by its own setting, or because its main server is one. */
const isPublic = () => envPublicMode || defaultAddress.publicMode();
// A standby server (the second server of a redundancy cluster) has no database: with STRATUM_INGEST_URL set it
// sends everything it records to the main server instead (see store.js).
const ingestUrl = (process.env.STRATUM_INGEST_URL ?? "").replace(/\/$/, "");
const clusterSecret = process.env.XELDASH_CLUSTER_SECRET ?? "";
if (ingestUrl && clusterSecret.length < 16) throw new Error("STRATUM_INGEST_URL needs XELDASH_CLUSTER_SECRET (at least 16 characters)");
const pool = ingestUrl ? null : createPool();
// One or more XELIS nodes, in priority order (XELIS_RPC_URLS). Work comes from the first one
// that is in sync; see node-pool.js.
const nodes = new NodePool({ urls: rpcUrlsFromEnv(process.env), onActiveChange: handleActiveChange, onPeers: handleNodePeers });
// Everything recorded goes through the store, which keeps a journal file while the database cannot be
// reached, so mining never waits for it (see store.js). The journal lives on its own volume.
// A standby mines to the address the main server mines to when a rig sends none. The main server says which in its readiness
// reply; it is kept in a file on the standby's own volume, which the default-address watcher above already reads.
const ADDRESS_FORMAT = /^(xel|xet):[a-z0-9]{30,120}$/;
/** @type {{ address: string, publicMode: boolean } | null} */
let followed = null;
/** @param {{ miningAddress?: unknown, publicMode?: unknown } | null} body */
function followMainAddress(body) {
  if (!body) return;
  // A public main server has no default address and makes this server refuse logins without one; the flag is kept in the file, so
  // it holds across a restart while the main server is away.
  const publicMode = body.publicMode === true;
  const offered = typeof body.miningAddress === "string" ? body.miningAddress : "";
  const address = !publicMode && ADDRESS_FORMAT.test(offered) ? offered : "";
  if (followed && followed.address === address && followed.publicMode === publicMode) return;
  followed = { address, publicMode };
  const file = process.env.XELDASH_MINING_ADDRESS_FILE;
  if (!file) return;
  const tmp = `${file}.tmp`;
  writeFile(tmp, JSON.stringify({ address, publicMode, source: "main server", updatedAt: new Date().toISOString() }), { mode: 0o600 })
    .then(() => rename(tmp, file))
    .then(() => {
      console.info(publicMode ? "The main server is a public server: logins without an address are refused here too" : "Following the main server's default mining address");
      // Miners come from the internet on a public server; after a failover this server must let them in too.
      if (publicMode && String(ipGuardConfig.allowedNetworks).trim().toLowerCase() === "private") {
        console.warn("The main server is a public server, but XELDASH_ALLOWED_NETWORKS is \"private\" here: after a failover, miners on the internet would be turned away. Set it to \"any\" in this server's .env.");
      }
    })
    .catch((error) => console.warn("Could not save the main server's default address:", error instanceof Error ? error.message : String(error)));
}
const journalMegabytes = Number(process.env.STRATUM_JOURNAL_MAX_MB ?? 200);
const instanceName = process.env.STRATUM_INSTANCE || process.env.XELDASH_SERVER_NAME || (await import("node:os")).hostname();
// Prometheus metrics, off unless asked for (docs/OPERATIONS.md#metrics): then every recorder is a no-op and nothing listens.
const metricsConfig = metricsConfigFromEnv(process.env);
const metrics = metricsConfig.enabled ? new Metrics() : noMetrics;
const LATENCY_BUCKETS = [0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5];
const batchSeconds = metrics.histogram("xeldash_share_batch_seconds", "Time to write one batch of shares to the database.", LATENCY_BUCKETS);
const batchShares = metrics.counter("xeldash_shares_written_total", "Shares written to the database (in batches).");
const store = new DurableStore({
  pool,
  remote: ingestUrl ? { url: ingestUrl, secret: clusterSecret, instance: instanceName, onPing: followMainAddress } : null,
  dir: process.env.STRATUM_JOURNAL_DIR || null,
  ...(Number.isFinite(journalMegabytes) && journalMegabytes > 0 ? { maxBytes: journalMegabytes * 1048576 } : {}),
  ...(metrics.enabled ? { onBatch: (/** @type {number} */ seconds, /** @type {number} */ count) => { batchSeconds.observe(seconds); batchShares.inc(undefined, count); } } : {}),
});
await store.init();
// Limits for a public server (docs/OPERATIONS.md#public-mode). Each follows public mode (which a standby can learn while running)
// unless it is set in .env: the node-call budget (100 a second; found blocks never wait), different addresses per IP address (32),
// connections per IP address (1000, so a farm behind one address fits) and in all (5000), and shares checked per IP address (300 a
// second: a 600-rig farm at one share every 5 s sends 120), and new worker names per IP address (1000 an hour: each is a database row).
/** @param {string} name @returns {number | null} */
function optionalSetting(name) {
  const text = (process.env[name] ?? "").trim();
  if (!text) return null;
  const n = Number(text);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${name} must be 0 (no limit) or a positive number`);
  return n;
}
const nodeCallsSetting = optionalSetting("STRATUM_NODE_CALLS_PER_SECOND");
const addressesPerIpSetting = optionalSetting("STRATUM_MAX_ADDRESSES_PER_IP");
const newWorkersPerIpSetting = optionalSetting("STRATUM_NEW_WORKERS_PER_IP_PER_HOUR");
// Close a connection with no share for this long (half of it if it has never sent one): on public servers by default, so idle
// logins cannot hold places real miners need (idle-connections.js). 0 turns it off.
const idleSecondsSetting = optionalSetting("STRATUM_IDLE_SECONDS");
const idleSeconds = () => idleSecondsSetting ?? (isPublic() ? 1800 : 0);
const nodeBudget = new NodeBudget({ perSecond: 0 });
/** @type {boolean | null} */
let limitsForPublic = null;
function applyModeLimits() {
  const pub = isPublic();
  if (pub === limitsForPublic) return;
  limitsForPublic = pub;
  if (!ipGuardConfig.explicit?.maxConnectionsPerIp) ipGuardConfig.maxConnectionsPerIp = pub ? 1000 : DEFAULT_IP_GUARD.maxConnectionsPerIp;
  if (!ipGuardConfig.explicit?.maxConnections) ipGuardConfig.maxConnections = pub ? 5000 : 0;
  if (!ipGuardConfig.explicit?.sharesPerIpPerSecond) ipGuardConfig.sharesPerIpPerSecond = pub ? 300 : 0;
  // New connections per IP address: 20 a second after a burst of the per-IP connection limit (a whole farm reconnecting at once).
  if (!ipGuardConfig.explicit?.connectionsPerIpPerSecond) ipGuardConfig.connectionsPerIpPerSecond = pub ? 20 : 0;
  // Shares checked a minute for an IP address before one of its shares is accepted (a real rig's first one usually is).
  if (!ipGuardConfig.explicit?.unprovenChecksPerMinute) ipGuardConfig.unprovenChecksPerMinute = pub ? 30 : 0;
  const perSecond = nodeCallsSetting ?? (pub ? 100 : 0);
  nodeBudget.perSecond = perSecond;
  nodeBudget.burst = burstFor(perSecond);
  nodeBudget.tokens = nodeBudget.burst;
  if (pub) {
    removeFallbackNodes(null);
    console.info(`Public-server limits: ${perSecond || "no"} node calls a second, ${addressesPerIpSetting ?? 32} addresses, `
      + `${newWorkersPerIpSetting ?? 1000} new worker names an hour, `
      + `${ipGuardConfig.maxConnectionsPerIp} connections, ${ipGuardConfig.connectionsPerIpPerSecond || "unlimited"} new connections a second `
      + `and ${ipGuardConfig.sharesPerIpPerSecond || "unlimited"} shares a second per IP address `
      + `(${ipGuardConfig.unprovenChecksPerMinute || "unlimited"} a minute until one is accepted), `
      + `${ipGuardConfig.maxConnections || "no limit to"} connections in all, `
      + `${idleSeconds() ? `idle connections closed after ${idleSeconds()} s` : "idle connections kept"}`);
    if (ipGuardConfig.explicit?.maxConnectionsPerIp && ipGuardConfig.maxConnectionsPerIp < 600) {
      console.warn(`STRATUM_MAX_CONNECTIONS_PER_IP is ${ipGuardConfig.maxConnectionsPerIp}: a farm behind one IP address can connect only `
        + "that many rigs. Leave it empty for the public default (1000).");
    }
  }
}
const authorizeAddress = createWorkerAuthorizer({ daemon: nodes, store, budget: nodeBudget,
  maxAddressesPerIp: () => addressesPerIpSetting ?? (isPublic() ? 32 : 0),
  maxWorkersPerIp: () => newWorkersPerIpSetting ?? (isPublic() ? 1000 : 0) });
const jobProvider = new MiningJobProvider({ nodes, beforeNodeCall: () => nodeBudget.take() });
// A block one of our rigs found is the new tip as soon as the node accepts it: new work for every rig right away (the node's
// new_block event for it follows, and is announced only once).
// Best share: how close each accepted share came to a block, kept per worker and minute. On unless XELDASH_BEST_SHARE=off.
const bestShare = !/^(off|false|0|no)$/i.test((process.env.XELDASH_BEST_SHARE ?? "").trim());
const checkShare = createShareSubmitter({ daemon: nodes, store, onBlockAccepted: (block) => handleNewBlock(block), bestShare });
const sharesTotal = metrics.counter("xeldash_shares_total", "Shares by result: accepted, low_difficulty, duplicate, stale, error.");
const shareDifficulty = metrics.counter("xeldash_share_difficulty_total",
  "Sum of the difficulty of accepted shares; its rate per second is the hashrate the shares prove.");
const shareSeconds = metrics.histogram("xeldash_share_seconds", "Time to check a share (its hash) and record it, until the answer.", LATENCY_BUCKETS);
const blocksTotal = metrics.counter("xeldash_blocks_total", "Blocks found and submitted to the node, by result: accepted or rejected.");
const workerShares = metrics.counter("xeldash_worker_shares_total", "Shares by worker and result (XELDASH_METRICS_PER_WORKER).", { perWorker: true });
const workerDifficulty = metrics.counter("xeldash_worker_difficulty_total", "Accepted share difficulty by worker (XELDASH_METRICS_PER_WORKER).", { perWorker: true });
/**
 * A share's outcome, for the metrics.
 * @param {string} result @param {{ address: string }} worker @param {string} workerName @param {number} [difficulty]
 */
function countShare(result, worker, workerName, difficulty) {
  sharesTotal.inc({ result });
  if (metricsConfig.perWorker) workerShares.inc({ address: worker.address, worker: workerName, result });
  if (result === "accepted" && difficulty) {
    shareDifficulty.inc(undefined, difficulty);
    if (metricsConfig.perWorker) workerDifficulty.inc({ address: worker.address, worker: workerName }, difficulty);
  }
}
/** @type {typeof checkShare} */
const submitShare = metrics.enabled
  ? async (input) => {
    const started = performance.now();
    const result = await checkShare(input);
    shareSeconds.observe((performance.now() - started) / 1000);
    const code = result.error?.code;
    countShare(result.accepted ? "accepted" : code === STRATUM_ERRORS.LOW_DIFFICULTY ? "low_difficulty"
      : code === STRATUM_ERRORS.DUPLICATE_SHARE ? "duplicate" : "error", input.worker, input.workerName, Number(input.job.shareDifficulty));
    if (result.block) blocksTotal.inc({ result: result.block.accepted ? "accepted" : "rejected" });
    return result;
  }
  : checkShare;
/** @type {Map<{ remoteAddress?: string, destroy: () => void }, StratumSession>} */
const sessions = new Map();
// Idle connections are closed every 30 s; one line says how many.
setInterval(() => {
  const idle = idleConnections(sessions, idleSeconds() * 1000);
  if (idle.length === 0) return;
  console.warn(`Closing ${idle.length} Stratum connection${idle.length === 1 ? "" : "s"} with no share for ${idleSeconds()} s (or half that, never one)`);
  for (const socket of idle) socket.destroy();
}, 30_000).unref();
// Why a connection or login was turned away, recorded for the dashboard's connection help. The
// same problem from the same address is recorded at most once every ten minutes, so a stuck
// miner retrying every few seconds cannot fill the events table.
const PROBLEM_INTERVAL_MS = 10 * 60_000;
/** @type {Map<string, number>} */
const problemSeen = new Map();
const PROBLEMS_PER_MINUTE = 60;
let problemWindowStart = 0;
let problemsThisWindow = 0;
/** @param {string} type @param {Record<string, unknown> & { ip: string, reason: string }} payload */
function reportProblem(type, payload) {
  // The address and worker come straight from the miner's login: cut them short, so a miner cannot make an event as large as its message.
  const short = (/** @type {unknown} */ value) => (typeof value === "string" ? value.slice(0, 200) : value);
  payload = { ...payload, ...(payload.address !== undefined ? { address: short(payload.address) } : {}), ...(payload.worker !== undefined ? { worker: short(payload.worker) } : {}), ...(payload.detail !== undefined ? { detail: short(payload.detail) } : {}) };
  const key = [type, payload.reason, payload.ip, payload.address ?? ""].join("|");
  const now = Date.now();
  if (now - (problemSeen.get(key) ?? 0) < PROBLEM_INTERVAL_MS) return;
  // Whatever the miners send, at most this many problem events a minute are recorded in all: they cannot flood the database or,
  // while it is away, the journal.
  if (now - problemWindowStart >= 60_000) {
    problemWindowStart = now;
    problemsThisWindow = 0;
  }
  if (++problemsThisWindow > PROBLEMS_PER_MINUTE) return;
  problemSeen.set(key, now);
  if (problemSeen.size > 1_000) {
    for (const [k, at] of problemSeen) if (now - at >= PROBLEM_INTERVAL_MS) problemSeen.delete(k);
    // Still too many distinct causes (they are all recent): forget the oldest rather than grow without limit.
    while (problemSeen.size > 5_000) problemSeen.delete(/** @type {string} */ (problemSeen.keys().next().value));
  }
  const masked = payload.ip === dockerGateway;
  store.recordServiceEvent(type, { ...payload, ...(masked ? { masked: true } : {}) })
    .catch((error) => console.warn("Failed to record a connection problem:", error instanceof Error ? error.message : String(error)));
}

const ipGuard = new IpGuard(ipGuardConfig, {
  onBan: ({ ip, reason, until }) => {
    console.warn(`Banning ${ip} until ${until.toISOString()}: ${reason}`);
    for (const socket of sessions.keys()) {
      if (normalizeIp(socket.remoteAddress) === ip) socket.destroy();
    }
    store.recordBan({ ip, reason, until })
      .then(() => store.recordServiceEvent("ip_banned", { ip, reason, until: until.toISOString() }))
      .catch((error) => console.warn("Failed to record ban:", error instanceof Error ? error.message : String(error)));
  },
});
(pool ? listActiveBans(pool) : Promise.resolve([]))
  .then((bans) => ipGuard.loadBans(bans))
  .catch((error) => console.warn("Failed to load bans:", error instanceof Error ? error.message : String(error)));
setInterval(() => ipGuard.prune(), 60_000).unref();

// Refused connections, logged at most once a minute per address and reason (a client reconnecting in a loop is refused thousands
// of times a second).
const refusals = new RefusalLog();

// Places for connections: idle logins make way for real miners when a limit is reached (idle-connections.js).
const places = new ConnectionPlaces(ipGuard, sessions, {
  onEvict: (evicted, forIp, reason) => console.warn(`Closing a connection from ${evicted} that has not mined, to make room for one from ${forIp} (${reason})`),
});

// Hourly: roll minute stats into hourly rows, then delete raw shares and minute stats past
// retention. Stratum owns this because it is the service that writes those tables.
let retentionRunning = false;
async function retentionPass() {
  if (retentionRunning) return;
  retentionRunning = true;
  try {
    if (!pool) return;
    const result = await runRetention(pool, isPublic() && !rawShareDaysSet ? { ...retention, rawShareDays: 1 } : retention);
    if (Object.entries(result).some(([key, count]) => key !== "rolledUp" && count > 0)) console.info("Retention pass", result);
  } catch (error) {
    console.warn("Retention pass failed:", error instanceof Error ? error.message : String(error));
  } finally {
    retentionRunning = false;
  }
}
setTimeout(retentionPass, 60_000).unref();
setInterval(retentionPass, 3_600_000).unref();
// Finishing submitted blocks needs the database; a standby leaves it to the main server, which records them.
const blockTracker = pool ? new BlockTracker({ daemon: nodes, pool }) : null;
blockTracker?.start();

// Push fresh work to every session as soon as any node sees a new block. Per-session polling
// (STRATUM_JOB_REFRESH_MS) stays as the fallback and picks up template changes. A new block
// can also advance the stable height, so check submitted blocks too. Every node reports the
// same block, so live dashboards are told once per hash.
/** @type {Set<string>} */
const announcedBlocks = new Set();
/** @param {{ hash?: string, height?: number }} block */
function handleNewBlock(block) {
  // Shared work is for the old tip: every rig gets fresh work from one new fetch per address.
  jobProvider.invalidate();
  for (const session of sessions.values()) void session.refreshJob();
  blockTracker?.check();
  if (!block.hash || announcedBlocks.has(block.hash)) return;
  announcedBlocks.add(block.hash);
  if (announcedBlocks.size > 256) announcedBlocks.delete(/** @type {string} */ (announcedBlocks.values().next().value));
  if (pool) notifyLive(pool, { type: "block", height: block.height ?? null, hash: block.hash }).catch(() => {});
}
/** @type {Map<import("./node-pool.js").PoolNode, ChainWatcher>} */
const chainWatchers = new Map();
/** @type {{ stop: () => void } | null} */
let fallbackConfig = null;
/** @param {import("./node-pool.js").PoolNode} node */
function watchNode(node) {
  const watcher = new ChainWatcher({
    rpcUrl: node.url,
    // A fallback node's blocks only matter while we mine through it; otherwise they would
    // refresh jobs before our own node has the block.
    onNewBlock: (block) => {
      if (!node.fallback || nodes.active === node) handleNewBlock(block);
    },
    // A dropped event connection is the quickest sign a node went away; check it right away.
    onDisconnect: () => nodes.checkNow(node),
  });
  chainWatchers.set(node, watcher);
  watcher.start();
}
for (const node of nodes.nodes) watchNode(node);

// Miners may report hashrate every few seconds; store at most one value per worker per 30 s.
const HASHRATE_WRITE_INTERVAL_MS = 30_000;
/** @type {Map<string, number>} */
const hashrateWrites = new Map();

// A public server must see each miner's own address: bans and per-IP limits depend on it. Miners arriving from Docker's gateway
// (Docker Desktop, or IPv6 through Docker's own proxy on Linux) all look like one address, which is exempt from those limits.
let maskedWarnedAt = 0;
/** @param {string} ip */
function warnIfMasked(ip) {
  if (!dockerGateway || ip !== dockerGateway || !isPublic()) return;
  const now = Date.now();
  if (now - maskedWarnedAt < 3_600_000) return;
  maskedWarnedAt = now;
  console.warn(`Public mode: miners are arriving from Docker's gateway (${ip}), which hides their real addresses, so bans and per-IP `
    + "limits cannot work for them. Run a public server on Linux with Docker Engine, with Stratum and getwork published on an IPv4 "
    + "address (XELDASH_STRATUM_BIND_IP=0.0.0.0, not ::). See docs/OPERATIONS.md#public-mode.");
}

/**
 * A mining session with this server's job source, share pipeline, vardiff and abuse limits.
 * Stratum and getwork connections both use it.
 * @param {import("./session.js").StratumSocket} socket @param {string} ip @param {() => void} [onAuthorized]
 */
function newSession(socket, ip, onAuthorized = () => {}) {
  warnIfMasked(ip);
  const session = new StratumSession({
    socket,
    // The connection's real address (a front door's PROXY line, getwork's own), for the per-IP address limit.
    authorizeAddress: (input) => authorizeAddress({ ...input, ip }),
    createJob: (input) => jobProvider.create(input),
    submitShare,
    jobRefreshIntervalMs,
    vardiff,
    defaultAddress: isPublic() ? "" : defaultAddress.get(),
    requireAddress: isPublic(),
    difficultyAsFloor: isPublic(),
    allowShare: () => {
      if (ipGuard.allowShare(ip)) return true;
      const probation = (ipGuardConfig.unprovenChecksPerMinute ?? 0) > 0 && !ipGuard.proven(ip);
      reportProblem("login_problem", { ip, reason: probation ? "unproven_shares" : "too_many_shares" });
      return false;
    },
    onProblem: (problem) => reportProblem("login_problem", { ip, ...problem }),
    onAuthorized,
    onSubmission: (valid) => ipGuard.record(ip, valid),
    staleGraceMs,
    onStale: ({ worker, workerName, jobId, nonce, difficulty }) => {
      countShare("stale", worker, workerName);
      store.recordShare({ workerId: worker.workerId, jobId, nonce, difficulty: String(difficulty), accepted: false, rejectReason: "stale" }, { address: worker.address, name: workerName })
        .catch((error) => console.warn("Failed to record a stale share:", error instanceof Error ? error.message : String(error)));
    },
    onHashrate: ({ worker, workerName, hashrate }) => {
      const key = `${worker.address}/${workerName}`;
      const now = Date.now();
      if (now - (hashrateWrites.get(key) ?? 0) < HASHRATE_WRITE_INTERVAL_MS) return;
      hashrateWrites.set(key, now);
      // Worker names come from miners: forget the ones not heard from lately rather than keep every name ever sent.
      if (hashrateWrites.size > 10_000) for (const [k, at] of hashrateWrites) if (now - at >= HASHRATE_WRITE_INTERVAL_MS) hashrateWrites.delete(k);
      store.recordReportedHashrate(worker.workerId, hashrate)
        .catch((error) => console.warn("Failed to record reported hashrate:", error instanceof Error ? error.message : String(error)));
    },
    canMine: () => (nodes.ready ? null : nodes.reason),
  });
  session.ip = ip;
  return session;
}

/**
 * One Stratum connection. Plain and TLS listeners share this, so limits, bans and sessions
 * behave the same on both.
 * @param {import("node:net").Socket} socket
 * @param {{ attempted?: boolean }} [options] attempted: its connection rate was charged when it was accepted (the TLS port)
 */
function handleConnection(socket, options = {}) {
  const ip = normalizeIp(socket.remoteAddress);
  const refused = places.admit(ip, undefined, options);
  if (refused) {
    refusals.refused("Stratum", ip, refused);
    reportProblem("connection_refused", { ip, reason: refused });
    socket.destroy();
    return;
  }
  socket.once("close", () => places.release(socket, ip));
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
  // A rig that lost power or its network without closing the connection is noticed, instead of holding its place.
  socket.setKeepAlive(true, 30_000);
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

// Work is only issued while some node is caught up. When the active node falls behind or
// stops responding, mining moves to the next ready node and every miner gets fresh work from
// it. When no node is ready, every miner is disconnected so it retries (or fails over to a
// backup pool) instead of hashing on an old chain, and logins are refused until one recovers.
let nodesStarted = false;
/**
 * One of our nodes has had no peers for a while (mainnet or testnet), or has them again: recorded, for the alerts and the events.
 * @param {import("./node-pool.js").PoolNode} node @param {boolean} peerless @param {Record<string, unknown>} detail
 */
function handleNodePeers(node, peerless, detail) {
  store.recordServiceEvent(peerless ? "node_no_peers" : "node_peers_back", { node: node.label, ...detail })
    .catch((error) => console.warn("Failed to record node peers:", error instanceof Error ? error.message : String(error)));
}
/**
 * @param {import("./node-pool.js").PoolNode | null} active
 * @param {import("./node-pool.js").PoolNode | null} previous
 */
function handleActiveChange(active, previous) {
  /** @param {string} type @param {Record<string, unknown>} payload */
  const record = (type, payload) => store.recordServiceEvent(type, payload)
    .catch((error) => console.warn("Failed to record node state:", error instanceof Error ? error.message : String(error)));
  const states = Object.fromEntries(nodes.nodes.map((node) => [node.label, node.monitor.state]));
  if (!active) {
    for (const socket of sessions.keys()) socket.destroy();
    const syncing = nodes.nodes.find((node) => node.monitor.state === "syncing");
    record(syncing ? "node_syncing" : "node_unreachable", { ...(syncing?.monitor.detail ?? {}), nodes: states, reason: nodes.reason });
    return;
  }
  if (!nodesStarted) return;
  if (!previous) {
    record("node_ready", { node: active.label, nodes: states });
    return;
  }
  record("node_switched", { from: previous.label, to: active.label, nodes: states });
  // The other node may run another XELIS release: check again whether its work can be shared between addresses.
  jobProvider.recheck();
  for (const session of sessions.values()) void session.refreshJob(true);
}
await nodes.start();
// The official public node, when switched on from the dashboard: mined through only while
// none of our own nodes can issue work.
const fallbackWatch = watchFallbackConfig({
  file: process.env.XELDASH_MINING_NODES_FILE ?? "/config/mining-nodes.json",
  onChange: async (setting) => {
    // A public server never sends its miners' load to the official node (node.xelis.io): the fallback is ignored.
    const url = isPublic() ? null : setting;
    if (setting && !url) console.info("Mining fallback ignored: this is a public server");
    removeFallbackNodes(url);
    if (url) {
      const node = await nodes.addFallback(url);
      if (node) {
        watchNode(node);
        console.info(`Mining fallback on: ${node.label}, used only while none of our nodes can issue work`);
      }
    }
  },
});
fallbackConfig = fallbackWatch;
applyModeLimits();
setInterval(applyModeLimits, 5_000).unref();

/** Stop mining through fallback nodes other than `keepUrl`. @param {string | null} keepUrl */
function removeFallbackNodes(keepUrl) {
  for (const node of nodes.nodes.filter((n) => n.fallback && n.url !== keepUrl)) {
    chainWatchers.get(node)?.stop();
    chainWatchers.delete(node);
    nodes.remove(node);
    console.info(`Mining fallback off: ${node.label}`);
  }
}
await fallbackWatch.ready;
nodesStarted = true;

// The plain listener reads the PROXY line first when a forwarder is listed; the TLS port does not support it.
const server = proxyTrust
  ? createServer({ pauseOnConnect: true }, (socket) => acceptWithProxyHeader(socket, proxyTrust, (ready) => { handleConnection(ready); }))
  : createServer(handleConnection);
/** @type {import("node:tls").Server | null} */
let tlsServer = null;

server.listen(port, host, () => {
  console.info(`xelDash Stratum server listening on ${host}:${port}`);
  console.info(`Vardiff: start ${vardiff.startDifficulty}, min ${vardiff.minDifficulty}, one share per ${vardiff.targetShareSeconds}s`);
  // The dashboard reads the latest start event as Stratum's uptime.
  store.recordServiceEvent("stratum_started", {
    port,
    tlsPort: tls?.port ?? null,
    node: nodes.active?.label ?? null,
    // Starting while no node is ready (syncing, or loading a snapshot) is a paused start.
    paused: nodes.ready ? null : nodes.nodes.some((n) => n.monitor.state === "syncing") ? "syncing" : "unreachable",
  })
    .catch((error) => console.warn("Failed to record start event:", error instanceof Error ? error.message : String(error)));
});
// The TLS port opens once the certificate is there, and takes a renewed certificate without a restart (see tls-config.js).
const tlsWatch = tls
  ? watchTlsCertificate({
    config: tls,
    onLoad: ({ cert, key, validTo }, first) => {
      if (!first && tlsServer) {
        tlsServer.setSecureContext({ cert, key, minVersion: "TLSv1.2" });
        console.info(`Stratum TLS certificate renewed (valid until ${validTo.toISOString()})`);
        return;
      }
      // The guard counts a connection once its handshake is done: until then, a short handshake time and the same per-address limits.
      // The connection rate is charged as the socket is accepted, so a client reconnecting in a loop is refused before its handshake.
      const listener = createTlsServer({ cert, key, minVersion: "TLSv1.2", handshakeTimeout: 10_000 }, (socket) => handleConnection(socket, { attempted: true }));
      guardRawConnections(listener, ipGuard, {
        chargeAttempts: true,
        onRefused: (ip, reason) => {
          refusals.refused("Stratum TLS", ip, reason);
          reportProblem("connection_refused", { ip, reason });
        },
      });
      // Failed handshakes (plain Stratum sent to the TLS port, untrusted certs) never reach a session.
      listener.on("tlsClientError", (error, socket) => {
        const code = /** @type {{ code?: string }} */ (error).code;
        console.warn(`TLS handshake failed from ${normalizeIp(socket.remoteAddress)}: ${code ?? error.message}`);
      });
      tlsServer = listener;
      listener.listen(tls.port, host, () => {
        console.info(`xelDash Stratum TLS listening on ${host}:${tls.port} (certificate ${tls.certFile}, valid until ${validTo.toISOString()})`);
      });
    },
  })
  : null;

// Getwork for miners that do not speak Stratum (the official xelis_miner).
const getworkEnabled = (process.env.GETWORK_ENABLED ?? "true").toLowerCase() !== "false";
const getworkPort = Number.parseInt(process.env.GETWORK_PORT ?? "8090", 10);
if (!Number.isSafeInteger(getworkPort) || getworkPort < 1 || getworkPort > 65535) {
  throw new Error("GETWORK_PORT must be an integer from 1 to 65535");
}
const getwork = getworkEnabled
  ? startGetworkServer({ host, port: getworkPort, ipGuard, rateLimit: ipGuardConfig, sessions, createSession: newSession,
    admit: (ip) => places.admit(ip), release: (socket, ip) => places.release(socket, ip), refusals,
    onRefused: (ip, reason) => reportProblem("connection_refused", { ip, reason }), proxyTrust })
  : null;

// Whether this server can give miners work right now; see health.js.
const health = startHealthServer({
  port: Number(process.env.STRATUM_HEALTH_PORT ?? 8096),
  // Mining does not need the database (see store.js), so only a ready node matters here.
  check: async () => (nodes.ready ? null : nodes.reason ?? "no node is ready"),
  status: () => {
    // Rigs on the plain Stratum port by how they arrived: through the front door (PROXY line) or straight to this server.
    let viaFrontDoor = 0;
    for (const socket of sessions.keys()) if (/** @type {{ viaFrontDoor?: boolean }} */ (socket).viaFrontDoor) viaFrontDoor++;
    return {
      instance: instanceName, mode: ingestUrl ? "standby" : "main", rigs: sessions.size, journal: store.status(),
      // `from` lists the operator's own forwarder addresses; a public server's status page (the standby's) must not show them.
      frontDoor: proxyTrust ? { ...(isPublic() ? {} : { from: proxyTrust.text }), viaFrontDoor, direct: sessions.size - viaFrontDoor } : null,
    };
  },
});

// What the metrics read when they are asked for, so the hot paths keep nothing extra. Node labels are the node names
// (daemon, daemon2, the fallback's host), never miners.
/** @typedef {import("./metrics.js").Family} Family */
if (metrics.enabled) {
  collectProcessMetrics(/** @type {Metrics} */ (metrics));
  metrics.collect(() => {
    let workers = 0;
    for (const session of sessions.values()) workers += session.authorizedWorkers.size;
    const journal = store.status();
    /** @param {string} name @param {string} help @param {number} value @param {"gauge" | "counter"} [type] @returns {Family} */
    const one = (name, help, value, type = "gauge") => ({ name, help, type, samples: [{ value }] });
    /** @param {string} name @param {string} help @param {(node: import("./node-pool.js").PoolNode) => number} value @returns {Family} */
    const perNode = (name, help, value) => ({ name, help, type: "gauge", samples: nodes.nodes.map((node) => ({ labels: { node: node.label }, value: value(node) })) });
    return [
      one("xeldash_connections", "Miner connections open now (Stratum, Stratum over TLS and getwork).", sessions.size),
      one("xeldash_workers", "Workers logged in on those connections.", workers),
      one("xeldash_public_mode", "1 while public mode is on.", isPublic() ? 1 : 0),
      one("xeldash_ip_bans", "IP addresses banned now.", ipGuard.bans.size),
      one("xeldash_store_online", "1 while records go straight to the database; 0 while they are kept in the journal.", journal.online ? 1 : 0),
      one("xeldash_store_queued_shares", "Shares waiting for the next batch write.", journal.queued),
      one("xeldash_store_journal_records", "Records kept in the journal, waiting for the database (or the main server).", journal.pending),
      one("xeldash_store_dropped_total", "Records dropped because the journal was full, or the database did not keep up.", journal.dropped, "counter"),
      perNode("xeldash_node_ready", "1 while the node is in sync and can give work.", (node) => (node.monitor.ready ? 1 : 0)),
      perNode("xeldash_node_active", "1 for the node mining runs through now.", (node) => (nodes.active === node ? 1 : 0)),
      perNode("xeldash_node_fallback", "1 for the official public node used as a fallback.", (node) => (node.fallback ? 1 : 0)),
      perNode("xeldash_node_topoheight", "The node's topoheight.", (node) => Number(node.monitor.detail.topoheight ?? NaN)),
      perNode("xeldash_node_peers", "The node's peers.", (node) => Number(node.monitor.detail.peers ?? NaN)),
    ];
  });
}
const metricsServer = metrics.enabled
  ? startMetricsServer({ metrics: /** @type {Metrics} */ (metrics), config: metricsConfig, isPublic })
  : null;

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  fallbackConfig?.stop();
  tlsWatch?.stop();
  defaultAddress.stop();
  for (const watcher of chainWatchers.values()) watcher.stop();
  nodes.stop();
  const closed = Promise.all([
    new Promise((resolve) => server.close(resolve)),
    tlsServer ? new Promise((resolve) => /** @type {import("node:tls").Server} */ (tlsServer).close(resolve)) : null,
    getwork?.close(),
    health.close(),
    metricsServer?.close(),
    store.stop(),
  ]);
  for (const [socket, session] of sessions) {
    session.close();
    socket.destroy();
  }
  await closed;
  await blockTracker?.stop();
  await pool?.end();
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
