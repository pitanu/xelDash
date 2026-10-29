import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createPool } from "@xeldash/db";
import { ADDRESS_PATTERN, clampLimit, getHashrateHistory, getMiner, getWorker, getBlockTotals, listBlocks, listEvents, listMiners, listProblems } from "./queries.js";
import { loadAlertConfig, watchAlerts } from "./alerts.js";
import { startLiveUpdates } from "./live.js";
import { getBlockEfforts, getLuck, getMedianBlockEffort, getRewardsHistory } from "./luck.js";
import { bestShareEnabled, getBestShare } from "./best-share.js";
import { callAnyNode, fallbackUrl, rpcUrlsFromEnv } from "./nodes.js";
import { getConnectInfo } from "./connect.js";
import { ACTIVITY_RANGES, getActivity } from "./activity.js";
import { CURRENCIES, getPrice } from "./price.js";
import { coinSymbol } from "./coin.js";
import { atomicToXel, toCsv } from "./csv.js";
import { handleIngest } from "./ingest.js";
import { getStatus } from "./status.js";
import { updateStatus } from "./update.js";
import { getUptime } from "./uptime.js";
import { isPublicView, publicModeFromEnv, publicModeWarnings, scrubIps } from "./public-mode.js";
import { hostAllowed, hostRulesFromEnv } from "./allowed-hosts.js";
import { ShortCache, publicCacheKey } from "./public-cache.js";

const port = Number.parseInt(process.env.API_PORT ?? "8081", 10);
const host = process.env.API_HOST ?? "0.0.0.0";
const nodeUrls = rpcUrlsFromEnv(process.env);
// Where the status page probes Stratum; the Compose service name by default.
const stratumHost = process.env.STRATUM_PROBE_HOST ?? "stratum";
const stratumPort = Number.parseInt(process.env.STRATUM_PROBE_PORT ?? "3333", 10);
// The XEL price comes from CoinGecko; XELDASH_PRICE=off keeps the server from contacting it.
// Only mainnet coins have a price, so other networks never show one.
const network = (process.env.XELIS_NETWORK ?? "devnet").toLowerCase();
const priceOff = (process.env.XELDASH_PRICE ?? "on").toLowerCase() === "off" ? "server" : network !== "mainnet" ? "network" : null;
const pool = createPool();
// Public mode: no IP addresses in anything a visitor receives (see public-mode.js).
const publicMode = publicModeFromEnv(process.env);
// Host names this API answers to (allowed-hosts.js): its port is published on this computer, where a website could reach it by DNS
// rebinding and read the operator's view.
const hostRules = hostRulesFromEnv(process.env);
// Best share (how close an address's shares came to a block), on unless XELDASH_BEST_SHARE=off; then its figures are null.
const bestShare = bestShareEnabled(process.env);
const HASHRATE_WINDOWS = Object.freeze([
  { key: "5m", seconds: 300, difficultyColumn: "difficulty_5m" },
  { key: "1h", seconds: 3600, difficultyColumn: "difficulty_1h" },
  { key: "24h", seconds: 86400, difficultyColumn: "difficulty_24h" },
]);
const DIFFICULTY_SCALE = 1_000_000_000_000n;

/** @param {bigint} scaled @param {number} decimals */
function formatScaled(scaled, decimals) {
  const base = 10n ** BigInt(decimals);
  const whole = scaled / base;
  const fraction = String(scaled % base).padStart(decimals, "0");
  return decimals > 0 ? `${whole}.${fraction}` : String(whole);
}

/** @param {string} value */
function positiveInteger(value) {
  if (!/^[1-9]\d*$/.test(value)) throw new Error("Daemon returned invalid network difficulty");
  return BigInt(value);
}

/** @param {string} value */
function decimalToDifficultyUnits(value) {
  const match = /^(0|[1-9]\d*)(?:\.(\d{1,12}))?$/.exec(value);
  if (!match) throw new Error("Database returned invalid share difficulty sum");
  return BigInt(match[1]) * DIFFICULTY_SCALE
    + BigInt((match[2] ?? "").padEnd(12, "0") || "0");
}

