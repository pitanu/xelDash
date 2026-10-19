import { createReadStream } from "node:fs";
import { appendFile, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import * as defaultDb from "@xeldash/db";
import { applyJournalRecords } from "@xeldash/db";

// Everything Stratum records goes through here, so that mining does not depend on the database.
//
// Normally a write goes straight to PostgreSQL; shares are queued and written together, a batch every SHARE_FLUSH_MS or
// SHARE_BATCH shares, so a share's answer never waits for the database and the database does one statement for many shares.
// When the database cannot be reached (it restarts,
// the computer holding it is down, the network is cut) the write is appended to a journal file
// instead, miners keep mining, and a background loop injects the journal into the database, in
// order and with the original timestamps, as soon as it answers again. Nothing is lost, including
// blocks, which are submitted to the node before anything is recorded.
//
// A standby server (the second server of a redundancy cluster) has no database at all: in remote mode every
// record goes to the journal and is sent, in batches, to the main server's ingest endpoint
// (services/api/src/ingest.js), which records it. While the main server is down the journal just grows; when it
// is back, the standby catches it up. Each record carries an increasing number, so a batch sent twice (the reply
// was lost) is not counted twice.
//
// Workers are identified by address and name in the journal, not by database id, because a worker
// first seen during an outage has no id yet; ids are resolved when the journal is replayed.
// Logins during an outage use a cache of the workers seen before, which is also kept on disk.

const PROBE_MS = 3_000;
/** Journal lines read and recorded together when the database is back (the shares among them in batches). */
const REPLAY_CHUNK = 2_000;
const DEFAULT_MAX_BYTES = 200 * 1024 * 1024;
const RECENT_SHARES = 100_000;
const SHARE_FLUSH_MS = 200;
const SHARE_BATCH = 500;
/** The most shares in one statement, when a slow database lets more pile up. */
const MAX_SHARE_BATCH = 5_000;
/** Shares waiting beyond this are dropped (statistics only), so a stuck database cannot fill Stratum's memory. */
const MAX_QUEUED_SHARES = 200_000;

const CONNECTION_CODES = new Set([
  "ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "ETIMEDOUT", "EAI_AGAIN", "EPIPE", "ECONNABORTED", "EHOSTUNREACH", "ENETUNREACH",
  "57P01", "57P02", "57P03", "53300",
]);

/**
 * Whether an error means the database cannot be reached (as opposed to a rejected statement,
 * which retrying would not fix).
 * @param {any} error @returns {boolean}
 */
export function isConnectionError(error) {
  if (!error) return false;
  const code = typeof error.code === "string" ? error.code : "";
  if (CONNECTION_CODES.has(code) || code.startsWith("08")) return true;
  if (Array.isArray(error.errors) && error.errors.some(isConnectionError)) return true;
  return /connection terminated|timeout exceeded when trying to connect|database system is (starting up|shutting down)|connection error|client was closed/i
    .test(String(error.message ?? ""));
}

/** @param {number} ms */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms).unref());

/** @param {string} address @param {string} name */
const keyOf = (address, name) => `${address}\n${name}`;

/**
 * @typedef {{ address: string, name: string }} WorkerKey
 * @typedef {{ minerId: string | bigint | null, workerId: string | bigint | null }} WorkerIds
 * @typedef {{ workerId: string | bigint, jobId: string, nonce: string, difficulty: string | bigint, networkDifficulty?: string | bigint | null,
 *   accepted: boolean, rejectReason?: string | null, createdAt: Date, bestShare?: number | null }} QueuedShare
 */

