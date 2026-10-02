import pg from "pg";

const { Pool } = pg;

/** @typedef {import("pg").Pool} PgPool */
/** @typedef {{ address: string, name?: string, ip?: string | null }} WorkerInput */
/** @typedef {{ workerId: string | bigint, jobId: string, nonce: string, accepted: boolean, rejectReason?: string | null, difficulty: string | bigint, networkDifficulty?: string | bigint | null, createdAt?: Date | string | null }} ShareInput */

/** @param {string | undefined} [connectionString] @returns {PgPool} */
export function createPool(connectionString = process.env.DATABASE_URL) {
  if (!connectionString && !process.env.PGHOST) {
    throw new Error("Set DATABASE_URL or PGHOST/PGDATABASE/PGUSER/PGPASSWORD");
  }

  const pool = new Pool({
    ...(connectionString ? { connectionString } : {}),
    max: Number.parseInt(process.env.DB_POOL_MAX ?? "10", 10),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });
  // When the database restarts or goes away, the server drops the pool's idle connections and the pool
  // emits "error". Unhandled, Node ends the process, which would disconnect every miner and restart the
  // service. The pool discards the broken connection and opens a new one on the next query; one warning
  // per minute says it happened.
  let lastWarning = 0;
  pool.on("error", (error) => {
    if (Date.now() - lastWarning < 60_000) return;
    lastWarning = Date.now();
    console.warn("Database connection lost; it will be reopened on the next query:", error.message);
  });
  return pool;
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
  // The network difficulty the share was mined against, for effort; omitted for stale shares.
  const networkDifficulty = share.networkDifficulty === undefined || share.networkDifficulty === null ? null : String(share.networkDifficulty);
  if (networkDifficulty !== null && !/^[1-9]\d*$/.test(networkDifficulty)) {
    throw new TypeError("networkDifficulty must be a positive integer");
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
      `INSERT INTO worker_stats_1m (bucket, worker_id, accepted, rejected, stale, sum_difficulty, sum_effort)
       VALUES (
         date_trunc('minute', $1::timestamptz), $2,
         CASE WHEN $3 THEN 1 ELSE 0 END,
         CASE WHEN $3 THEN 0 ELSE 1 END,
         CASE WHEN $6 THEN 1 ELSE 0 END,
         CASE WHEN $3 THEN $4::numeric ELSE 0 END,
         CASE WHEN $3 AND $5::numeric IS NOT NULL THEN round($4::numeric / $5::numeric, 20) ELSE 0 END
       )
       ON CONFLICT (bucket, worker_id) DO UPDATE SET
         accepted = worker_stats_1m.accepted + EXCLUDED.accepted,
         rejected = worker_stats_1m.rejected + EXCLUDED.rejected,
         stale = worker_stats_1m.stale + EXCLUDED.stale,
         sum_difficulty = worker_stats_1m.sum_difficulty + EXCLUDED.sum_difficulty,
         sum_effort = worker_stats_1m.sum_effort + EXCLUDED.sum_effort`,
      [row.created_at, row.worker_id, row.accepted, row.difficulty, networkDifficulty, !row.accepted && !duplicate && share.rejectReason === "stale"],
    );
    // Keep last_seen current while a rig stays connected; at most one write per 30 s.
    await client.query(
      `WITH w AS (
         UPDATE workers SET last_seen = $2
         WHERE id = $1 AND last_seen < $2::timestamptz - interval '30 seconds'
         RETURNING miner_id
       )
       UPDATE miners SET last_seen = $2 FROM w WHERE miners.id = w.miner_id AND miners.last_seen < $2`,
      [row.worker_id, row.created_at],
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

/** @typedef {{ hash: string, height?: number | null, topoheight?: number | null, minerId?: string | bigint | null, workerId?: string | bigint | null, status: string, foundAt?: Date | null }} BlockInput */

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
    `INSERT INTO blocks (hash, height, topoheight, miner_id, worker_id, status, found_at)
     VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7::timestamptz, now()))
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
      block.foundAt ?? null,
    ],
  );
}

/**
 * @param {PgPool} pool @param {string} type @param {Record<string, unknown>} [payload]
 * @param {Date | string | null} [createdAt] When it happened, if it is being recorded late.
 */
export async function recordServiceEvent(pool, type, payload = {}, createdAt = null) {
  if (typeof type !== "string" || type.length === 0) throw new TypeError("Event type is required");
  await pool.query(
    "INSERT INTO service_events (type, payload, created_at) VALUES ($1, $2::jsonb, COALESCE($3::timestamptz, now()))",
    [type, JSON.stringify(payload), createdAt],
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

/**
 * @typedef {{ minerId: string | bigint | null, workerId: string | bigint | null }} WorkerIds
 * @typedef {{ address: string, name: string }} WorkerKey
 */

/**
 * Apply one record from a journal (what Stratum keeps while it cannot reach the database, or sends from a
 * standby server) to the database. Workers are named by address and name, since a worker first seen while
 * the database was out of reach has no id yet; `workers` caches the ids found along the way.
 * @param {PgPool} pool @param {any} record
 * @param {Map<string, WorkerIds>} workers
 * @param {{ api?: { ensureWorker: typeof ensureWorker, recordShare: typeof recordShare, recordBlock: typeof recordBlock,
 *   recordServiceEvent: typeof recordServiceEvent, recordBan: typeof recordBan }, remember?: (key: string, ids: WorkerIds) => void }} [options]
 */
export async function applyJournalRecord(pool, record, workers, { api = { ensureWorker, recordShare, recordBlock, recordServiceEvent, recordBan }, remember = () => {} } = {}) {
  /** @param {WorkerKey} key @returns {Promise<WorkerIds>} */
  async function resolve(key) {
    const k = `${key.address}\n${key.name}`;
    const known = workers.get(k);
    if (known && known.workerId !== null && known.workerId !== undefined) return known;
    const ids = await api.ensureWorker(pool, { address: key.address, name: key.name });
    workers.set(k, ids);
    remember(k, ids);
    return ids;
  }
  switch (record?.t) {
    case "worker": {
      const ids = await api.ensureWorker(pool, { address: record.address, name: record.name, ip: record.ip });
      const k = `${record.address}\n${record.name}`;
      workers.set(k, ids);
      remember(k, ids);
      return;
    }
    case "share": {
      const ids = await resolve(record.key);
      if (ids.workerId === null) throw new TypeError("The worker could not be created");
      await api.recordShare(pool, {
        workerId: ids.workerId, jobId: record.jobId, nonce: record.nonce, difficulty: record.difficulty,
        networkDifficulty: record.networkDifficulty, accepted: record.accepted, rejectReason: record.rejectReason, createdAt: record.at,
      });
      return;
    }
    case "block": {
      const ids = record.key ? await resolve(record.key) : { minerId: null, workerId: null };
      await api.recordBlock(pool, {
        hash: record.hash, height: record.height, topoheight: record.topoheight, minerId: ids.minerId, workerId: ids.workerId,
        status: record.status, foundAt: new Date(record.foundAt),
      });
      return;
    }
    case "event":
      await api.recordServiceEvent(pool, record.type, record.payload, new Date(record.at));
      return;
    case "ban":
      await api.recordBan(pool, { ip: record.ip, reason: record.reason, until: new Date(record.until) });
      return;
    default:
      throw new TypeError(`Unknown journal record type: ${record?.t}`);
  }
}

const HEX64 = /^[0-9a-f]{64}$/;
const DECIMAL = /^(?:0|[1-9]\d{0,38})(?:\.\d{1,12})?$/;

/** @param {unknown} value @param {number} max */
const text = (value, max) => typeof value === "string" && value.length > 0 && value.length <= max;

/**
 * The reason a journal record must not be applied, or null. A standby server sends these in batches; the sender holds the
 * cluster secret, so it is trusted, but a bug or a half-written record must not be able to store garbage, or to push the sequence
 * number so far ahead that every later record is skipped.
 * @param {any} r @param {number} [now]
 */
export function journalRecordProblem(r, now = Date.now()) {
  if (!r || typeof r !== "object") return "not an object";
  if (!Number.isSafeInteger(r.s) || r.s <= 0 || r.s > (now + 86_400_000) * 1000) return "bad sequence number";
  if (typeof r.at !== "string" || Number.isNaN(Date.parse(r.at))) return "bad time";
  const key = (/** @type {any} */ k) => k && text(k.address, 200) && text(k.name, 128);
  switch (r.t) {
    case "worker": return text(r.address, 200) && text(r.name, 128) && (r.ip === null || r.ip === undefined || text(r.ip, 64)) ? null : "bad worker";
    case "share":
      if (!key(r.key) || !text(r.jobId, 128) || !text(r.nonce, 128) || typeof r.accepted !== "boolean") return "bad share";
      if (typeof r.difficulty !== "string" || !DECIMAL.test(r.difficulty)) return "bad difficulty";
      if (r.networkDifficulty !== null && r.networkDifficulty !== undefined && !/^[1-9]\d{0,38}$/.test(String(r.networkDifficulty))) return "bad network difficulty";
      if (!r.accepted && !text(r.rejectReason, 64)) return "bad reject reason";
      return null;
    case "block":
      if (!HEX64.test(String(r.hash)) || !text(r.status, 32) || Number.isNaN(Date.parse(r.foundAt))) return "bad block";
      if (r.key !== null && r.key !== undefined && !key(r.key)) return "bad block worker";
      return null;
    case "event": return text(r.type, 64) && r.payload && typeof r.payload === "object" && JSON.stringify(r.payload).length <= 8_192 ? null : "bad event";
    case "ban": return text(r.ip, 64) && text(r.reason, 256) && !Number.isNaN(Date.parse(r.until)) ? null : "bad ban";
    default: return "unknown record type";
  }
}

/** A record that can never be applied (bad data), as opposed to a database that cannot be reached. @param {any} error */
function isPermanentRecordError(error) {
  return error instanceof TypeError || /^(22|23)/.test(String(error?.code ?? ""));
}

/**
 * Apply a batch sent by another server. Records with a sequence number at or below the last one applied for
 * that server are skipped, so resending a batch is harmless. Stops at the first record the database cannot
 * take for a reason other than the record itself (the sender then retries from where this stopped).
 * @param {PgPool} pool @param {string} instance @param {any[]} records
 * @returns {Promise<{ applied: number, skipped: number, rejected: number, lastSeq: number }>}
 */
export async function ingestRecords(pool, instance, records) {
  if (typeof instance !== "string" || instance.length === 0 || instance.length > 128) throw new TypeError("instance is required");
  const progress = await pool.query("SELECT last_seq FROM ingest_progress WHERE instance = $1", [instance]);
  let last = progress.rows[0] ? Number(progress.rows[0].last_seq) : 0;
  const start = last;
  const workers = new Map();
  let applied = 0;
  let skipped = 0;
  let rejected = 0;
  try {
    for (const record of records) {
      if (journalRecordProblem(record)) {
        rejected += 1;
        continue;
      }
      const seq = record.s;
      if (seq <= last) {
        skipped += 1;
        continue;
      }
      try {
        await applyJournalRecord(pool, record, workers);
        applied += 1;
      } catch (error) {
        if (!isPermanentRecordError(error)) throw error;
        rejected += 1;
      }
      last = seq;
    }
  } finally {
    if (last > start) {
      await pool.query(
        `INSERT INTO ingest_progress (instance, last_seq) VALUES ($1, $2)
         ON CONFLICT (instance) DO UPDATE SET last_seq = GREATEST(ingest_progress.last_seq, EXCLUDED.last_seq), updated_at = now()`,
        [instance, last],
      ).catch(() => {});
    }
  }
  return { applied, skipped, rejected, lastSeq: last };
}

/** Channel the API relays to live dashboards (see migration 002). */
export const LIVE_CHANNEL = "xeldash_live";

/** Announce a live update without storing it. @param {PgPool} pool @param {Record<string, unknown>} message */
export async function notifyLive(pool, message) {
  await pool.query("SELECT pg_notify($1, $2)", [LIVE_CHANNEL, JSON.stringify(message)]);
}

export { DEFAULT_RETENTION, retentionConfigFromEnv, rollUpHourlyStats, runRetention } from "./retention.js";