/** @param {Record<string, string>} activity @param {unknown} network */
function estimateMining(activity, network) {
  const networkDifficulty = positiveInteger(/** @type {{ difficulty: string }} */ (network).difficulty);
  return Object.fromEntries(HASHRATE_WINDOWS.map(({ key, seconds, difficultyColumn }) => {
    const shareDifficultyUnits = decimalToDifficultyUnits(activity[difficultyColumn] ?? "0");
    if (shareDifficultyUnits === 0n) {
      return [key, { windowSeconds: seconds, estimatedHashesPerSecond: null, expectedTimeToBlockSeconds: null }];
    }
    const hashrateMilli = shareDifficultyUnits * 1000n / (BigInt(seconds) * DIFFICULTY_SCALE);
    const ttbDeciseconds = networkDifficulty * BigInt(seconds) * 10n * DIFFICULTY_SCALE / shareDifficultyUnits;
    return [key, {
      windowSeconds: seconds,
      estimatedHashesPerSecond: formatScaled(hashrateMilli, 3),
      expectedTimeToBlockSeconds: formatScaled(ttbDeciseconds, 1),
    }];
  }));
}

// On a public server: answers by URL, and node calls by method, each worked out at most once every 2 seconds, so no amount or mix
// of requests from the internet makes this API call the XELIS node more often than that (see public-cache.js).
const publicAnswers = new ShortCache({ ttlMs: 2_000 });
const nodeAnswers = new ShortCache({ ttlMs: 2_000 });

/** The official node as a fallback, if it is switched on; never on a public server (its load must not reach node.xelis.io). */
async function officialFallback() {
  return publicMode ? null : fallbackUrl();
}

/** Our nodes in priority order, then the official node if it is on as the mining fallback. */
async function allNodeUrls() {
  const fallback = await officialFallback();
  return fallback && !nodeUrls.includes(fallback) ? [...nodeUrls, fallback] : nodeUrls;
}

/** The XELIS node did not answer (still starting, downloading or catching up, or stopped): not the API's own fault. */
class NodeUnavailable extends Error {}

/** @param {string} method @param {number} [timeoutMs] */
async function daemonCall(method, timeoutMs = 5_000) {
  try {
    if (publicMode) return await nodeAnswers.get(`call:${method}`, async () => callAnyNode(await allNodeUrls(), method, timeoutMs));
    return await callAnyNode(await allNodeUrls(), method, timeoutMs);
  } catch (error) {
    throw new NodeUnavailable(error instanceof Error ? error.message : String(error));
  }
}

// The overview's statistics change by the minute (and when we find a block), while dashboards ask on every new block of the network,
// every few seconds on mainnet: they are kept briefly and shared, and only the node's figures are fresh on each request.
const OVERVIEW_STATS_MS = 10_000;
/** @type {{ at: number, promise: Promise<Awaited<ReturnType<typeof getOverviewStats>>> } | null} */
let overviewStats = null;

async function getOverview() {
  if (!overviewStats || Date.now() - overviewStats.at >= OVERVIEW_STATS_MS) {
    const promise = getOverviewStats();
    overviewStats = { at: Date.now(), promise };
    promise.catch(() => { if (overviewStats?.promise === promise) overviewStats = null; });
  }
  const [node, network, stats] = await Promise.all([daemonCall("get_info"), daemonCall("get_difficulty"), overviewStats.promise]);
  return {
    node,
    network,
    miners: stats.miners,
    shares: stats.shares,
    miningEstimates: estimateMining(stats.shares, network),
    blocks: stats.blocks,
    luck: stats.luck,
  };
}