export class DurableStore {
  /**
   * @param {{ pool: import("pg").Pool | null, dir?: string | null, db?: typeof defaultDb, maxBytes?: number,
   *   logger?: Pick<Console, "info" | "warn">, probeMs?: number, shareFlushMs?: number, shareBatch?: number,
   *   onBatch?: (seconds: number, shares: number) => void,
   *   remote?: { url: string, secret: string, instance: string, batch?: number, flushMs?: number, fetch?: typeof fetch,
   *     onPing?: (body: any) => void, pingMs?: number } | null }} options
   *   `dir` null keeps no journal on disk (writes during an outage are dropped, as before).
   *   `remote` sends the journal to another server's ingest endpoint instead of writing to a database.
   */
  constructor({ pool, dir = null, db = defaultDb, maxBytes = DEFAULT_MAX_BYTES, logger = console, probeMs = PROBE_MS, remote = null,
    shareFlushMs = SHARE_FLUSH_MS, shareBatch = SHARE_BATCH, onBatch = () => {} }) {
    this.pool = /** @type {import("pg").Pool} */ (pool);
    this.remote = remote;
    this.lastSeq = 0;
    this.dir = dir;
    this.db = db;
    this.maxBytes = maxBytes;
    this.logger = logger;
    this.probeMs = probeMs;
    this.journalFile = dir ? join(dir, "journal.jsonl") : null;
    this.stateFile = dir ? join(dir, "journal.state") : null;
    this.workersFile = dir ? join(dir, "workers.json") : null;
    /** True while writes go straight to the database (never in remote mode, where it means the main server answers). */
    this.online = !remote;
    /** Records in the journal file, and how many of them are already in the database. */
    this.appended = 0;
    this.applied = 0;
    this.bytes = 0;
    this.dropped = 0;
    this.oldestAt = /** @type {string | null} */ (null);
    /** @type {Map<string, WorkerIds>} */
    this.cache = new Map();
    /** @type {Set<string>} */
    this.recentShares = new Set();
    this.chain = Promise.resolve();
    /** Records waiting for the journal, and the write that will take them. @type {{ line: string, keep?: string, at: string }[]} */
    this.batch = [];
    /** @type {Promise<void> | null} */
    this.batchWritten = null;
    this.replaying = false;
    this.stopped = false;
    this.cacheDirty = false;
    /** @type {ReturnType<typeof setTimeout> | null} */
    this.cacheTimer = null;
    /** @type {ReturnType<typeof setInterval> | null} */
    this.pingTimer = null;
    /** The running replay loop, which stop() waits for. @type {Promise<void> | null} */
    this.replayRun = null;
    /** Ends the replay loop's current pause early (set while it pauses). @type {(() => void) | null} */
    this.wakeUp = null;
    this.shareFlushMs = shareFlushMs;
    this.shareBatch = shareBatch;
    /** Told how long each batch of shares took to write to the database (for the metrics). */
    this.onBatch = onBatch;
    /** Shares waiting to be written to the database together. @type {{ share: QueuedShare, key: WorkerKey }[]} */
    this.shareQueue = [];
    /** @type {ReturnType<typeof setTimeout> | null} */
    this.flushTimer = null;
    /** The batch write under way. @type {Promise<void> | null} */
    this.flushing = null;
  }

  get pending() {
    return this.appended - this.applied;
  }

  status() {
    return { online: this.online, pending: this.pending, queued: this.shareQueue.length, oldestAt: this.oldestAt, dropped: this.dropped, remote: Boolean(this.remote) };
  }

