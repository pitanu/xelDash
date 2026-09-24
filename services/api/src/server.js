import { createServer } from "node:http";
import { createPool } from "../../../packages/db/src/index.js";

const port = Number.parseInt(process.env.API_PORT ?? "8081", 10);
const host = process.env.API_HOST ?? "0.0.0.0";
const daemonUrl = process.env.XELIS_RPC_URL ?? "http://daemon:8080/json_rpc";
const pool = createPool();
let rpcId = 0;

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
        COALESCE(SUM(accepted) FILTER (WHERE bucket >= now() - interval '5 minutes'), 0)::text AS accepted_5m,
        COALESCE(SUM(rejected) FILTER (WHERE bucket >= now() - interval '5 minutes'), 0)::text AS rejected_5m,
        COALESCE(SUM(sum_difficulty) FILTER (WHERE bucket >= now() - interval '5 minutes'), 0)::text AS difficulty_5m,
        COALESCE(SUM(accepted) FILTER (WHERE bucket >= now() - interval '1 hour'), 0)::text AS accepted_1h,
        COALESCE(SUM(rejected) FILTER (WHERE bucket >= now() - interval '1 hour'), 0)::text AS rejected_1h,
        COALESCE(SUM(sum_difficulty) FILTER (WHERE bucket >= now() - interval '1 hour'), 0)::text AS difficulty_1h,
        COALESCE(SUM(accepted) FILTER (WHERE bucket >= now() - interval '24 hours'), 0)::text AS accepted_24h,
        COALESCE(SUM(rejected) FILTER (WHERE bucket >= now() - interval '24 hours'), 0)::text AS rejected_24h,
        COALESCE(SUM(sum_difficulty) FILTER (WHERE bucket >= now() - interval '24 hours'), 0)::text AS difficulty_24h
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
      COUNT(DISTINCT w.id) FILTER (WHERE s.bucket >= now() - interval '5 minutes')::text AS active_workers,
      COUNT(DISTINCT w.miner_id) FILTER (WHERE s.bucket >= now() - interval '5 minutes')::text AS active_miners
    FROM workers w
    LEFT JOIN worker_stats_1m s ON s.worker_id = w.id
  `);

  return {
    node,
    network,
    miners: workerCounts.rows[0],
    shares: activity.rows[0],
    blocks: blocks.rows,
    note: "Share difficulty totals are raw measurements. XELIS difficulty-to-hash conversion and TTB are not yet configured.",
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
    if (request.url === "/health") {
      await pool.query("SELECT 1");
      const height = await daemonCall("get_height");
      sendJson(response, 200, { status: "ok", nodeHeight: height });
      return;
    }

    if (request.url === "/api/v1/overview") {
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