async function getOverviewStats() {
  const [activity, blocks] = await Promise.all([
    pool.query(`
      SELECT
        COALESCE(SUM(accepted) FILTER (WHERE bucket >= date_trunc('minute', now()) - interval '5 minutes' AND bucket < date_trunc('minute', now())), 0)::text AS accepted_5m,
        COALESCE(SUM(rejected) FILTER (WHERE bucket >= date_trunc('minute', now()) - interval '5 minutes' AND bucket < date_trunc('minute', now())), 0)::text AS rejected_5m,
        COALESCE(SUM(sum_difficulty) FILTER (WHERE bucket >= date_trunc('minute', now()) - interval '5 minutes' AND bucket < date_trunc('minute', now())), 0)::text AS difficulty_5m,
        COALESCE(SUM(accepted) FILTER (WHERE bucket >= date_trunc('minute', now()) - interval '1 hour' AND bucket < date_trunc('minute', now())), 0)::text AS accepted_1h,
        COALESCE(SUM(rejected) FILTER (WHERE bucket >= date_trunc('minute', now()) - interval '1 hour' AND bucket < date_trunc('minute', now())), 0)::text AS rejected_1h,
        COALESCE(SUM(sum_difficulty) FILTER (WHERE bucket >= date_trunc('minute', now()) - interval '1 hour' AND bucket < date_trunc('minute', now())), 0)::text AS difficulty_1h,
        COALESCE(SUM(accepted) FILTER (WHERE bucket >= date_trunc('minute', now()) - interval '24 hours' AND bucket < date_trunc('minute', now())), 0)::text AS accepted_24h,
        COALESCE(SUM(rejected) FILTER (WHERE bucket >= date_trunc('minute', now()) - interval '24 hours' AND bucket < date_trunc('minute', now())), 0)::text AS rejected_24h,
        COALESCE(SUM(sum_difficulty) FILTER (WHERE bucket >= date_trunc('minute', now()) - interval '24 hours' AND bucket < date_trunc('minute', now())), 0)::text AS difficulty_24h
      FROM worker_stats_1m
      WHERE bucket >= date_trunc('minute', now()) - interval '24 hours'
    `),
    pool.query(`
      SELECT status, COUNT(*)::text AS count, COUNT(*) FILTER (WHERE found_at >= now() - interval '24 hours')::text AS last_24h
      FROM blocks
      GROUP BY status
      ORDER BY status
    `),
  ]);

  const luck = { ...(await getLuck(pool)), medianBlockEffort: await getMedianBlockEffort(pool) };
  const workerCounts = await pool.query(`
    SELECT
      COUNT(DISTINCT w.id) FILTER (WHERE s.bucket >= date_trunc('minute', now()) - interval '4 minutes')::text AS active_workers,
      COUNT(DISTINCT w.miner_id) FILTER (WHERE s.bucket >= date_trunc('minute', now()) - interval '4 minutes')::text AS active_miners
    FROM workers w
    LEFT JOIN worker_stats_1m s ON s.worker_id = w.id
      AND s.bucket >= date_trunc('minute', now()) - interval '4 minutes'
  `);

  return { miners: workerCounts.rows[0], shares: activity.rows[0], blocks: blocks.rows, luck };
}

/** Decoded path segment, or null for a malformed %-escape. @param {string | undefined} segment */
function safeDecode(segment) {
  try {
    return decodeURIComponent(segment ?? "");
  } catch {
    return null;
  }
}

/** @param {import("node:http").ServerResponse} response @param {number} statusCode @param {unknown} value */
function writeJson(response, statusCode, value) {
  const body = JSON.stringify(value);
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(body);
}

export const server = createServer(async (request, response) => {
  if (!hostAllowed(request.headers.host, hostRules)) {
    writeJson(response, 421, { error: "unknown_host", message: "This dashboard does not answer to that host name; add it to XELDASH_ALLOWED_HOSTS if it is yours." });
    return;
  }
  const publicView = isPublicView(publicMode, request);
  // A public visitor's GET: the answer another visitor just got, or the one being worked out right now.
  const key = publicView ? publicCacheKey(request) : null;
  const cached = key ? await publicAnswers.lookup(key) : undefined;
  if (cached) {
    writeJson(response, cached.status, cached.body);
    return;
  }
  const entry = key ? publicAnswers.begin(key) : null;
  /** Every JSON answer; in the public view without IP addresses. @param {import("node:http").ServerResponse} res @param {number} statusCode @param {unknown} value */
  const sendJson = (res, statusCode, value) => {
    const body = publicView ? scrubIps(value) : value;
    entry?.complete({ status: statusCode, body });
    writeJson(res, statusCode, body);
  };
  try {
    await route(request, response, publicView, sendJson);
  } finally {
    entry?.abandon();
  }
});

/**
 * @param {import("node:http").IncomingMessage} request @param {import("node:http").ServerResponse} response @param {boolean} publicView
 * @param {(res: import("node:http").ServerResponse, statusCode: number, value: unknown) => void} sendJson
 */
