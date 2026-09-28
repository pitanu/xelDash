// Mining effort and luck. Every accepted share adds share difficulty / network difficulty to
// sum_effort, so a sum of 1.0 is the work that is expected to find one block. A round is the
// work between two found blocks; its effort is that sum as a percentage (100% = exactly the
// expected work). Luck is blocks found / blocks expected.
//
// Rounds are split on minute buckets: a block ends the round made of every bucket from the
// previous block's minute up to (not including) its own, so each bucket counts once.

/** @typedef {import("pg").Pool} PgPool */

// Per-minute stats where they exist, hourly rollups before that.
const STATS = `
  stats AS (
    SELECT s.bucket, s.worker_id, s.sum_effort FROM worker_stats_1m s
    UNION ALL
    SELECT h.bucket, h.worker_id, h.sum_effort FROM worker_stats_1h h
    WHERE h.bucket < COALESCE((SELECT date_trunc('hour', min(bucket)) FROM worker_stats_1m), 'infinity')
  ),
  mine AS (
    SELECT st.bucket, st.sum_effort FROM stats st
    JOIN workers w ON w.id = st.worker_id
    JOIN miners m ON m.id = w.miner_id
    WHERE $1::text IS NULL OR m.address = $1
  ),
  found AS (
    SELECT b.hash, b.found_at FROM blocks b
    LEFT JOIN miners m ON m.id = b.miner_id
    WHERE b.status <> 'rejected' AND ($1::text IS NULL OR m.address = $1)
  )`;

/** @param {string | null} value */
function num(value) {
  return value === null ? null : Number(value);
}

/**
 * Luck for everyone, or for one miner address. Effort is tracked from the first share after
 * the effort migration (trackedSince); blocks before that are not counted.
 * @param {PgPool} pool @param {{ address?: string | null }} [filter]
 */
export async function getLuck(pool, { address = null } = {}) {
  const result = await pool.query(
    `WITH ${STATS},
     tracked AS (SELECT min(bucket) AS since FROM mine WHERE sum_effort > 0),
     last_block AS (SELECT max(found_at) AS at FROM found)
     SELECT
       (SELECT since FROM tracked) AS tracked_since,
       (SELECT COALESCE(sum(sum_effort), 0)::text FROM mine) AS expected_blocks,
       (SELECT count(*)::text FROM found, tracked WHERE found.found_at >= tracked.since) AS blocks_found,
       (SELECT at FROM last_block) AS last_block_at,
       (SELECT COALESCE(sum(sum_effort), 0)::text FROM mine, last_block
        WHERE last_block.at IS NULL OR mine.bucket >= date_trunc('minute', last_block.at)) AS round_effort`,
    [address],
  );
  const row = result.rows[0];
  const expected = Number(row.expected_blocks);
  const found = Number(row.blocks_found);
  const roundStartedAt = row.last_block_at && (!row.tracked_since || row.last_block_at >= row.tracked_since)
    ? row.last_block_at : row.tracked_since;
  return {
    trackedSince: row.tracked_since?.toISOString() ?? null,
    expectedBlocks: expected,
    blocksFound: found,
    // Blocks found per block expected; 1 is exactly average. Undefined until there is work.
    luck: expected > 0 ? found / expected : null,
    round: {
      startedAt: roundStartedAt?.toISOString() ?? null,
      // Effort of the round in progress: 1 = 100% of the expected work for one block.
      effort: num(row.round_effort),
    },
  };
}

/**
 * The effort of the round each block ended, keyed by block hash. Null for a round that
 * started before effort was tracked, whose work is only partly known.
 * @param {PgPool} pool @param {{ address?: string | null }} [filter]
 * @returns {Promise<Map<string, number | null>>}
 */
export async function getBlockEfforts(pool, { address = null } = {}) {
  const result = await pool.query(
    `WITH ${STATS},
     tracked AS (SELECT min(bucket) AS since FROM mine WHERE sum_effort > 0),
     first_stats AS (SELECT min(bucket) AS at FROM mine),
     rounds AS (SELECT hash, found_at, lag(found_at) OVER (ORDER BY found_at) AS previous FROM found)
     SELECT r.hash,
       CASE
         WHEN tracked.since IS NULL THEN NULL
         WHEN COALESCE(r.previous, first_stats.at) < tracked.since THEN NULL
         ELSE (SELECT COALESCE(sum(sum_effort), 0) FROM mine
               WHERE (r.previous IS NULL OR mine.bucket >= date_trunc('minute', r.previous))
                 AND mine.bucket < date_trunc('minute', r.found_at))::text
       END AS effort
     FROM rounds r, tracked, first_stats`,
    [address],
  );
  return new Map(result.rows.map((row) => [row.hash, num(row.effort)]));
}