  /** Load the journal and the workers seen before; start replaying if the last run left records behind. */
  async init() {
    // A standby asks the main server now and then, even with nothing to send: its answer carries settings (the default address).
    if (this.remote?.onPing) {
      this.pingTimer = setInterval(() => void this.#probe().catch(() => {}), this.remote.pingMs ?? 30_000);
      this.pingTimer.unref();
      void this.#probe().catch(() => {});
    }
    if (!this.dir) return;
    await mkdir(this.dir, { recursive: true });
    try {
      for (const [key, ids] of Object.entries(JSON.parse(await readFile(/** @type {string} */ (this.workersFile), "utf8")))) {
        this.cache.set(key, /** @type {WorkerIds} */ (ids));
      }
    } catch {
      // No cache yet.
    }
    try {
      this.bytes = (await stat(/** @type {string} */ (this.journalFile))).size;
      const lines = createInterface({ input: createReadStream(/** @type {string} */ (this.journalFile)), crlfDelay: Infinity });
      for await (const line of lines) {
        if (!line.trim()) continue;
        if (this.appended === 0) this.oldestAt = safeParse(line)?.at ?? null;
        this.appended += 1;
      }
      this.applied = Math.min(this.appended, Number(await readFile(/** @type {string} */ (this.stateFile), "utf8").catch(() => "0")) || 0);
    } catch {
      // No journal.
    }
    if (this.pending > 0) {
      this.logger.warn?.(`Found ${this.pending} unrecorded records from before the last stop; they will be recorded when the database answers`);
      this.#goOffline();
    }
  }

  async stop() {
    // Shares still queued go to the database, or to the journal if it does not answer.
    await this.flush();
    this.stopped = true;
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.cacheTimer) clearTimeout(this.cacheTimer);
    // The replay loop may be between tries or reading the journal: wake it, and let it finish before the journal can go away.
    this.wakeUp?.();
    await this.#saveCache();
    await this.chain;
    await this.replayRun?.catch(() => {});
  }

  // ------------------------------------------------------------------ writes

  /**
   * The ids of a worker, creating it. Offline, a worker seen before is found in the cache and a new one
   * gets a provisional identity (null ids) that is resolved when the journal is replayed.
   * @param {{ address: string, name?: string, ip?: string | null }} input @returns {Promise<WorkerIds>}
   */
  async ensureWorker({ address, name = "default", ip = null }) {
    const key = keyOf(address, name);
    if (this.online && !this.remote) {
      try {
        const ids = await this.db.ensureWorker(this.pool, { address, name, ip });
        this.#remember(key, ids);
        return ids;
      } catch (error) {
        if (!isConnectionError(error)) throw error;
        this.#goOffline(error);
      }
    }
    await this.#append({ t: "worker", address, name, ip, at: new Date().toISOString() });
    return this.cache.get(key) ?? { minerId: null, workerId: null };
  }

  /**
   * @param {{ workerId?: string | bigint | null, jobId: string, nonce: string, difficulty: string | bigint, networkDifficulty?: string | bigint | null,
   *   accepted: boolean, rejectReason?: string | null, bestShare?: number | null }} share
   * @param {WorkerKey} key
   */
  async recordShare(share, key) {
    const ids = share.workerId ?? this.cache.get(keyOf(key.address, key.name))?.workerId ?? null;
    // After stop() a share still being checked goes to the journal, which the next start records.
    if (this.online && !this.remote && !this.stopped && ids !== null) {
      // Duplicates are caught before this, by the session (it knows the work each share proves), so nothing here needs the database's
      // answer: the share waits in the queue and the miner is answered now.
      if (this.shareQueue.length >= MAX_QUEUED_SHARES) {
        if (this.dropped++ % 1_000 === 0) this.logger.warn?.("The database is not keeping up; share statistics are being dropped");
        return { recorded: false, queued: false, journaled: false, duplicate: false, accepted: share.accepted };
      }
      this.shareQueue.push({ share: { ...share, workerId: ids, createdAt: new Date() }, key });
      this.#scheduleFlush();
      return { recorded: false, queued: true, journaled: false, duplicate: false, accepted: share.accepted };
    }
    return this.#journalShare(share, key, new Date());
  }