async function route(request, response, publicView, sendJson) {
  /** @type {URL} */
  let url;
  try {
    url = new URL(request.url ?? "/", "http://localhost");
  } catch {
    sendJson(response, 400, { error: "bad_request" });
    return;
  }
  // A standby server's batches (a POST) and its readiness check; see ingest.js.
  if (url.pathname.startsWith("/api/v1/ingest")) {
    try {
      if (await handleIngest({ request, response, pathname: url.pathname, pool, secret: process.env.XELDASH_CLUSTER_SECRET, send: sendJson, publicMode,
        alerts: async () => {
          const c = await loadAlertConfig(process.env, join(process.env.CONFIG_DIR ?? "/config", "alerts.json"));
          return { discordWebhookUrl: c.discordWebhookUrl, telegramBotToken: c.telegramBotToken, telegramChatId: c.telegramChatId,
            webhookUrl: c.webhookUrl, dashboardUrl: c.dashboardUrl, events: [...c.events], workerOfflineMinutes: c.workerOfflineMinutes };
        } })) return;
    } catch (error) {
      console.error("Ingest failed:", error instanceof Error ? error.message : String(error));
      sendJson(response, 503, { error: "dependency_unavailable" });
      return;
    }
  }
  if (request.method !== "GET") {
    sendJson(response, 405, { error: "method_not_allowed" });
    return;
  }
  try {
    const { pathname, searchParams } = url;
    const address = searchParams.get("address");
    if (address !== null && !ADDRESS_PATTERN.test(address)) {
      sendJson(response, 400, { error: "invalid_address" });
      return;
    }
    // Worker names are only unique per miner, so a worker filter needs an address.
    const worker = searchParams.get("worker");
    if (worker !== null && (address === null || worker.length === 0 || worker.length > 128)) {
      sendJson(response, 400, { error: "invalid_worker" });
      return;
    }
    if (pathname === "/health") {
      // The API is healthy when it can serve: that needs the database, not the node. A node
      // that is down or still loading a snapshot is reported here and on the status page.
      await pool.query("SELECT 1");
      const height = await daemonCall("get_height", 2_000).catch(() => null);
      sendJson(response, 200, { status: "ok", nodeHeight: height });
      return;
    }

    if (pathname === "/api/v1/status") {
      const work = async () => getStatus({
        pool,
        nodeUrls,
        fallbackUrl: await officialFallback(),
        stratumHost,
        stratumPort,
      });
      // Each status asks every node twice and probes Stratum: once every 2 seconds at most on a public server.
      const status = publicMode ? await nodeAnswers.get("status", work) : await work();
      // Bans are a list of IP addresses: the public view does not list them at all.
      sendJson(response, 200, publicView ? { ...status, bans: [] } : status);
      return;
    }

    if (pathname === "/api/v1/connect") {
      sendJson(response, 200, await getConnectInfo(process.env, { publicMode, publicView }));
      return;
    }

    if (pathname === "/api/v1/price") {
      const currency = (searchParams.get("currency") ?? "usd").toLowerCase();
      if (priceOff) {
        sendJson(response, 200, { enabled: false, reason: priceOff, network, currencies: CURRENCIES, price: null });
        return;
      }
      if (!CURRENCIES.includes(currency)) {
        sendJson(response, 400, { error: "invalid_currency" });
        return;
      }
      sendJson(response, 200, { enabled: true, currencies: CURRENCIES, price: await getPrice(currency) });
      return;
    }

    if (pathname === "/api/v1/overview") {
      sendJson(response, 200, await getOverview());
      return;
    }

    if (pathname === "/api/v1/hashrate") {
      sendJson(response, 200, await getHashrateHistory(pool, { address, worker, range: searchParams.get("range") ?? "24h", bestShare }));
      return;
    }

    if (pathname === "/api/v1/miners") {
      sendJson(response, 200, { miners: await listMiners(pool) });
      return;
    }

    // When an address (or one of its workers) was mining, and what that time produced: see activity.js.
    if (pathname === "/api/v1/activity") {
      const range = searchParams.get("range") ?? "7d";
      if (address === null || !Object.hasOwn(ACTIVITY_RANGES, range)) {
        sendJson(response, 400, { error: address === null ? "address_required" : "invalid_range", ranges: Object.keys(ACTIVITY_RANGES) });
        return;
      }
      sendJson(response, 200, await getActivity(pool, { address, worker, range }));
      return;
    }

    const workerMatch = /^\/api\/v1\/miners\/([^/]+)\/workers\/([^/]+)$/.exec(pathname);
    if (workerMatch) {
      const minerAddress = safeDecode(workerMatch[1]);
      const workerName = safeDecode(workerMatch[2]);
      if (minerAddress === null || workerName === null || !ADDRESS_PATTERN.test(minerAddress)
          || workerName.length === 0 || workerName.length > 128) {
        sendJson(response, 400, { error: "invalid_worker" });
        return;
      }
      const found = await getWorker(pool, minerAddress, workerName);
      const best = found && bestShare ? await getBestShare(pool, { address: minerAddress, worker: workerName }) : null;
      sendJson(response, found ? 200 : 404, found ? { ...found, bestShare: best } : { error: "not_found" });
      return;
    }

    const minerMatch = /^\/api\/v1\/miners\/([^/]+)$/.exec(pathname);
    if (minerMatch) {
      const minerAddress = safeDecode(minerMatch[1]);
      if (minerAddress === null || !ADDRESS_PATTERN.test(minerAddress)) {
        sendJson(response, 400, { error: "invalid_address" });
        return;
      }
      const miner = await getMiner(pool, minerAddress);
      if (!miner) {
        sendJson(response, 404, { error: "not_found" });
        return;
      }
      const [luck, best] = await Promise.all([getLuck(pool, { address: minerAddress }), bestShare ? getBestShare(pool, { address: minerAddress }) : null]);
      sendJson(response, 200, { ...miner, luck, bestShare: best });
      return;
    }

    if (pathname === "/api/v1/activity.csv") {
      // Each stretch an address or worker was mining in the range (the latest 5,000), with what it produced.
      const range = searchParams.get("range") ?? "7d";
      if (address === null || !Object.hasOwn(ACTIVITY_RANGES, range)) {
        sendJson(response, 400, { error: address === null ? "address_required" : "invalid_range", ranges: Object.keys(ACTIVITY_RANGES) });
        return;
      }
      const activity = await getActivity(pool, { address, worker, range, work: true });
      const body = toCsv([
        ["started_at_utc", "ended_at_utc", "minutes", "hashrate_hs", "expected_blocks"],
        ...activity.stretches.map(([start, end], i) => {
          const minutes = Math.round((Date.parse(end) - Date.parse(start)) / 60_000);
          const work = activity.stretchWork?.[i];
          return [start, end, minutes, work ? (work.difficulty / (minutes * 60)).toFixed(2) : "", work ? work.expectedBlocks.toFixed(6) : ""];
        }),
      ]);
      response.writeHead(200, {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="xeldash-activity${worker ? "-worker" : ""}-${range}.csv"`,
        "content-length": Buffer.byteLength(body),
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      });
      response.end(body);
      return;
    }

    if (pathname === "/api/v1/blocks.csv") {
      // Every block on record (up to 100 000), for a spreadsheet or tax records.
      const [list, efforts] = await Promise.all([
        listBlocks(pool, { address, worker, limit: 100_000 }),
        getBlockEfforts(pool, { address }),
      ]);
      const body = toCsv([
        ["found_at_utc", "height", "topoheight", "hash", "status", `reward_${coinSymbol(network).toLowerCase()}`, "reward_atomic", "miner_address", "worker", "round_effort_percent"],
        ...list.map((b) => [
          b.foundAt, b.height, b.topoheight, b.hash, b.status, atomicToXel(b.reward), b.reward, b.address, b.worker,
          efforts.get(b.hash) == null ? "" : (Number(efforts.get(b.hash)) * 100).toFixed(2),
        ]),
      ]);
      response.writeHead(200, {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="xeldash-blocks${address ? "-miner" : ""}${worker ? "-worker" : ""}.csv"`,
        "content-length": Buffer.byteLength(body),
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      });
      response.end(body);
      return;
    }

    if (pathname === "/api/v1/blocks") {
      // Round effort per block: per miner when filtered by address, else across all miners.
      const [list, efforts, totals] = await Promise.all([
        listBlocks(pool, { address, worker, limit: clampLimit(searchParams.get("limit"), 50, 500) }),
        getBlockEfforts(pool, { address }),
        getBlockTotals(pool, { address, worker }),
      ]);
      sendJson(response, 200, { blocks: list.map((b) => ({ ...b, effort: efforts.get(b.hash) ?? null })), totals });
      return;
    }

    if (pathname === "/api/v1/uptime") {
      sendJson(response, 200, await getUptime(pool, { range: searchParams.get("range") ?? "7d" }));
      return;
    }

    if (pathname === "/api/v1/mining-health") {
      // Whether this server can give miners work right now. The cluster front door asks this to decide where to send miners;
      // it answers 503 when Stratum cannot mine or cannot be reached (so the dashboard being up is not enough to be chosen).
      const healthUrl = process.env.STRATUM_HEALTH_URL ?? "http://stratum:8096/healthz";
      let status = 503;
      let body = { ok: false, reason: "Stratum is not answering" };
      try {
        const reply = await fetch(healthUrl, { signal: AbortSignal.timeout(2_000) });
        status = reply.ok ? 200 : 503;
        body = await reply.json();
      } catch {
        // keep the default
      }
      sendJson(response, status, body);
      return;
    }

    if (pathname === "/api/v1/front-door") {
      // Whether a front door is set up and where the connected rigs came in (from Stratum's own status).
      const healthUrl = (process.env.STRATUM_HEALTH_URL ?? "http://stratum:8096/healthz").replace(/\/healthz$/, "/status");
      try {
        const body = await (await fetch(healthUrl, { signal: AbortSignal.timeout(2_000) })).json();
        // `from` lists the operator's own forwarder addresses: not for the public view.
        const frontDoor = body.frontDoor && publicView ? { viaFrontDoor: body.frontDoor.viaFrontDoor, direct: body.frontDoor.direct } : body.frontDoor;
        sendJson(response, 200, frontDoor ? { configured: true, ...frontDoor } : { configured: false });
      } catch {
        sendJson(response, 200, { configured: false });
      }
      return;
    }

    if (pathname === "/api/v1/version") {
      sendJson(response, 200, await updateStatus());
      return;
    }

    if (pathname === "/api/v1/rewards") {
      sendJson(response, 200, await getRewardsHistory(pool, { address, range: searchParams.get("range") ?? "90d" }));
      return;
    }

    if (pathname === "/api/v1/problems") {
      // Connection problems name the IP behind each failed login: the operator's view only.
      sendJson(response, 200, publicView ? { problems: [], hidden: true } : { problems: await listProblems(pool) });
      return;
    }

    if (pathname === "/api/v1/events") {
      // Recent events are the operator's (node updates, backups, disk, cluster): not for a public server's visitors. The database is
      // still asked, so the dashboard's "offline" notice, which uses this route as its check, keeps working.
      if (publicView) {
        await pool.query("SELECT 1");
        sendJson(response, 200, { events: [], hidden: true });
        return;
      }
      sendJson(response, 200, { events: await listEvents(pool, clampLimit(searchParams.get("limit"), 20, 200)) });
      return;
    }

    sendJson(response, 404, { error: "not_found" });
  } catch (error) {
    console.error("API request failed:", error instanceof Error ? error.message : String(error));
    // Say which: the dashboard tells "the node is not answering yet" apart from "the API cannot work".
    sendJson(response, 503, { error: error instanceof NodeUnavailable ? "node_unavailable" : "dependency_unavailable" });
  }
}

