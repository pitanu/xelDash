/** @typedef {import("pg").Pool} PgPool */
/** @typedef {{ rawShareDays: number, minuteStatsDays: number }} RetentionConfig */

/** @type {RetentionConfig} */
export const DEFAULT_RETENTION = Object.freeze({ rawShareDays: 7, minuteStatsDays: 90 });
const DELETE_BATCH = 10_000;

/** @param {Partial<Record<string, string | undefined>>} env @returns {RetentionConfig} */
export function retentionConfigFromEnv(env) {
  /** @param {string} name @param {number} fallback */
  const read = (name, fallback) => {
    const value = env[name] === undefined || env[name] === "" ? fallback : Number(env[name]);
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive number of days`);
    return value;
  };
  return {
    rawShareDays: read("RETENTION_RAW_SHARE_DAYS", DEFAULT_RETENTION.rawShareDays),
    minuteStatsDays: read("RETENTION_MINUTE_STATS_DAYS", DEFAULT_RETENTION.minuteStatsDays),
  };
}

/**
 * Roll completed hours up into worker_stats_1h. Recomputes from the hour before the latest
 * rolled one, so it is idempotent and picks up rows that landed after the previous run.
 * @param {PgPool} pool
 */
export async function rollUpHourlyStats(pool) {
  const result = await pool.query(
    `INSERT INTO worker_stats_1h (bucket, worker_id, accepted, rejected, sum_difficulty)
     SELECT date_trunc('hour', bucket), worker_id, SUM(accepted), SUM(rejected), SUM(sum_difficulty)
     FROM worker_stats_1m
     WHERE bucket >= COALESCE((SELECT max(bucket) FROM worker_stats_1h) - interval '1 hour', '-infinity')
       AND bucket < date_trunc('hour', now())
     GROUP BY 1, 2
     ON CONFLICT (bucket, worker_id) DO UPDATE SET
       accepted = EXCLUDED.accepted,
       rejected = EXCLUDED.rejected,
       sum_difficulty = EXCLUDED.sum_difficulty`,
  );
  return result.rowCount ?? 0;
}

/**
 * Delete in batches so a large backlog never holds long locks against share inserts.
 * @param {PgPool} pool @param {string} sql Must delete at most $2 rows older than $1.
 * @param {string} age
 */
async function deleteInBatches(pool, sql, age) {
  let total = 0;
  for (;;) {
    const result = await pool.query(sql, [age, DELETE_BATCH]);
    total += result.rowCount ?? 0;
    if ((result.rowCount ?? 0) < DELETE_BATCH) return total;
  }
}

/**
 * Roll up hourly stats, then drop raw shares and minute stats past retention. Rolling up
 * first means minute stats are never deleted before they are summarized.
 * @param {PgPool} pool @param {RetentionConfig} config
 */
export async function runRetention(pool, config) {
  const rolledUp = await rollUpHourlyStats(pool);
  const shares = await deleteInBatches(
    pool,
    `DELETE FROM shares WHERE id IN (
       SELECT id FROM shares WHERE created_at < now() - $1::interval LIMIT $2)`,
    `${config.rawShareDays} days`,
  );
  const minuteStats = await deleteInBatches(
    pool,
    `DELETE FROM worker_stats_1m WHERE (bucket, worker_id) IN (
       SELECT bucket, worker_id FROM worker_stats_1m
       WHERE bucket < date_trunc('hour', now()) - $1::interval LIMIT $2)`,
    `${config.minuteStatsDays} days`,
  );
  return { rolledUp, shares, minuteStats };
}
