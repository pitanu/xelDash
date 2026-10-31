// Blocks found per day, for the dashboard's block calendar. Days are the visitor's own (the browser sends its time zone), so a
// block found at 01:00 local time is not counted on the day before, as it would be by UTC days.

/** @typedef {import("pg").Pool} PgPool */

export const BLOCK_DAY_RANGES = /** @type {Record<string, number>} */ ({ "90d": 90, "1y": 365 });

/**
 * The IANA time zone given, if both this process and a database are likely to know it, else UTC. @param {string | null} value
 * @returns {string}
 */
export function timeZoneOrUtc(value) {
  if (!value || value.length > 64 || !/^[A-Za-z][A-Za-z0-9_+\-/]*$/.test(value)) return "UTC";
  try {
    return new Intl.DateTimeFormat("en", { timeZone: value }).resolvedOptions().timeZone;
  } catch {
    return "UTC";
  }
}

/**
 * Blocks found on each day of the range that had any, oldest first, in time zone `timeZone`; orphaned ones are counted in
 * `blocks` and again in `orphaned` (they were found, but earned nothing). Rejected blocks are not found blocks.
 * @param {PgPool} pool @param {{ address?: string | null, worker?: string | null, range?: string, timeZone?: string }} filter
 */
export async function getBlockDays(pool, { address = null, worker = null, range = "1y", timeZone = "UTC" }) {
  const days = BLOCK_DAY_RANGES[range];
  if (!days) throw new RangeError(`range must be one of ${Object.keys(BLOCK_DAY_RANGES).join(", ")}`);
  const query = (/** @type {string} */ zone) => pool.query(
    `WITH bounds AS (SELECT (date_trunc('day', now() AT TIME ZONE $1) - ($2::int - 1) * interval '1 day') AS first_day)
     SELECT to_char(date_trunc('day', b.found_at AT TIME ZONE $1), 'YYYY-MM-DD') AS day,
            count(*)::int AS blocks, count(*) FILTER (WHERE b.status = 'orphaned')::int AS orphaned
     FROM blocks b
     LEFT JOIN miners m ON m.id = b.miner_id
     LEFT JOIN workers w ON w.id = b.worker_id, bounds
     WHERE b.status <> 'rejected' AND b.found_at >= bounds.first_day AT TIME ZONE $1
       AND ($3::text IS NULL OR m.address = $3) AND ($4::text IS NULL OR w.name = $4)
     GROUP BY 1
     ORDER BY 1`,
    [zone, days, address, worker],
  );
  let zone = timeZone;
  let result;
  try {
    result = await query(zone);
  } catch (error) {
    // A zone this process knows but the database does not (older time zone data): UTC days rather than no answer.
    if (/** @type {{ code?: string }} */ (error).code !== "22023" || zone === "UTC") throw error;
    zone = "UTC";
    result = await query(zone);
  }
  return {
    range,
    timeZone: zone,
    days: result.rows.map((row) => ({ day: row.day, blocks: row.blocks, orphaned: row.orphaned })),
  };
}
