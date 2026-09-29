import { createPool, recordServiceEvent } from "@xeldash/db";

// Node actions recorded as service events: they show in the dashboard's recent events, reach
// live dashboards, and trigger alerts. Recording never holds up or fails the action itself.

/** @type {import("pg").Pool | null} */
let pool = null;

/** The shared database pool, created on first use. */
export function database() {
  pool ??= createPool();
  return pool;
}

/**
 * Remove a worker from the dashboard's lists (nothing is deleted; it is listed again once it
 * mines again). Returns false when there is no such worker.
 * @param {string} address @param {string} name
 */
export async function hideWorker(address, name) {
  const result = await database().query(
    `UPDATE workers w SET hidden_at = now()
     FROM miners m WHERE m.id = w.miner_id AND m.address = $1 AND w.name = $2`,
    [address, name],
  );
  return (result.rowCount ?? 0) > 0;
}

/** @param {string} type @param {Record<string, unknown>} [payload] */
export function recordEvent(type, payload = {}) {
  try {
    pool ??= createPool();
  } catch (error) {
    console.warn(`Cannot record ${type}: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  recordServiceEvent(pool, type, payload)
    .catch((error) => console.warn(`Failed to record ${type}: ${error instanceof Error ? error.message : String(error)}`));
}

export async function closeEvents() {
  await pool?.end();
}
