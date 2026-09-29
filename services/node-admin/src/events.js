import { createPool, recordServiceEvent } from "@xeldash/db";

// Node actions recorded as service events: they show in the dashboard's recent events, reach
// live dashboards, and trigger alerts. Recording never holds up or fails the action itself.

/** @type {import("pg").Pool | null} */
let pool = null;

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
