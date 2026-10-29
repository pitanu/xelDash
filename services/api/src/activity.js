// When a rig was mining, and what that time produced. Some rigs are workstations that mine a few hours a day: averaged over the
// whole day they look slow, though they run at full speed while on. A minute counts as "on" when the rig sent a share in it; gaps of
// up to BRIDGE_MINUTES without one are still on (a slow rig, or a high difficulty, can go a few minutes between shares). The minutes
// on, joined into stretches, are returned as they are (UTC), so the browser can place them in its own time zone's hours and days.

/** @typedef {import("pg").Pool} PgPool */

/** Minutes without a share that still count as on. */
export const BRIDGE_MINUTES = 3;
/** The ranges offered, in minutes. Minute stats are kept 90 days by default (RETENTION_MINUTE_STATS_DAYS). */
export const ACTIVITY_RANGES = /** @type {Record<string, number>} */ ({ "24h": 1440, "7d": 7 * 1440, "30d": 30 * 1440, "90d": 90 * 1440 });
/** At most this many stretches are listed (the latest); the totals always cover the whole range. */
const MAX_STRETCHES = 5_000;

/**
 * Time on, hashrate while on, and work against expectation, for one address or one of its workers.
 * The period starts at the range's start, or where the minute stats begin if that is later (a new install, or a shorter
 * RETENTION_MINUTE_STATS_DAYS), so time before anything was tracked does not count as off.
 * With `work`, each stretch also carries the work its shares proved and the blocks that work was expected to find (for the CSV).
 * `minutes` instead of a range: that many minutes up to `now` (a calendar month for the reports).
 * @param {PgPool} pool @param {{ address: string, worker?: string | null, range?: string, now?: Date, work?: boolean, minutes?: number }} filter
 */
export async function getActivity(pool, { address, worker = null, range = "7d", now = new Date(), work = false, minutes }) {
  const rangeMinutes = minutes ?? ACTIVITY_RANGES[range];
  if (!rangeMinutes) throw new RangeError(`range must be one of ${Object.keys(ACTIVITY_RANGES).join(", ")}`);
  // Whole minutes: the current one is still filling.
  const to = new Date(Math.floor(now.getTime() / 60_000) * 60_000);
  const rangeFrom = new Date(to.getTime() - rangeMinutes * 60_000);
  const result = await pool.query(
    `WITH tracked AS (SELECT min(bucket) AS since FROM worker_stats_1m),
     mins AS (
       SELECT s.bucket, sum(s.sum_difficulty) AS difficulty, sum(s.sum_effort) AS effort
       FROM worker_stats_1m s
       JOIN workers w ON w.id = s.worker_id
       JOIN miners m ON m.id = w.miner_id
       WHERE m.address = $1 AND ($2::text IS NULL OR w.name = $2)
         AND s.bucket >= $3 AND s.bucket < $4 AND s.accepted + s.rejected > 0
       GROUP BY s.bucket
     ),
     -- A new stretch starts where the gap to the previous minute with shares is more than BRIDGE_MINUTES missing minutes.
     marked AS (
       SELECT bucket, difficulty, effort,
              CASE WHEN bucket - lag(bucket) OVER (ORDER BY bucket) <= $5::interval THEN 0 ELSE 1 END AS starts
       FROM mins
     ),
     numbered AS (SELECT bucket, difficulty, effort, sum(starts) OVER (ORDER BY bucket) AS stretch FROM marked),
     stretches AS (
       SELECT min(bucket) AS start_at, max(bucket) + interval '1 minute' AS end_at, sum(difficulty) AS difficulty, sum(effort) AS effort
       FROM numbered GROUP BY stretch
     ),
     found AS (
       SELECT count(*) AS n FROM blocks b
       JOIN workers w ON w.id = b.worker_id
       JOIN miners m ON m.id = w.miner_id
       WHERE m.address = $1 AND ($2::text IS NULL OR w.name = $2) AND b.status <> 'rejected' AND b.found_at >= $3 AND b.found_at < $4
     )
     SELECT (SELECT since FROM tracked) AS tracked_since,
            (SELECT n FROM found)::text AS found,
            COALESCE((SELECT sum(extract(epoch FROM end_at - start_at)) FROM stretches), 0)::text AS on_seconds,
            COALESCE((SELECT sum(difficulty) FROM stretches), 0)::text AS difficulty,
            COALESCE((SELECT sum(effort) FROM stretches), 0)::text AS effort,
            COALESCE((SELECT json_agg(json_build_array(start_at, end_at, difficulty::text, effort::text) ORDER BY start_at)
                      FROM (SELECT * FROM stretches ORDER BY start_at DESC LIMIT ${MAX_STRETCHES}) latest), '[]') AS stretches`,
    [address, worker, rangeFrom, to, `${BRIDGE_MINUTES + 1} minutes`],
  );
  const row = result.rows[0];
  const since = row.tracked_since ? new Date(row.tracked_since) : null;
  const from = since && since > rangeFrom ? since : rangeFrom;
  const periodMinutes = Math.max(0, Math.round((to.getTime() - from.getTime()) / 60_000));
  const onMinutes = Math.round(Number(row.on_seconds) / 60);
  const expectedBlocks = Number(row.effort);
  const foundBlocks = Number(row.found);
  return {
    range,
    from: from.toISOString(),
    to: to.toISOString(),
    periodMinutes,
    onMinutes,
    // Share of the period the rig was on, 0 to 1; null before anything was tracked.
    dutyCycle: periodMinutes > 0 ? Math.min(1, onMinutes / periodMinutes) : null,
    averageOnMinutesPerDay: periodMinutes > 0 ? (onMinutes / periodMinutes) * 1440 : null,
    // The work its shares proved, per second it was on (H/s); null when it was never on.
    hashrateWhileOn: onMinutes > 0 ? Number(row.difficulty) / (onMinutes * 60) : null,
    // Blocks its work was expected to find (sum of share difficulty / network difficulty), blocks it found, and their ratio.
    expectedBlocks,
    foundBlocks,
    luck: expectedBlocks > 0 ? foundBlocks / expectedBlocks : null,
    bridgeMinutes: BRIDGE_MINUTES,
    /** The stretches it was on, oldest first, as [start, end] ISO times (UTC). */
    stretches: /** @type {[string, string][]} */ (row.stretches.map((/** @type {string[]} */ [start, end]) => [new Date(start).toISOString(), new Date(end).toISOString()])),
    ...(work ? {
      /** Per stretch, in the same order: the share difficulty summed (hashes) and the blocks that work was expected to find. */
      stretchWork: /** @type {{ difficulty: number, expectedBlocks: number }[]} */ (row.stretches.map((/** @type {string[]} */ [, , difficulty, effort]) => ({
        difficulty: Number(difficulty), expectedBlocks: Number(effort),
      }))),
    } : {}),
  };
}
