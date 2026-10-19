// Best share: how close an address's (or one worker's) best accepted share came to a block, as a fraction of a block (1 = a block).
// Kept per worker and minute (worker_stats_1m.best_share) and per hour after the minute stats are gone (worker_stats_1h). Per
// address only: there is no figure across everyone's rigs.
//
// The round is the address's, as for effort (luck.js): since its last found block. Unlike effort, the minute of that block is left
// out, or the block itself (100% or more) would be the round's best share all through the next round.

/** @typedef {import("pg").Pool} PgPool */

/**
 * @param {PgPool} pool @param {{ address: string, worker?: string | null }} filter
 * @returns {Promise<{ round: number | null, day: number | null, ever: number | null }>}
 */
export async function getBestShare(pool, { address, worker = null }) {
  const result = await pool.query(
    `WITH stats AS (
       SELECT s.bucket, s.worker_id, s.best_share FROM worker_stats_1m s WHERE s.best_share IS NOT NULL
       UNION ALL
       SELECT h.bucket, h.worker_id, h.best_share FROM worker_stats_1h h
       WHERE h.best_share IS NOT NULL
         AND h.bucket < COALESCE((SELECT date_trunc('hour', min(bucket)) FROM worker_stats_1m), 'infinity')
     ),
     mine AS (
       SELECT st.bucket, st.best_share FROM stats st
       JOIN workers w ON w.id = st.worker_id
       JOIN miners m ON m.id = w.miner_id
       WHERE m.address = $1 AND ($2::text IS NULL OR w.name = $2)
     ),
     last_block AS (
       SELECT max(b.found_at) AS at FROM blocks b JOIN miners m ON m.id = b.miner_id
       WHERE m.address = $1 AND b.status <> 'rejected'
     )
     SELECT
       (SELECT max(best_share) FROM mine) AS ever,
       (SELECT max(best_share) FROM mine WHERE bucket >= date_trunc('minute', now()) - interval '24 hours') AS day,
       (SELECT max(mine.best_share) FROM mine, last_block
        WHERE last_block.at IS NULL OR mine.bucket > date_trunc('minute', last_block.at)) AS round`,
    [address, worker],
  );
  const row = result.rows[0] ?? {};
  /** @param {unknown} value */
  const num = (value) => (value === null || value === undefined ? null : Number(value));
  return { round: num(row.round), day: num(row.day), ever: num(row.ever) };
}

/** Whether best share is on (XELDASH_BEST_SHARE, on unless off). @param {Partial<Record<string, string | undefined>>} env */
export function bestShareEnabled(env) {
  return !/^(off|false|0|no)$/i.test((env.XELDASH_BEST_SHARE ?? "").trim());
}
