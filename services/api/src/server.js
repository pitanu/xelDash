import { createServer } from "node:http";
import { createPool } from "@xeldash/db";

const port = Number.parseInt(process.env.API_PORT ?? "8081", 10);
const host = process.env.API_HOST ?? "0.0.0.0";
const daemonUrl = process.env.XELIS_RPC_URL ?? "http://daemon:8080/json_rpc";
const pool = createPool();
let rpcId = 0;
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

/** @param {string} method */
async function daemonCall(method) {
  const response = await fetch(daemonUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method }),
    signal: AbortSignal.timeout(5_000),
  });

  if (!response.ok) throw new Error(`Daemon RPC returned HTTP ${response.status}`);
  const body = await response.json();
  if (body.error) throw new Error(`Daemon RPC ${method} failed: ${body.error.message}`);
  return body.result;
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
    const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    if (pathname === "/health") {
      await pool.query("SELECT 1");
      const height = await daemonCall("get_height");
      sendJson(response, 200, { status: "ok", nodeHeight: height });
      return;
    }

    if (pathname === "/api/v1/overview") {
      sendJson(response, 200, await getOverview());
      return;
    }

    sendJson(response, 404, { error: "not_found" });
  } catch (error) {
    console.error("API request failed:", error instanceof Error ? error.message : String(error));
    sendJson(response, 503, { error: "dependency_unavailable" });
  }
});

server.listen(port, host, () => {
  console.info(`xelDash API listening on ${host}:${port}`);
});

async function shutdown() {
  server.close();
  await pool.end();
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
