import { createServer } from "node:http";
import { join } from "node:path";
import { createPool } from "@xeldash/db";
import { ADDRESS_PATTERN, clampLimit, getHashrateHistory, getMiner, getWorker, getBlockTotals, listBlocks, listEvents, listMiners, listProblems } from "./queries.js";
import { watchAlerts } from "./alerts.js";
import { startLiveUpdates } from "./live.js";
import { getBlockEfforts, getLuck, getMedianBlockEffort } from "./luck.js";
import { callAnyNode, fallbackUrl, rpcUrlsFromEnv } from "./nodes.js";
import { getConnectInfo } from "./connect.js";
import { CURRENCIES, getPrice } from "./price.js";
import { getStatus } from "./status.js";

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

/** Our nodes in priority order, then the official node if it is on as the mining fallback. */
async function allNodeUrls() {
  const fallback = await fallbackUrl();
  return fallback && !nodeUrls.includes(fallback) ? [...nodeUrls, fallback] : nodeUrls;
}

/** @param {string} method @param {number} [timeoutMs] */
async function daemonCall(method, timeoutMs = 5_000) {
  return callAnyNode(await allNodeUrls(), method, timeoutMs);
}

async function getOverview() {
  const [node, network, activity, blocks] = await Promise.all([
    daemonCall("get_info"),
    daemonCall("get_difficulty"),
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
    `),
    pool.query(`
      SELECT status, COUNT(*)::text AS count
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
  `);

  return {
    node,
    network,
    miners: workerCounts.rows[0],
    shares: activity.rows[0],
    miningEstimates: estimateMining(activity.rows[0], network),
    blocks: blocks.rows,
    luck,
  };
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
function sendJson(response, statusCode, value) {
  const body = JSON.stringify(value);
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(body);
}

const server = createServer(async (request, response) => {
  if (request.method !== "GET") {
    sendJson(response, 405, { error: "method_not_allowed" });
    return;
  }

  /** @type {URL} */
  let url;
  try {
    url = new URL(request.url ?? "/", "http://localhost");
  } catch {
    sendJson(response, 400, { error: "bad_request" });
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
      sendJson(response, 200, await getStatus({
        pool,
        nodeUrls,
        fallbackUrl: await fallbackUrl(),
        stratumHost,
        stratumPort,
      }));
      return;
    }

    if (pathname === "/api/v1/connect") {
      sendJson(response, 200, await getConnectInfo());
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
      sendJson(response, 200, await getHashrateHistory(pool, { address, worker, range: searchParams.get("range") ?? "24h" }));
      return;
    }

    if (pathname === "/api/v1/miners") {
      sendJson(response, 200, { miners: await listMiners(pool) });
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
      sendJson(response, found ? 200 : 404, found ?? { error: "not_found" });
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
      sendJson(response, miner ? 200 : 404, miner ? { ...miner, luck: await getLuck(pool, { address: minerAddress }) } : { error: "not_found" });
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

    if (pathname === "/api/v1/problems") {
      sendJson(response, 200, { problems: await listProblems(pool) });
      return;
    }

    if (pathname === "/api/v1/events") {
      sendJson(response, 200, { events: await listEvents(pool, clampLimit(searchParams.get("limit"), 20, 200)) });
      return;
    }

    sendJson(response, 404, { error: "not_found" });
  } catch (error) {
    console.error("API request failed:", error instanceof Error ? error.message : String(error));
    sendJson(response, 503, { error: "dependency_unavailable" });
  }
});

const alerts = watchAlerts({ pool, env: process.env, file: join(process.env.CONFIG_DIR ?? "/config", "alerts.json") });
const live = startLiveUpdates({ server, pool, onNotification: (payload) => alerts?.handleNotification(payload) });

server.listen(port, host, () => {
  console.info(`xelDash API listening on ${host}:${port}`);
});

async function shutdown() {
  server.close();
  alerts?.stop();
  await live.stop();
  await pool.end();
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
