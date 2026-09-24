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
