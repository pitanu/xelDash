import { readFile } from "node:fs/promises";

// The XELIS nodes the API reads from, in the same priority order Stratum uses
// (XELIS_RPC_URLS, comma-separated; XELIS_RPC_URL for a single node).

/** @param {Partial<Record<string, string | undefined>>} env */
export function rpcUrlsFromEnv(env) {
  const raw = env.XELIS_RPC_URLS?.trim() || env.XELIS_RPC_URL?.trim() || "http://daemon:8080/json_rpc";
  return raw.split(",").map((url) => url.trim()).filter(Boolean);
}

const MINING_NODES_FILE = process.env.XELDASH_MINING_NODES_FILE ?? "/config/mining-nodes.json";

/**
 * The official node, when switched on as Stratum's mining fallback from the dashboard.
 * @returns {Promise<string | null>}
 */
export async function fallbackUrl() {
  try {
    const config = JSON.parse(await readFile(MINING_NODES_FILE, "utf8"));
    const url = config?.fallback?.enabled === true ? config.fallback.url : null;
    return typeof url === "string" && /^https?:\/\//.test(url) ? url : null;
  } catch {
    return null;
  }
}

/** Same naming as Stratum's node pool: the host, plus the port if it is not 8080. @param {string} url */
export function nodeLabel(url) {
  const { hostname, port } = new URL(url);
  return port && port !== "8080" ? `${hostname}:${port}` : hostname;
}

let rpcId = 0;

/** @param {string} url @param {string} method @param {number} timeoutMs */
export async function callNode(url, method, timeoutMs) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`Daemon RPC returned HTTP ${response.status}`);
  const body = await response.json();
  if (body.error) throw new Error(`Daemon RPC ${method} failed: ${body.error.message}`);
  return body.result;
}

/**
 * Call the first node that answers, in priority order, so the dashboard keeps working while
 * one node is down or being upgraded. Throws the last error if none answers.
 * @param {string[]} urls @param {string} method @param {number} [timeoutMs]
 */
export async function callAnyNode(urls, method, timeoutMs = 5_000) {
  /** @type {unknown} */
  let lastError = new Error("No node configured");
  for (const url of urls) {
    try {
      return await callNode(url, method, timeoutMs);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}
