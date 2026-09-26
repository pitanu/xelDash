// Read-only dashboard queries. Hashrate is accepted share difficulty divided by elapsed
// seconds, over completed minutes only (the current minute is still filling).

/** @typedef {import("pg").Pool} PgPool */

export const ADDRESS_PATTERN = /^xe[lt]:[a-z0-9]{10,120}$/;
// Minute stats are kept 90 days; longer ranges read the hourly rollups. The table name is
// taken from this fixed list, never from the request.
const HISTORY_RANGES = Object.freeze({
  "6h": { hours: 6, bucketMinutes: 5, table: "worker_stats_1m" },
  "24h": { hours: 24, bucketMinutes: 15, table: "worker_stats_1m" },
  "7d": { hours: 168, bucketMinutes: 60, table: "worker_stats_1m" },
  "30d": { hours: 720, bucketMinutes: 360, table: "worker_stats_1m" },
  "1y": { hours: 8760, bucketMinutes: 1440, table: "worker_stats_1h" },
});

/** @param {string | null} value @param {number} fallback @param {number} max */
export function clampLimit(value, fallback, max) {
  const parsed = value === null ? fallback : Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? Math.min(parsed, max) : fallback;
}

/**
 * Hashrate per bucket for everyone, one miner address, or one worker of that address.
 * Buckets with no shares are returned as zero so gaps show as drops, not interpolation.
 * @param {PgPool} pool @param {{ address: string | null, worker?: string | null, range: string }} input
 */
export async function getHashrateHistory(pool, { address, worker = null, range }) {
  const settings = HISTORY_RANGES[/** @type {keyof typeof HISTORY_RANGES} */ (range)] ?? HISTORY_RANGES["24h"];
  const result = await pool.query(
    `WITH buckets AS (
       SELECT generate_series(
         date_bin($2::interval, date_trunc('minute', now()) - $1::interval, 'epoch'),
         date_trunc('minute', now()) - $2::interval,
         $2::interval
       ) AS bucket
     ),
     stats AS (
       SELECT date_bin($2::interval, s.bucket, 'epoch') AS bucket,
              SUM(s.sum_difficulty) AS difficulty,
              SUM(s.accepted) AS accepted,
              SUM(s.rejected) AS rejected
       FROM ${settings.table} s
       JOIN workers w ON w.id = s.worker_id
       JOIN miners m ON m.id = w.miner_id
       WHERE s.bucket >= date_trunc('minute', now()) - $1::interval - $2::interval
         AND s.bucket < date_trunc('minute', now())
         AND ($3::text IS NULL OR m.address = $3)
         AND ($4::text IS NULL OR w.name = $4)
       GROUP BY 1
     )
     SELECT b.bucket,
            ROUND(COALESCE(st.difficulty, 0) / EXTRACT(EPOCH FROM $2::interval), 3)::text AS hashrate,
            COALESCE(st.accepted, 0)::text AS accepted,
            COALESCE(st.rejected, 0)::text AS rejected
     FROM buckets b
     LEFT JOIN stats st ON st.bucket = b.bucket
     ORDER BY b.bucket`,
    [`${settings.hours} hours`, `${settings.bucketMinutes} minutes`, address, worker],
  );
  return {
    range: HISTORY_RANGES[/** @type {keyof typeof HISTORY_RANGES} */ (range)] ? range : "24h",
    bucketSeconds: settings.bucketMinutes * 60,
    points: result.rows.map((row) => ({
      time: row.bucket.toISOString(),
      hashrate: row.hashrate,
      accepted: row.accepted,
      rejected: row.rejected,
    })),
  };
}

/** @param {PgPool} pool */
export async function listMiners(pool) {
  const result = await pool.query(
    `SELECT m.address,
            m.last_seen,
            COUNT(DISTINCT w.id)::text AS workers,
            ROUND(COALESCE(SUM(s.sum_difficulty), 0) / 3600, 3)::text AS hashrate_1h,
            COALESCE(SUM(s.accepted), 0)::text AS accepted_1h,
            COALESCE(SUM(s.rejected), 0)::text AS rejected_1h,
            (SELECT COUNT(*) FROM blocks b WHERE b.miner_id = m.id AND b.status <> 'rejected')::text AS blocks
     FROM miners m
     LEFT JOIN workers w ON w.miner_id = m.id
     LEFT JOIN worker_stats_1m s ON s.worker_id = w.id
       AND s.bucket >= date_trunc('minute', now()) - interval '1 hour'
       AND s.bucket < date_trunc('minute', now())
     GROUP BY m.id
     ORDER BY m.last_seen DESC
     LIMIT 200`,
  );
  return result.rows.map((row) => ({
    address: row.address,
    lastSeen: row.last_seen.toISOString(),
    workers: row.workers,
    hashrate1h: row.hashrate_1h,
    accepted1h: row.accepted_1h,
    rejected1h: row.rejected_1h,
    blocks: row.blocks,
  }));
}

