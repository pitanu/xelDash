import { createServer } from "node:http";
import { createPool } from "@xeldash/db";
import { ADDRESS_PATTERN, clampLimit, getHashrateHistory, getMiner, getWorker, listBlocks, listEvents, listMiners } from "./queries.js";
import { alertConfigFromEnv, startAlerts } from "./alerts.js";
import { startLiveUpdates } from "./live.js";
import { callAnyNode, rpcUrlsFromEnv } from "./nodes.js";
import { getStatus } from "./status.js";

const port = Number.parseInt(process.env.API_PORT ?? "8081", 10);
const host = process.env.API_HOST ?? "0.0.0.0";
const nodeUrls = rpcUrlsFromEnv(process.env);
// Where the status page probes Stratum; the Compose service name by default.
const stratumHost = process.env.STRATUM_PROBE_HOST ?? "stratum";
const stratumPort = Number.parseInt(process.env.STRATUM_PROBE_PORT ?? "3333", 10);
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

/** @param {string} method @param {number} [timeoutMs] */
function daemonCall(method, timeoutMs = 5_000) {
  return callAnyNode(nodeUrls, method, timeoutMs);
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
  };
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

  try {
    const url = new URL(request.url ?? "/", "http://localhost");
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
      await pool.query("SELECT 1");
      const height = await daemonCall("get_height");
      sendJson(response, 200, { status: "ok", nodeHeight: height });
      return;
    }

    if (pathname === "/api/v1/status") {
      sendJson(response, 200, await getStatus({
        pool,
        nodeUrls,
        stratumHost,
        stratumPort,
      }));
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
      const minerAddress = decodeURIComponent(workerMatch[1] ?? "");
      const workerName = decodeURIComponent(workerMatch[2] ?? "");
      if (!ADDRESS_PATTERN.test(minerAddress) || workerName.length === 0 || workerName.length > 128) {
        sendJson(response, 400, { error: "invalid_worker" });
        return;
      }
      const found = await getWorker(pool, minerAddress, workerName);
      sendJson(response, found ? 200 : 404, found ?? { error: "not_found" });
      return;
    }

    const minerMatch = /^\/api\/v1\/miners\/([^/]+)$/.exec(pathname);
    if (minerMatch) {
      const minerAddress = decodeURIComponent(minerMatch[1] ?? "");
      if (!ADDRESS_PATTERN.test(minerAddress)) {
        sendJson(response, 400, { error: "invalid_address" });
        return;
      }
      const miner = await getMiner(pool, minerAddress);
      sendJson(response, miner ? 200 : 404, miner ?? { error: "not_found" });
      return;
    }

    if (pathname === "/api/v1/blocks") {
      sendJson(response, 200, { blocks: await listBlocks(pool, { address, worker, limit: clampLimit(searchParams.get("limit"), 50, 500) }) });
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

const alerts = startAlerts({ pool, config: alertConfigFromEnv(process.env) });
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
