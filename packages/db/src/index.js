import pg from "pg";

const { Pool } = pg;

/** @typedef {import("pg").Pool} PgPool */
/** @typedef {{ address: string, name?: string, ip?: string | null }} WorkerInput */
/** @typedef {{ workerId: string | bigint, jobId: string, nonce: string, accepted: boolean, rejectReason?: string | null, difficulty: string | bigint, createdAt?: Date | string | null }} ShareInput */

/** @param {string | undefined} [connectionString] @returns {PgPool} */
export function createPool(connectionString = process.env.DATABASE_URL) {
  if (!connectionString && !process.env.PGHOST) {
    throw new Error("Set DATABASE_URL or PGHOST/PGDATABASE/PGUSER/PGPASSWORD");
  }

  return new Pool({
    ...(connectionString ? { connectionString } : {}),
    max: Number.parseInt(process.env.DB_POOL_MAX ?? "10", 10),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });
}

/** @param {PgPool} pool @param {WorkerInput} workerInput */
export async function ensureWorker(pool, { address, name = "default", ip = null }) {
  if (typeof address !== "string" || address.length === 0) {
    throw new TypeError("Miner address is required");
  }
  if (typeof name !== "string" || name.length === 0 || name.length > 128) {
    throw new TypeError("Worker name must contain between 1 and 128 characters");
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const miner = await client.query(
      `INSERT INTO miners (address)
       VALUES ($1)
       ON CONFLICT (address) DO UPDATE SET last_seen = now()
       RETURNING id`,
      [address],
    );
    const worker = await client.query(
      `INSERT INTO workers (miner_id, name, last_ip)
       VALUES ($1, $2, $3)
       ON CONFLICT (miner_id, name) DO UPDATE
         SET last_seen = now(), last_ip = COALESCE(EXCLUDED.last_ip, workers.last_ip)
       RETURNING id`,
      [miner.rows[0].id, name, ip],
    );
    await client.query("COMMIT");
    return { minerId: miner.rows[0].id, workerId: worker.rows[0].id };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/** @param {PgPool} pool @param {ShareInput} share */
export async function recordShare(pool, share) {
  if (typeof share.workerId !== "string" && typeof share.workerId !== "bigint") {
    throw new TypeError("workerId must be a string or bigint");
  }
  if (typeof share.jobId !== "string" || share.jobId.length === 0
      || typeof share.nonce !== "string" || share.nonce.length === 0) {
    throw new TypeError("jobId and nonce are required");
  }
  if (typeof share.accepted !== "boolean") {
    throw new TypeError("accepted must be a boolean");
  }
  if (!share.accepted && !share.rejectReason) {
    throw new TypeError("Rejected shares require a reason");
  }
  if (typeof share.difficulty !== "string" && typeof share.difficulty !== "bigint") {
    throw new TypeError("difficulty must be a decimal string or bigint to preserve precision");
  }
  const difficulty = String(share.difficulty);
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,12})?$/.test(difficulty) || /^0(?:\.0+)?$/.test(difficulty)) {
    throw new TypeError("difficulty must be a positive decimal with at most 12 fractional digits");
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    let inserted = await client.query(
      `INSERT INTO shares (worker_id, job_id, nonce, difficulty, accepted, reject_reason, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7::timestamptz, now()))
       ON CONFLICT (worker_id, job_id, nonce) WHERE accepted DO NOTHING
       RETURNING id, worker_id, difficulty, accepted, created_at`,
      [
        share.workerId,
        share.jobId,
        share.nonce,
        difficulty,
        share.accepted,
        share.rejectReason ?? null,
        share.createdAt ?? null,
      ],
    );

    let duplicate = false;
    if (inserted.rowCount === 0) {
      duplicate = true;
      const rejectedDuplicate = await client.query(
        `INSERT INTO shares (worker_id, job_id, nonce, difficulty, accepted, reject_reason, created_at)
         VALUES ($1, $2, $3, $4, false, 'duplicate', COALESCE($5::timestamptz, now()))
         RETURNING id, worker_id, difficulty, accepted, created_at`,
        [share.workerId, share.jobId, share.nonce, difficulty, share.createdAt ?? null],
      );
      inserted = rejectedDuplicate;
    }

    const row = inserted.rows[0];
    await client.query(
      `INSERT INTO worker_stats_1m (bucket, worker_id, accepted, rejected, sum_difficulty)
       VALUES (
         date_trunc('minute', $1::timestamptz), $2,
         CASE WHEN $3 THEN 1 ELSE 0 END,
         CASE WHEN $3 THEN 0 ELSE 1 END,
         CASE WHEN $3 THEN $4::numeric ELSE 0 END
       )
       ON CONFLICT (bucket, worker_id) DO UPDATE SET
         accepted = worker_stats_1m.accepted + EXCLUDED.accepted,
         rejected = worker_stats_1m.rejected + EXCLUDED.rejected,
         sum_difficulty = worker_stats_1m.sum_difficulty + EXCLUDED.sum_difficulty`,
      [row.created_at, row.worker_id, row.accepted, row.difficulty],
    );
    await client.query("COMMIT");
    return { recorded: true, shareId: row.id, duplicate, accepted: row.accepted };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/** @typedef {{ hash: string, height?: number | null, topoheight?: number | null, minerId?: string | bigint | null, workerId?: string | bigint | null, status: string }} BlockInput */

/**
 * Record a block candidate the stratum submitted. A hash already on record keeps its
 * original found_at; only its status changes.
 * @param {PgPool} pool @param {BlockInput} block
 */
export async function recordBlock(pool, block) {
  if (typeof block.hash !== "string" || !/^[0-9a-f]{64}$/.test(block.hash)) {
    throw new TypeError("Block hash must be 32 bytes of lowercase hexadecimal");
  }
  if (typeof block.status !== "string" || block.status.length === 0) {
    throw new TypeError("Block status is required");
  }
  await pool.query(
    `INSERT INTO blocks (hash, height, topoheight, miner_id, worker_id, status)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (hash) DO UPDATE SET
       status = EXCLUDED.status,
       height = COALESCE(EXCLUDED.height, blocks.height),
       topoheight = COALESCE(EXCLUDED.topoheight, blocks.topoheight),
       updated_at = now()`,
    [
      block.hash,
      block.height ?? null,
      block.topoheight ?? null,
      block.minerId ?? null,
      block.workerId ?? null,
      block.status,
    ],
  );
}

/** @param {PgPool} pool @param {string} type @param {Record<string, unknown>} [payload] */
export async function recordServiceEvent(pool, type, payload = {}) {
  if (typeof type !== "string" || type.length === 0) throw new TypeError("Event type is required");
  await pool.query(
    "INSERT INTO service_events (type, payload) VALUES ($1, $2::jsonb)",
    [type, JSON.stringify(payload)],
  );
}

/** @param {PgPool} pool @returns {Promise<{ hash: string, height: number }[]>} */
export async function listSubmittedBlocks(pool) {
  const result = await pool.query(
    "SELECT hash, height::int AS height FROM blocks WHERE status = 'submitted' AND height IS NOT NULL ORDER BY height",
  );
  return result.rows;
}

/**
 * Move a submitted block to its final status. Returns false if the block was not in
 * `submitted`, so a second tracker pass cannot finalize it twice.
 * @param {PgPool} pool
 * @param {{ hash: string, status: string, topoheight: number | null, reward: string | number | bigint | null }} block
 */
export async function finalizeBlock(pool, { hash, status, topoheight, reward }) {
  const result = await pool.query(
    `UPDATE blocks
     SET status = $2, topoheight = COALESCE($3, topoheight), reward = $4, updated_at = now()
     WHERE hash = $1 AND status = 'submitted'`,
    [hash, status, topoheight, reward === null ? null : String(reward)],
  );
  return result.rowCount === 1;
}

/** @param {PgPool} pool @returns {Promise<{ ip: string, until: Date }[]>} */
export async function listActiveBans(pool) {
  const result = await pool.query(
    "SELECT host(ip) AS ip, max(until) AS until FROM bans WHERE until > now() GROUP BY ip",
  );
  return result.rows;
}

/** @param {PgPool} pool @param {{ ip: string, reason: string, until: Date }} ban */
export async function recordBan(pool, { ip, reason, until }) {
  await pool.query("INSERT INTO bans (ip, reason, until) VALUES ($1, $2, $3)", [ip, reason, until]);
}

/** @param {PgPool} pool @param {string | bigint} workerId @param {number} hashrate */
export async function recordReportedHashrate(pool, workerId, hashrate) {
  await pool.query("UPDATE workers SET reported_hashrate = $2, reported_at = now() WHERE id = $1", [workerId, hashrate]);
}

/** Channel the API relays to live dashboards (see migration 002). */
export const LIVE_CHANNEL = "xeldash_live";

/** Announce a live update without storing it. @param {PgPool} pool @param {Record<string, unknown>} message */
export async function notifyLive(pool, message) {
  await pool.query("SELECT pg_notify($1, $2)", [LIVE_CHANNEL, JSON.stringify(message)]);
}

export { DEFAULT_RETENTION, retentionConfigFromEnv, rollUpHourlyStats, runRetention } from "./retention.js";
