import { createReadStream } from "node:fs";
import { appendFile, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import * as defaultDb from "@xeldash/db";
import { applyJournalRecord } from "@xeldash/db";

// Everything Stratum records goes through here, so that mining does not depend on the database.
//
// Normally a write goes straight to PostgreSQL. When the database cannot be reached (it restarts,
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
const STATE_EVERY = 20;
const DEFAULT_MAX_BYTES = 200 * 1024 * 1024;
const RECENT_SHARES = 100_000;

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
 */

export class DurableStore {
  /**
   * @param {{ pool: import("pg").Pool | null, dir?: string | null, db?: typeof defaultDb, maxBytes?: number,
   *   logger?: Pick<Console, "info" | "warn">, probeMs?: number,
   *   remote?: { url: string, secret: string, instance: string, batch?: number, flushMs?: number, fetch?: typeof fetch,
   *     onPing?: (body: any) => void, pingMs?: number } | null }} options
   *   `dir` null keeps no journal on disk (writes during an outage are dropped, as before).
   *   `remote` sends the journal to another server's ingest endpoint instead of writing to a database.
   */
  constructor({ pool, dir = null, db = defaultDb, maxBytes = DEFAULT_MAX_BYTES, logger = console, probeMs = PROBE_MS, remote = null }) {
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
    this.replaying = false;
    this.stopped = false;
    this.cacheDirty = false;
    /** @type {ReturnType<typeof setTimeout> | null} */
    this.cacheTimer = null;
    /** @type {ReturnType<typeof setInterval> | null} */
    this.pingTimer = null;
  }

  get pending() {
    return this.appended - this.applied;
  }

  status() {
    return { online: this.online, pending: this.pending, oldestAt: this.oldestAt, dropped: this.dropped, remote: Boolean(this.remote) };
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
    this.stopped = true;
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.cacheTimer) clearTimeout(this.cacheTimer);
    await this.#saveCache();
    await this.chain;
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
   *   accepted: boolean, rejectReason?: string | null }} share
   * @param {WorkerKey} key
   */
  async recordShare(share, key) {
    const ids = share.workerId ?? this.cache.get(keyOf(key.address, key.name))?.workerId ?? null;
    if (this.online && !this.remote && ids !== null) {
      try {
        return await this.db.recordShare(this.pool, { ...share, workerId: ids });
      } catch (error) {
        if (!isConnectionError(error)) throw error;
        this.#goOffline(error);
      }
    }
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
      accepted: share.accepted, rejectReason: share.rejectReason ?? null, at: new Date().toISOString(),
    });
    return { recorded: false, journaled: true, duplicate: false, accepted: share.accepted };
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
    if (!this.replaying && !this.stopped) void this.#replayLoop();
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
    const line = `${JSON.stringify(record)}\n`;
    const task = this.chain.then(async () => {
      const limit = keep === "always" ? Infinity : keep === "events" ? this.maxBytes * 2 : this.maxBytes;
      if (this.bytes + line.length > limit) {
        if (this.dropped++ % 1_000 === 0) this.logger.warn?.(`The journal is full (${Math.round(this.maxBytes / 1048576)} MB); statistics are being dropped until the database is back`);
        return;
      }
      await appendFile(/** @type {string} */ (this.journalFile), line, { mode: 0o600 });
      this.bytes += line.length;
      if (this.appended === this.applied) this.oldestAt = record.at;
      this.appended += 1;
      if (this.remote && !this.replaying && !this.stopped) void this.#replayLoop();
    });
    this.chain = task.catch((error) => this.logger.warn?.("Could not write to the journal:", error instanceof Error ? error.message : String(error)));
    return this.chain;
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

  async #replayLoop() {
    this.replaying = true;
    try {
      while (!this.stopped) {
        if (this.remote && this.pending > 0) await sleep(this.remote.flushMs ?? 1_000);
        if (!(await this.#probe())) {
          this.online = this.remote ? false : this.online;
          await sleep(this.probeMs);
          continue;
        }
        if (this.remote) this.online = true;
        if (this.remote ? await this.#drainRemote() : await this.#drain()) break;
        await sleep(this.probeMs);
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
      const lines = createInterface({ input: createReadStream(this.journalFile), crlfDelay: Infinity });
      for await (const line of lines) {
        if (!line.trim()) continue;
        index += 1;
        if (index <= this.applied) continue;
        const record = safeParse(line);
        if (!record) {
          // A half-written last line: leave it for the next round.
          lines.close();
          return false;
        }
        try {
          await this.#apply(record);
        } catch (error) {
          if (isConnectionError(error)) {
            await this.#saveState();
            lines.close();
            return false;
          }
          this.logger.warn?.(`Skipping a journal record that the database refused (${record.t}):`, error instanceof Error ? error.message : String(error));
        }
        this.applied = index;
        if (this.applied % STATE_EVERY === 0) await this.#saveState();
      }
      await this.#saveState();
    }
    return this.#finishDrain();
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

  /** @param {any} record */
  async #apply(record) {
    await applyJournalRecord(this.pool, record, this.cache, { api: this.db, remember: (key, ids) => this.#remember(key, ids) });
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