/** @param {PgPool} pool @param {string} address */
export async function getMiner(pool, address) {
  const miner = await pool.query("SELECT id, address, first_seen, last_seen FROM miners WHERE address = $1", [address]);
  if (miner.rowCount === 0) return null;
  const workers = await pool.query(
    `SELECT w.name,
            w.last_seen,
            CASE WHEN w.reported_at > now() - interval '10 minutes' THEN w.reported_hashrate END AS reported_hashrate,
            ROUND(COALESCE(SUM(s.sum_difficulty) FILTER (WHERE s.bucket >= date_trunc('minute', now()) - interval '5 minutes'), 0) / 300, 3)::text AS hashrate_5m,
            ROUND(COALESCE(SUM(s.sum_difficulty), 0) / 3600, 3)::text AS hashrate_1h,
            COALESCE(SUM(s.accepted), 0)::text AS accepted_1h,
            COALESCE(SUM(s.rejected), 0)::text AS rejected_1h
     FROM workers w
     LEFT JOIN worker_stats_1m s ON s.worker_id = w.id
       AND s.bucket >= date_trunc('minute', now()) - interval '1 hour'
       AND s.bucket < date_trunc('minute', now())
     WHERE w.miner_id = $1
     GROUP BY w.id
     ORDER BY w.last_seen DESC`,
    [miner.rows[0].id],
  );
  return {
    address: miner.rows[0].address,
    firstSeen: miner.rows[0].first_seen.toISOString(),
    lastSeen: miner.rows[0].last_seen.toISOString(),
    workers: workers.rows.map((row) => ({
      name: row.name,
      lastSeen: row.last_seen.toISOString(),
      hashrate5m: row.hashrate_5m,
      hashrate1h: row.hashrate_1h,
      accepted1h: row.accepted_1h,
      rejected1h: row.rejected_1h,
      // What the miner reports about itself, when it did so in the last 10 minutes.
      reportedHashrate: row.reported_hashrate === null ? null : String(row.reported_hashrate),
    })),
  };
}

/** @param {PgPool} pool @param {{ address: string | null, worker?: string | null, limit: number }} input */
export async function listBlocks(pool, { address, worker = null, limit }) {
  const result = await pool.query(
    `SELECT b.hash, b.height, b.topoheight, b.status, b.reward::text AS reward, b.found_at,
            m.address, w.name AS worker
     FROM blocks b
     LEFT JOIN miners m ON m.id = b.miner_id
     LEFT JOIN workers w ON w.id = b.worker_id
     WHERE ($1::text IS NULL OR m.address = $1)
       AND ($3::text IS NULL OR w.name = $3)
     ORDER BY b.found_at DESC
     LIMIT $2`,
    [address, limit, worker],
  );
  return result.rows.map((row) => ({
    hash: row.hash,
    height: row.height === null ? null : String(row.height),
    topoheight: row.topoheight === null ? null : String(row.topoheight),
    status: row.status,
    reward: row.reward,
    foundAt: row.found_at.toISOString(),
    address: row.address,
    worker: row.worker,
  }));
}

/** @param {PgPool} pool @param {number} limit */
export async function listEvents(pool, limit) {
  const result = await pool.query(
    "SELECT id::text, type, payload, created_at FROM service_events ORDER BY service_events.id DESC LIMIT $1",
    [limit],
  );
  return result.rows.map((row) => ({
    id: row.id,
    type: row.type,
    payload: row.payload,
    createdAt: row.created_at.toISOString(),
  }));
}

/** @param {PgPool} pool @param {string} address @param {string} name */
export async function getWorker(pool, address, name) {
  const worker = await pool.query(
    `SELECT w.id, w.name, w.first_seen, w.last_seen, host(w.last_ip) AS last_ip,
            CASE WHEN w.reported_at > now() - interval '10 minutes' THEN w.reported_hashrate END AS reported_hashrate
     FROM workers w JOIN miners m ON m.id = w.miner_id
     WHERE m.address = $1 AND w.name = $2`,
    [address, name],
  );
  if (worker.rowCount === 0) return null;
  const row = worker.rows[0];
  const [stats, reasons] = await Promise.all([
    pool.query(
      `SELECT
         ROUND(COALESCE(SUM(sum_difficulty) FILTER (WHERE bucket >= date_trunc('minute', now()) - interval '5 minutes'), 0) / 300, 3)::text AS hashrate_5m,
         ROUND(COALESCE(SUM(sum_difficulty) FILTER (WHERE bucket >= date_trunc('minute', now()) - interval '1 hour'), 0) / 3600, 3)::text AS hashrate_1h,
         ROUND(COALESCE(SUM(sum_difficulty), 0) / 86400, 3)::text AS hashrate_24h,
         COALESCE(SUM(accepted) FILTER (WHERE bucket >= date_trunc('minute', now()) - interval '1 hour'), 0)::text AS accepted_1h,
         COALESCE(SUM(rejected) FILTER (WHERE bucket >= date_trunc('minute', now()) - interval '1 hour'), 0)::text AS rejected_1h,
         COALESCE(SUM(accepted), 0)::text AS accepted_24h,
         COALESCE(SUM(rejected), 0)::text AS rejected_24h
       FROM worker_stats_1m
       WHERE worker_id = $1
         AND bucket >= date_trunc('minute', now()) - interval '24 hours'
         AND bucket < date_trunc('minute', now())`,
      [row.id],
    ),
    pool.query(
      `SELECT reject_reason AS reason, COUNT(*)::text AS count
       FROM shares
       WHERE worker_id = $1 AND NOT accepted AND created_at >= now() - interval '24 hours'
       GROUP BY reject_reason
       ORDER BY COUNT(*) DESC`,
      [row.id],
    ),
  ]);
  const s = stats.rows[0];
  return {
    address,
    name: row.name,
    firstSeen: row.first_seen.toISOString(),
    lastSeen: row.last_seen.toISOString(),
    lastIp: row.last_ip,
    reportedHashrate: row.reported_hashrate === null ? null : String(row.reported_hashrate),
    hashrate: { "5m": s.hashrate_5m, "1h": s.hashrate_1h, "24h": s.hashrate_24h },
    shares: {
      accepted1h: s.accepted_1h,
      rejected1h: s.rejected_1h,
      accepted24h: s.accepted_24h,
      rejected24h: s.rejected_24h,
    },
    rejectReasons24h: reasons.rows,
  };
}
