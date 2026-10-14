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

/**
 * Checks a share before it is written; returns the difficulties as decimal strings.
 * @param {ShareInput} share @returns {{ difficulty: string, networkDifficulty: string | null }}
 */
function checkShare(share) {
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
  return { difficulty, networkDifficulty };
}

/**
 * Record one share (a journal replayed after an outage, a standby server's batch): a batch of one.
 * @param {PgPool} pool @param {ShareInput} share
 */
export async function recordShare(pool, share) {
  await recordShares(pool, [share]);
  return { recorded: true, duplicate: false, accepted: share.accepted };
}

/**
 * Record many shares in one statement: the per-minute stats and reject reasons added up per worker and minute, and each worker's
 * last_seen. There is no row per share. Stratum checks for duplicates itself (the work a share proves is known per connection);
 * a duplicate arrives as a rejected share with the reason "duplicate". Everything is written, or nothing.
 * @param {PgPool} pool @param {ShareInput[]} shares
 */
export async function recordShares(pool, shares) {
  if (shares.length === 0) return { recorded: 0 };
  /** @type {{ worker: string[], difficulty: string[], network: (string | null)[], accepted: boolean[], reason: (string | null)[], at: (string | null)[] }} */
  const columns = { worker: [], difficulty: [], network: [], accepted: [], reason: [], at: [] };
  for (const share of shares) {
    const { difficulty, networkDifficulty } = checkShare(share);
    columns.worker.push(String(share.workerId));
    columns.difficulty.push(difficulty);
    columns.network.push(networkDifficulty);
    columns.accepted.push(share.accepted);
    columns.reason.push(share.accepted ? null : share.rejectReason ?? null);
    columns.at.push(share.createdAt === undefined || share.createdAt === null ? null : new Date(share.createdAt).toISOString());
  }
  await pool.query(
    `WITH input AS (
       SELECT worker_id, difficulty, network_difficulty, accepted, reject_reason, COALESCE(created_at, now()) AS created_at
       FROM unnest($1::bigint[], $2::numeric[], $3::numeric[], $4::boolean[], $5::text[], $6::timestamptz[])
         AS t(worker_id, difficulty, network_difficulty, accepted, reject_reason, created_at)
     ),
     rejects AS (
       INSERT INTO worker_rejects_1m (worker_id, bucket, reason, count)
       SELECT worker_id, date_trunc('minute', created_at), reject_reason, count(*)
       FROM input
       WHERE NOT accepted
       GROUP BY 1, 2, 3
       ON CONFLICT (worker_id, bucket, reason) DO UPDATE SET count = worker_rejects_1m.count + EXCLUDED.count
     ),
     stats AS (
       INSERT INTO worker_stats_1m (bucket, worker_id, accepted, rejected, stale, sum_difficulty, sum_effort)
       SELECT date_trunc('minute', created_at), worker_id,
              count(*) FILTER (WHERE accepted),
              count(*) FILTER (WHERE NOT accepted),
              count(*) FILTER (WHERE NOT accepted AND reject_reason = 'stale'),
              COALESCE(sum(difficulty) FILTER (WHERE accepted), 0),
              COALESCE(sum(round(difficulty / network_difficulty, 20)) FILTER (WHERE accepted AND network_difficulty IS NOT NULL), 0)
       FROM input
       GROUP BY 1, 2
       ON CONFLICT (bucket, worker_id) DO UPDATE SET
         accepted = worker_stats_1m.accepted + EXCLUDED.accepted,
         rejected = worker_stats_1m.rejected + EXCLUDED.rejected,
         stale = worker_stats_1m.stale + EXCLUDED.stale,
         sum_difficulty = worker_stats_1m.sum_difficulty + EXCLUDED.sum_difficulty,
         sum_effort = worker_stats_1m.sum_effort + EXCLUDED.sum_effort
     ),
     -- Keep last_seen current while a rig stays connected; at most one write per 30 s.
     seen AS (
       UPDATE workers w SET last_seen = latest.at
       FROM (SELECT worker_id, max(created_at) AS at FROM input GROUP BY worker_id) latest
       WHERE w.id = latest.worker_id AND w.last_seen < latest.at - interval '30 seconds'
       RETURNING w.miner_id, latest.at
     )
     UPDATE miners SET last_seen = m.at
     FROM (SELECT miner_id, max(at) AS at FROM seen GROUP BY miner_id) m
     WHERE miners.id = m.miner_id AND miners.last_seen < m.at`,
    [columns.worker, columns.difficulty, columns.network, columns.accepted, columns.reason, columns.at],
  );
  return { recorded: shares.length };
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
  /** @param {WorkerKey} key */
  const resolve = (key) => resolveJournalWorker(pool, key, workers, api, remember);
  switch (record?.t) {
    case "worker": {
      const ids = await api.ensureWorker(pool, { address: record.address, name: record.name, ip: record.ip });
      const k = `${record.address}\n${record.name}`;
      workers.set(k, ids);
      remember(k, ids);
      return;
    }
    case "share":
      await api.recordShare(pool, await journalShare(pool, record, workers, api, remember));
      return;
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

/**
 * A journaled worker's ids, creating it if it was first seen while the database was out of reach.
 * @param {PgPool} pool @param {WorkerKey} key @param {Map<string, WorkerIds>} workers
 * @param {{ ensureWorker: typeof ensureWorker }} api @param {(key: string, ids: WorkerIds) => void} remember
 * @returns {Promise<WorkerIds>}
 */
async function resolveJournalWorker(pool, key, workers, api, remember) {
  const k = `${key.address}\n${key.name}`;
  const known = workers.get(k);
  if (known && known.workerId !== null && known.workerId !== undefined) return known;
  const ids = await api.ensureWorker(pool, { address: key.address, name: key.name });
  workers.set(k, ids);
  remember(k, ids);
  return ids;
}

/**
 * The share a journal record stands for, with its worker's id.
 * @param {PgPool} pool @param {any} record @param {Map<string, WorkerIds>} workers
 * @param {{ ensureWorker: typeof ensureWorker }} api @param {(key: string, ids: WorkerIds) => void} remember
 * @returns {Promise<ShareInput>}
 */
async function journalShare(pool, record, workers, api, remember) {
  const ids = await resolveJournalWorker(pool, record.key, workers, api, remember);
  if (ids.workerId === null) throw new TypeError("The worker could not be created");
  return {
    workerId: ids.workerId, jobId: record.jobId, nonce: record.nonce, difficulty: record.difficulty,
    networkDifficulty: record.networkDifficulty, accepted: record.accepted, rejectReason: record.rejectReason, createdAt: record.at,
  };
}

/** Shares written together when a journal is replayed. */
const JOURNAL_SHARE_BATCH = 500;

/**
 * Apply journal records in order, with runs of shares written in batches (a long outage can leave millions of them). Everything
 * else is applied one record at a time, after the shares before it.
 *
 * `isFatal` tells an error that stops the replay (the database went away: the caller retries later from where it stopped) from one
 * that only the record caused, which is passed to `onRefused` and skipped; a refused batch of shares is retried one share at a
 * time, so only the share at fault is skipped. `onApplied(i)` says that every record up to index i is settled (applied or
 * skipped); it is called in order, and only once the records are written.
 * @param {PgPool} pool @param {any[]} records @param {Map<string, WorkerIds>} workers
 * @param {{ isFatal: (error: unknown) => boolean, onApplied?: (index: number) => void, onRefused?: (record: any, error: unknown) => void,
 *   api?: { ensureWorker: typeof ensureWorker, recordShare: typeof recordShare, recordShares: typeof recordShares, recordBlock: typeof recordBlock,
 *     recordServiceEvent: typeof recordServiceEvent, recordBan: typeof recordBan },
 *   remember?: (key: string, ids: WorkerIds) => void, batch?: number }} options
 */
export async function applyJournalRecords(pool, records, workers, {
  isFatal, onApplied = () => {}, onRefused = () => {}, remember = () => {}, batch = JOURNAL_SHARE_BATCH,
  api = { ensureWorker, recordShare, recordShares, recordBlock, recordServiceEvent, recordBan },
}) {
  /** @type {{ index: number, share: ShareInput }[]} */
  let pending = [];
  async function flush() {
    if (pending.length === 0) return;
    const shares = pending;
    pending = [];
    try {
      await api.recordShares(pool, shares.map((p) => p.share));
    } catch (error) {
      if (isFatal(error)) throw error;
      for (const { index, share } of shares) {
        try {
          await api.recordShare(pool, share);
        } catch (one) {
          if (isFatal(one)) throw one;
          onRefused(records[index], one);
        }
        onApplied(index);
      }
      return;
    }
    onApplied(/** @type {{ index: number }} */ (shares.at(-1)).index);
  }
  for (const [index, record] of records.entries()) {
    try {
      if (record?.t === "share") {
        pending.push({ index, share: await journalShare(pool, record, workers, api, remember) });
        if (pending.length >= batch) await flush();
        continue;
      }
      await flush();
      await applyJournalRecord(pool, record, workers, { api, remember });
    } catch (error) {
      if (isFatal(error)) throw error;
      // The shares before this one are settled first, so progress never skips over one not yet written.
      await flush();
      onRefused(record, error);
    }
    onApplied(index);
  }
  await flush();
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
  let skipped = 0;
  let rejected = 0;
  let refused = 0;
  /** @type {any[]} */
  const fresh = [];
  for (const record of records) {
    if (journalRecordProblem(record)) rejected += 1;
    else if (record.s <= last || record.s <= (fresh.at(-1)?.s ?? 0)) skipped += 1;
    else fresh.push(record);
  }
  let settled = 0;
  try {
    await applyJournalRecords(pool, fresh, new Map(), {
      isFatal: (error) => !isPermanentRecordError(error),
      onRefused: () => { refused += 1; },
      onApplied: (index) => {
        settled = index + 1;
        last = fresh[index].s;
      },
    });
  } finally {
    if (last > start) {
      await pool.query(
        `INSERT INTO ingest_progress (instance, last_seq) VALUES ($1, $2)
         ON CONFLICT (instance) DO UPDATE SET last_seq = GREATEST(ingest_progress.last_seq, EXCLUDED.last_seq), updated_at = now()`,
        [instance, last],
      ).catch(() => {});
    }
  }
  return { applied: settled - refused, skipped, rejected: rejected + refused, lastSeq: last };
}

/** Channel the API relays to live dashboards (see migration 002). */
export const LIVE_CHANNEL = "xeldash_live";

/** Announce a live update without storing it. @param {PgPool} pool @param {Record<string, unknown>} message */
export async function notifyLive(pool, message) {
  await pool.query("SELECT pg_notify($1, $2)", [LIVE_CHANNEL, JSON.stringify(message)]);
}

export { DEFAULT_RETENTION, retentionConfigFromEnv, rollUpHourlyStats, runRetention } from "./retention.js";