  /**
   * @param {{ jobId: string, nonce: string, difficulty: string | bigint, networkDifficulty?: string | bigint | null, accepted: boolean,
   *   rejectReason?: string | null, bestShare?: number | null }} share
   * @param {WorkerKey} key @param {Date} at when the share arrived
   */
  async #journalShare(share, key, at) {
    // Journaled: the database's duplicate check is not available, so repeats are caught here.
    if (share.accepted) {
      const dup = `${key.address}\n${key.name}\n${share.jobId}\n${share.nonce}`;
      if (this.recentShares.has(dup)) return { recorded: false, journaled: true, duplicate: true, accepted: false };
      this.recentShares.add(dup);
      if (this.recentShares.size > RECENT_SHARES) this.recentShares.delete(/** @type {string} */ (this.recentShares.values().next().value));
    }
    await this.#append({
      t: "share", key, jobId: share.jobId, nonce: share.nonce, difficulty: String(share.difficulty),
      networkDifficulty: share.networkDifficulty === undefined || share.networkDifficulty === null ? null : String(share.networkDifficulty),
      accepted: share.accepted, rejectReason: share.rejectReason ?? null, at: at.toISOString(),
      ...(share.bestShare !== undefined && share.bestShare !== null ? { bestShare: share.bestShare } : {}),
    });
    return { recorded: false, queued: false, journaled: true, duplicate: false, accepted: share.accepted };
  }

  /** Writes every queued share now: to the database, or to the journal if it cannot be reached. */
  async flush() {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    while (this.flushing || this.shareQueue.length > 0) await (this.flushing ?? this.#flushShares());
  }

  /** A batch once enough shares wait, or a short while after the first. */
  #scheduleFlush() {
    if (this.flushing) return;
    if (this.shareQueue.length >= this.shareBatch) {
      if (this.flushTimer) clearTimeout(this.flushTimer);
      this.flushTimer = null;
      void this.#flushShares();
      return;
    }
    this.flushTimer ??= setTimeout(() => {
      this.flushTimer = null;
      void this.#flushShares();
    }, this.shareFlushMs);
    this.flushTimer.unref?.();
  }

  /** Writes the queue in batches. Shares that arrive meanwhile wait for the next, so a busy server writes bigger batches. */
  #flushShares() {
    if (this.flushing) return this.flushing;
    this.flushing = (async () => {
      do {
        await this.#writeShares(this.shareQueue.splice(0, MAX_SHARE_BATCH));
      } while (this.shareQueue.length >= this.shareBatch);
    })().finally(() => {
      this.flushing = null;
      if (this.shareQueue.length > 0) this.#scheduleFlush();
    });
    return this.flushing;
  }

  /** @param {{ share: QueuedShare, key: WorkerKey }[]} batch */
  async #writeShares(batch) {
    if (batch.length === 0) return;
    if (this.online) {
      try {
        const started = performance.now();
        await this.db.recordShares(this.pool, batch.map(({ share }) => share));
        this.onBatch((performance.now() - started) / 1000, batch.length);
        return;
      } catch (error) {
        if (!isConnectionError(error)) {
          // A share the database refuses must not cost the others: they are recorded one at a time, and the refused one skipped.
          await this.#writeSharesOneByOne(batch);
          return;
        }
        this.#goOffline(error);
      }
    }
    // The database cannot be reached: the batch goes to the journal, in order and with the times the shares arrived.
    await Promise.all(batch.map(({ share, key }) => this.#journalShare(share, key, share.createdAt)));
  }

  /** @param {{ share: QueuedShare, key: WorkerKey }[]} batch */
  async #writeSharesOneByOne(batch) {
    for (const [i, { share }] of batch.entries()) {
      try {
        await this.db.recordShare(this.pool, share);
      } catch (error) {
        if (isConnectionError(error)) {
          this.#goOffline(error);
          await Promise.all(batch.slice(i).map((rest) => this.#journalShare(rest.share, rest.key, rest.share.createdAt)));
          return;
        }
        this.logger.warn?.("Skipping a share the database refused:", error instanceof Error ? error.message : String(error));
      }
    }
  }

  /** @param {{ hash: string, height?: number | null, topoheight?: number | null, minerId?: string | bigint | null, workerId?: string | bigint | null, status: string, foundAt?: Date | null }} block @param {WorkerKey | null} key */
  async recordBlock(block, key) {
    const foundAt = block.foundAt ?? new Date();
    const ids = block.workerId !== undefined && block.workerId !== null ? block : null;
    if (this.online && !this.remote && ids) {
      try {
        await this.db.recordBlock(this.pool, { ...block, foundAt });
        return;
      } catch (error) {
        if (!isConnectionError(error)) throw error;
        this.#goOffline(error);
      }
    }
    await this.#append({
      t: "block", key, hash: block.hash, height: block.height ?? null, topoheight: block.topoheight ?? null, status: block.status,
      foundAt: foundAt.toISOString(), at: foundAt.toISOString(),
    }, { keep: "always" });
  }

  /** @param {string} type @param {Record<string, unknown>} [payload] */
  async recordServiceEvent(type, payload = {}) {
    const at = new Date();
    if (this.online && !this.remote) {
      try {
        await this.db.recordServiceEvent(this.pool, type, payload, at);
        return;
      } catch (error) {
        if (!isConnectionError(error)) throw error;
        this.#goOffline(error);
      }
    }
    await this.#append({ t: "event", type, payload, at: at.toISOString() }, { keep: "events" });
  }

  /** @param {{ ip: string, reason: string, until: Date }} ban */
  async recordBan(ban) {
    if (this.online && !this.remote) {
      try {
        await this.db.recordBan(this.pool, ban);
        return;
      } catch (error) {
        if (!isConnectionError(error)) throw error;
        this.#goOffline(error);
      }
    }
    await this.#append({ t: "ban", ip: ban.ip, reason: ban.reason, until: ban.until.toISOString(), at: new Date().toISOString() }, { keep: "events" });
  }

  /** The miner-reported hashrate is a display value: it is not kept for later. @param {string | bigint | null} workerId @param {number} hashrate */
  async recordReportedHashrate(workerId, hashrate) {
    if (!this.online || this.remote || workerId === null) return;
    try {
      await this.db.recordReportedHashrate(this.pool, workerId, hashrate);
    } catch (error) {
      if (!isConnectionError(error)) throw error;
      this.#goOffline(error);
    }
  }

  // ------------------------------------------------------------------ journal

  /** @param {WorkerKey | string} key @param {WorkerIds} ids */
  #remember(key, ids) {
    const k = typeof key === "string" ? key : keyOf(key.address, key.name);
    const known = this.cache.get(k);
    if (known && String(known.workerId) === String(ids.workerId)) return;
    this.cache.set(k, ids);
    this.cacheDirty = true;
    this.cacheTimer ??= setTimeout(() => {
      this.cacheTimer = null;
      void this.#saveCache();
    }, 5_000).unref();
  }

  async #saveCache() {
    if (!this.workersFile || !this.cacheDirty) return;
    this.cacheDirty = false;
    try {
      const tmp = `${this.workersFile}.tmp`;
      // Database ids can be BigInt, which JSON cannot hold; they are kept as strings.
      await writeFile(tmp, JSON.stringify(Object.fromEntries(this.cache), (_key, value) => (typeof value === "bigint" ? String(value) : value)), { mode: 0o600 });
      await rename(tmp, this.workersFile);
    } catch (error) {
      this.logger.warn?.("Could not save the known workers:", error instanceof Error ? error.message : String(error));
    }
  }

  /** @param {unknown} [error] */
  #goOffline(error) {
    if (this.online) {
      this.online = false;
      this.logger.warn?.("The database cannot be reached. Mining continues; records are kept in a journal and recorded when it is back.",
        error instanceof Error ? error.message : "");
    }
    if (!this.replaying && !this.stopped) this.#startReplay();
  }

  /**
   * @param {Record<string, unknown> & { t: string, at: string }} record
   * @param {{ keep?: "always" | "events" }} [options] Blocks are always kept (a few hundred bytes each, and the one record that
   *   matters). Events and bans are kept up to twice the size limit, shares only up to the limit: what a miner can make Stratum
   *   record must not be able to fill the disk.
   */
  #append(record, { keep } = {}) {
    if (!this.journalFile) return Promise.resolve();
    this.lastSeq = Math.max(this.lastSeq + 1, Date.now() * 1000);
    record.s = this.lastSeq;
    this.batch.push({ line: `${JSON.stringify(record)}\n`, keep, at: record.at });
    // Records that arrive while a write is under way go out together in the next one: one file write for many records, instead
    // of one each queued behind the share hashes on the thread pool (at a few hundred shares a second that queue was seconds long).
    if (!this.batchWritten) {
      this.chain = this.chain.then(() => this.#writeBatch())
        .catch((error) => this.logger.warn?.("Could not write to the journal:", error instanceof Error ? error.message : String(error)));
      this.batchWritten = this.chain;
    }
    return this.batchWritten;
  }

  /** Writes every record waiting for the journal, in order, with one append. */
  async #writeBatch() {
    const batch = this.batch;
    this.batch = [];
    this.batchWritten = null;
    let text = "";
    let oldestAt = null;
    let count = 0;
    for (const { line, keep, at } of batch) {
      const limit = keep === "always" ? Infinity : keep === "events" ? this.maxBytes * 2 : this.maxBytes;
      if (this.bytes + text.length + line.length > limit) {
        if (this.dropped++ % 1_000 === 0) this.logger.warn?.(`The journal is full (${Math.round(this.maxBytes / 1048576)} MB); statistics are being dropped until the database is back`);
        continue;
      }
      text += line;
      oldestAt ??= at;
      count += 1;
    }
    if (count === 0) return;
    await appendFile(/** @type {string} */ (this.journalFile), text, { mode: 0o600 });
    this.bytes += text.length;
    if (this.appended === this.applied) this.oldestAt = oldestAt;
    this.appended += count;
    if (this.remote && !this.replaying && !this.stopped) this.#startReplay();
  }

  async #probe() {
    if (this.remote) {
      try {
        const response = await (this.remote.fetch ?? fetch)(`${this.remote.url}/api/v1/ingest/ping`, {
          headers: { "x-cluster-secret": this.remote.secret }, signal: AbortSignal.timeout(3_000),
        });
        if (response.status === 401) this.#warnOnce("The main server refused the cluster secret; check XELDASH_CLUSTER_SECRET on both servers");
        if (response.ok && this.remote.onPing) this.remote.onPing(await response.json().catch(() => null));
        return response.ok;
      } catch {
        return false;
      }
    }
    try {
      await Promise.race([this.pool.query("SELECT 1"), sleep(2_000).then(() => { throw new Error("timeout"); })]);
      return true;
    } catch {
      return false;
    }
  }

  #startReplay() {
    this.replayRun = this.#replayLoop();
  }

  /** A pause in the replay loop that stop() can end early. @param {number} ms */
  #pause(ms) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.wakeUp = null; resolve(undefined); }, ms);
      timer.unref?.();
      this.wakeUp = () => { clearTimeout(timer); this.wakeUp = null; resolve(undefined); };
    });
  }

  async #replayLoop() {
    this.replaying = true;
    try {
      while (!this.stopped) {
        if (this.remote && this.pending > 0) await this.#pause(this.remote.flushMs ?? 1_000);
        if (this.stopped) break;
        if (!(await this.#probe())) {
          this.online = this.remote ? false : this.online;
          await this.#pause(this.probeMs);
          continue;
        }
        if (this.remote) this.online = true;
        if (this.remote ? await this.#drainRemote() : await this.#drain()) break;
        await this.#pause(this.probeMs);
      }
    } finally {
      this.replaying = false;
    }
  }

  /** Apply the journal in order. True when it is empty and writes can go straight to the database again. */
  async #drain() {
    if (this.pending > 0 && this.journalFile) {
      const total = this.pending;
      this.logger.info?.(`The database is back: recording ${total} kept record${total === 1 ? "" : "s"}`);
      let index = 0;
      /** @type {{ line: number, record: any }[]} */
      let chunk = [];
      const lines = createInterface({ input: createReadStream(this.journalFile), crlfDelay: Infinity });
      for await (const line of lines) {
        if (!line.trim()) continue;
        index += 1;
        if (index <= this.applied) continue;
        const record = safeParse(line);
        if (!record) {
          // A half-written last line: what came before it is recorded, the rest is left for the next round.
          lines.close();
          await this.#applyChunk(chunk);
          return false;
        }
        chunk.push({ line: index, record });
        if (chunk.length >= REPLAY_CHUNK) {
          const done = await this.#applyChunk(chunk);
          chunk = [];
          if (!done) {
            lines.close();
            return false;
          }
        }
      }
      if (!(await this.#applyChunk(chunk))) return false;
    }
    return this.#finishDrain();
  }

  /**
   * Record a run of journal lines, shares in batches. False when the database went away part way; what was recorded is saved.
   * @param {{ line: number, record: any }[]} chunk
   */
  async #applyChunk(chunk) {
    if (chunk.length === 0) return true;
    try {
      await applyJournalRecords(this.pool, chunk.map((c) => c.record), this.cache, {
        api: this.db,
        remember: (key, ids) => this.#remember(key, ids),
        isFatal: isConnectionError,
        onApplied: (i) => { this.applied = chunk[i].line; },
        onRefused: (record, error) => this.logger.warn?.(`Skipping a journal record that the database refused (${record?.t}):`,
          error instanceof Error ? error.message : String(error)),
      });
      return true;
    } catch (error) {
      if (!isConnectionError(error)) throw error;
      return false;
    } finally {
      await this.#saveState();
    }
  }

  /** Clear the journal once everything in it has been recorded, unless more arrived meanwhile. */
  async #finishDrain() {
    let finished = false;
    await (this.chain = this.chain.then(async () => {
      if (this.applied !== this.appended) return;
      if (this.journalFile) await rm(this.journalFile, { force: true });
      if (this.stateFile) await rm(this.stateFile, { force: true });
      this.appended = 0;
      this.applied = 0;
      this.bytes = 0;
      this.oldestAt = null;
      this.recentShares.clear();
      this.online = true;
      finished = true;
    }));
    if (finished) this.logger.info?.(this.remote ? "All kept records were sent to the main server" : "All kept records are in the database; recording directly again");
    return finished;
  }

  async #saveState() {
    if (!this.stateFile) return;
    await writeFile(this.stateFile, String(this.applied), { mode: 0o600 }).catch(() => {});
  }

  #lastWarning = 0;

  /** @param {string} text */
  #warnOnce(text) {
    if (Date.now() - this.#lastWarning < 60_000) return;
    this.#lastWarning = Date.now();
    this.logger.warn?.(text);
  }

  /** Send one batch to the main server. True when it was taken. @param {any[]} records */
  async #post(records) {
    const remote = /** @type {NonNullable<typeof this.remote>} */ (this.remote);
    try {
      const response = await (remote.fetch ?? fetch)(`${remote.url}/api/v1/ingest`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-cluster-secret": remote.secret },
        body: JSON.stringify({ instance: remote.instance, records }),
        signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) {
        this.#warnOnce(`The main server did not take a batch (HTTP ${response.status}); it will be sent again`);
        return false;
      }
      return true;
    } catch (error) {
      this.#warnOnce(`Could not reach the main server: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  /** Remote mode: send the journal in batches. True when it is empty. */
  async #drainRemote() {
    const size = this.remote?.batch ?? 500;
    if (this.pending > 0 && this.journalFile) {
      let index = 0;
      /** @type {any[]} */
      let batch = [];
      let batchEnd = 0;
      const lines = createInterface({ input: createReadStream(this.journalFile), crlfDelay: Infinity });
      for await (const line of lines) {
        if (!line.trim()) continue;
        index += 1;
        if (index <= this.applied) continue;
        const record = safeParse(line);
        if (!record) {
          lines.close();
          break;
        }
        batch.push(record);
        batchEnd = index;
        if (batch.length >= size) {
          if (!(await this.#post(batch))) {
            lines.close();
            return false;
          }
          this.applied = batchEnd;
          batch = [];
          await this.#saveState();
        }
      }
      if (batch.length > 0) {
        if (!(await this.#post(batch))) return false;
        this.applied = batchEnd;
        await this.#saveState();
      }
    }
    return this.#finishDrain();
  }
}

/** @param {string} line */
function safeParse(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}