// Started only when run as the API (`node src/server.js`); tests import `server` and drive it themselves.
// import.meta.main is Node 24+; the path comparison covers older versions.
const isMain = import.meta.main ?? (Boolean(process.argv[1]) && resolve(process.argv[1]) === fileURLToPath(import.meta.url));
if (isMain) await start();

async function start() {
  for (const warning of publicModeWarnings(process.env)) console.warn(`Public mode: ${warning}`);
  if (publicMode) console.info("Public mode: visitors get no IP addresses, no connection problems and no node administration.");
  // Alerts also go to the operator's open dashboards, which show the kinds each browser chose as notifications.
  /** @type {ReturnType<typeof startLiveUpdates> | null} */
  let live = null;
  const relay = { active: () => live?.hasOperators() ?? false, push: (/** @type {unknown} */ alert) => live?.sendToOperators(alert) };
  // The reports' electricity (saved from the dashboard), today's reward per block, and the XEL price unless it is off here.
  const reportSources = {
    powerFile: join(process.env.CONFIG_DIR ?? "/config", "power.json"),
    rewardAtomic: async () => Number((await daemonCall("get_info"))?.miner_reward) || null,
    xelPrice: async (/** @type {string} */ currency) => (priceOff ? null : (await getPrice(currency))?.price ?? null),
  };
  const alerts = watchAlerts({ pool, env: process.env, file: join(process.env.CONFIG_DIR ?? "/config", "alerts.json"), relay, reportSources });
  // A public server has many more visitors: 1000 live connections in all (each visitor's own few are limited by the web server).
  live = startLiveUpdates({ server, pool, onNotification: (payload) => alerts?.handleNotification(payload), maxClients: publicMode ? 1_000 : 100,
    isPublic: (request) => isPublicView(publicMode, request), allowHost: (request) => hostAllowed(request.headers.host, hostRules) });

  server.listen(port, host, () => {
    console.info(`xelDash API listening on ${host}:${port}`);
  });

  async function shutdown() {
    server.close();
    alerts?.stop();
    await live?.stop();
    await pool.end();
  }

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
