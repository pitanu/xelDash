/** @typedef {import("pg").Pool} PgPool */
/**
 * ipDays: how long miners' IP addresses are kept (a worker's last address, the address in connection and login problems, expired
 * bans); null keeps them as long as what they belong to (the default).
 * @typedef {{ rawShareDays: number, minuteStatsDays: number, eventDays: number, unusedWorkerDays?: number, ipDays?: number | null }} RetentionConfig
 */

/** @type {RetentionConfig} */
export const DEFAULT_RETENTION = Object.freeze({ rawShareDays: 7, minuteStatsDays: 90, eventDays: 365, unusedWorkerDays: 1 });
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
    eventDays: read("RETENTION_EVENT_DAYS", DEFAULT_RETENTION.eventDays),
    unusedWorkerDays: read("RETENTION_UNUSED_WORKER_DAYS", /** @type {number} */ (DEFAULT_RETENTION.unusedWorkerDays)),
    // Off unless set: IP addresses are then kept as long as the rows they are in.
    ipDays: env.RETENTION_IP_DAYS === undefined || env.RETENTION_IP_DAYS === "" ? null : read("RETENTION_IP_DAYS", 1),
  };
}

/**
 * Roll completed hours up into worker_stats_1h. Recomputes from the hour before the latest
 * rolled one, so it is idempotent and picks up rows that landed after the previous run. Records that
 * arrive late (a journal replayed after an outage, a standby server's batch) carry their original
 * time and land in older minutes, so the last `lookbackDays` are recomputed as well; only whole hours
 * that still have all their minute rows are touched (see runRetention).
 * @param {PgPool} pool @param {{ lookbackDays?: number }} [options]
 */
export async function rollUpHourlyStats(pool, { lookbackDays = 0 } = {}) {
  const result = await pool.query(
    `INSERT INTO worker_stats_1h (bucket, worker_id, accepted, rejected, stale, sum_difficulty, sum_effort, best_share)
     SELECT date_trunc('hour', bucket), worker_id, SUM(accepted), SUM(rejected), SUM(stale), SUM(sum_difficulty), SUM(sum_effort), MAX(best_share)
     FROM worker_stats_1m
     WHERE bucket >= LEAST(
         COALESCE((SELECT max(bucket) FROM worker_stats_1h) - interval '1 hour', '-infinity'),
         date_trunc('hour', now()) - $1::interval)
       AND bucket < date_trunc('hour', now())
     GROUP BY 1, 2
     ON CONFLICT (bucket, worker_id) DO UPDATE SET
       accepted = EXCLUDED.accepted,
       rejected = EXCLUDED.rejected,
       stale = EXCLUDED.stale,
       sum_difficulty = EXCLUDED.sum_difficulty,
       sum_effort = EXCLUDED.sum_effort,
       best_share = EXCLUDED.best_share`,
    [`${lookbackDays} days`],
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
  // Late records can only be in minutes that still exist: stay inside the minute-stats retention, so no hour is ever recomputed from a
  // partly deleted set of minutes.
  const rolledUp = await rollUpHourlyStats(pool, { lookbackDays: Math.max(0, Math.min(7, config.minuteStatsDays - 1)) });
  // Nothing writes raw shares since migration 009; the rows from before it age out here.
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
  // Reject reasons are only shown for the last day, but are kept as long as the minute stats they belong to.
  const rejects = await deleteInBatches(
    pool,
    `DELETE FROM worker_rejects_1m WHERE (worker_id, bucket, reason) IN (
       SELECT worker_id, bucket, reason FROM worker_rejects_1m
       WHERE bucket < date_trunc('hour', now()) - $1::interval LIMIT $2)`,
    `${config.minuteStatsDays} days`,
  );
  // Events (node changes, problems, alerts' sources) and bans would otherwise only ever grow. Hourly stats and blocks are kept.
  const eventAge = `${config.eventDays} days`;
  const events = await deleteInBatches(
    pool,
    `DELETE FROM service_events WHERE id IN (
       SELECT id FROM service_events WHERE created_at < now() - $1::interval LIMIT $2)`,
    eventAge,
  );
  const bans = await deleteInBatches(
    pool,
    `DELETE FROM bans WHERE id IN (
       SELECT id FROM bans WHERE COALESCE(until, created_at) < now() - $1::interval LIMIT $2)`,
    eventAge,
  );
  // Logins that never mined: a worker that has not logged in, sent a share or found a block for unusedWorkerDays, and never had a share
  // accepted (a typo in a worker name, a miner that gave up, or names made up to fill the database). A worker that ever mined is kept.
  const unusedAge = `${config.unusedWorkerDays ?? DEFAULT_RETENTION.unusedWorkerDays} days`;
  const unusedWorkers = await deleteInBatches(
    pool,
    `DELETE FROM workers WHERE id IN (
       SELECT w.id FROM workers w
       WHERE w.last_seen < now() - $1::interval
         AND NOT EXISTS (SELECT 1 FROM worker_stats_1m m WHERE m.worker_id = w.id AND (m.accepted > 0 OR m.bucket >= now() - $1::interval))
         AND NOT EXISTS (SELECT 1 FROM worker_stats_1h h WHERE h.worker_id = w.id AND h.accepted > 0)
         AND NOT EXISTS (SELECT 1 FROM blocks b WHERE b.worker_id = w.id)
       LIMIT $2)`,
    unusedAge,
  );
  // Then addresses left with no worker and no block.
  const unusedMiners = await deleteInBatches(
    pool,
    `DELETE FROM miners WHERE id IN (
       SELECT m.id FROM miners m
       WHERE m.last_seen < now() - $1::interval
         AND NOT EXISTS (SELECT 1 FROM workers w WHERE w.miner_id = m.id)
         AND NOT EXISTS (SELECT 1 FROM blocks b WHERE b.miner_id = m.id)
       LIMIT $2)`,
    unusedAge,
  );
  // IP addresses kept no longer than ipDays (RETENTION_IP_DAYS; off by default): a worker not seen for that long loses its last
  // address, older events lose the address in their payload (the event itself stays), and bans that ended that long ago go. A ban
  // still in force keeps its address, or it could not be enforced.
  let ips = 0;
  if (config.ipDays) {
    const ipAge = `${config.ipDays} days`;
    ips += await deleteInBatches(
      pool,
      `UPDATE workers SET last_ip = NULL WHERE id IN (
         SELECT id FROM workers WHERE last_ip IS NOT NULL AND last_seen < now() - $1::interval LIMIT $2)`,
      ipAge,
    );
    ips += await deleteInBatches(
      pool,
      `UPDATE service_events SET payload = payload - 'ip' WHERE id IN (
         SELECT id FROM service_events WHERE payload ? 'ip' AND created_at < now() - $1::interval LIMIT $2)`,
      ipAge,
    );
    ips += await deleteInBatches(
      pool,
      `DELETE FROM bans WHERE id IN (
         SELECT id FROM bans WHERE until IS NOT NULL AND until < now() - $1::interval LIMIT $2)`,
      ipAge,
    );
  }
  return { rolledUp, shares, minuteStats, rejects, events, bans, unusedWorkers, unusedMiners, ips };
}
