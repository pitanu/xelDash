import { blake3 } from "@noble/hashes/blake3.js";
import { recordBlock, recordServiceEvent, recordShare } from "@xeldash/db";
import { hashMinerWorkAsync } from "@xeldash/xelis-hash";
import { STRATUM_ERRORS } from "./protocol.js";

const MAX_U256 = (1n << 256n) - 1n;

/** @param {Buffer} hash */
function asU256(hash) {
  if (!Buffer.isBuffer(hash) || hash.length !== 32) throw new TypeError("PoW hash must be 32 bytes");
  return BigInt(`0x${hash.toString("hex")}`);
}

/**
 * XELIS block hash: BLAKE3 of the serialized 112-byte MinerWork, which is also the block
 * header's PoW challenge (xelis_common `impl Hashable for MinerWork` / `BlockHeader::hash`).
 * @param {Buffer} minerWork
 */
export function blockHashFromMinerWork(minerWork) {
  if (minerWork.length !== 112) throw new TypeError("MinerWork must be 112 bytes");
  return Buffer.from(blake3(minerWork)).toString("hex");
}

/** @param {unknown} error */
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

const RETRY_MS = 10_000;
// Enough for any outage: a solo miner finds a block every few hours at best.
const MAX_PENDING = 100;

/**
 * @param {{ daemon: import("./node-pool.js").NodePool, pool: import("pg").Pool, logger?: Pick<Console, "warn" | "info">, retryMs?: number }} dependencies
 */
export function createShareSubmitter({ daemon, pool, logger = console, retryMs = RETRY_MS }) {
  /**
   * Blocks the daemon accepted but the database could not record (it was down). They are recorded
   * as soon as it is back, with the time they were found, so the dashboard, the alerts and the
   * block tracker see them. Kept in memory only: if Stratum itself restarts before the database
   * returns, the record is lost (the block is on the chain and pays the miner either way).
   * @type {{ block: import("@xeldash/db").BlockInput, event: { type: string, payload: Record<string, unknown> }, blockRecorded: boolean }[]}
   */
  const unrecorded = [];
  /** @type {ReturnType<typeof setTimeout> | null} */
  let retryTimer = null;

  /** @param {(typeof unrecorded)[number]} entry */
  async function persistBlock(entry) {
    if (!entry.blockRecorded) {
      await recordBlock(pool, entry.block);
      entry.blockRecorded = true;
    }
    await recordServiceEvent(pool, entry.event.type, entry.event.payload);
  }

  async function retryUnrecorded() {
    retryTimer = null;
    while (unrecorded.length > 0) {
      try {
        await persistBlock(unrecorded[0]);
      } catch {
        break;
      }
      const done = /** @type {(typeof unrecorded)[number]} */ (unrecorded.shift());
      logger.info?.("Recorded a block that was found while the database was unavailable", { hash: done.block.hash, height: done.block.height });
    }
    if (unrecorded.length > 0) retryTimer = setTimeout(retryUnrecorded, retryMs).unref();
  }

  /**
   * Submit first, then persist: a database outage must never keep a solved block from the
   * daemon. Recording failures are logged and do not affect the miner's share response.
   * @param {{ worker: { minerId?: string | bigint, workerId: string | bigint }, workerName: string, job: import("./job-provider.js").MiningJob, minerWork: Buffer }} input
   */
  async function submitBlockCandidate({ worker, workerName, job, minerWork }) {
    const hash = blockHashFromMinerWork(minerWork);
    /** @type {string} */
    let status;
    /** @type {string | null} */
    let failure = null;
    try {
      const submitted = await daemon.submitBlock(job.template, minerWork.toString("hex"), job.nodeId);
      status = submitted ? "submitted" : "rejected";
      if (!submitted) failure = "daemon returned false";
    } catch (error) {
      status = "rejected";
      failure = errorMessage(error);
    }

    if (failure) {
      logger.warn?.("Daemon did not accept a locally valid block candidate", { hash, height: job.height, workerName, error: failure });
    } else {
      logger.info?.("Block candidate accepted by the daemon", { hash, height: job.height, workerName });
    }

    const entry = {
      block: { hash, height: job.height, minerId: worker.minerId ?? null, workerId: worker.workerId, status, foundAt: new Date() },
      event: {
        type: failure ? "block_rejected" : "block_submitted",
        payload: { hash, height: job.height, jobId: job.jobId, workerName, ...(failure ? { error: failure } : {}) },
      },
      blockRecorded: false,
    };
    try {
      await persistBlock(entry);
    } catch (error) {
      logger.warn?.("Failed to record a submitted block candidate; it will be recorded when the database is back", { hash, error: errorMessage(error) });
      if (unrecorded.length < MAX_PENDING) unrecorded.push(entry);
      retryTimer ??= setTimeout(retryUnrecorded, retryMs).unref();
    }
    return { hash, accepted: failure === null, error: failure };
  }

  /**
   * Stratum sends a nonce and the work is rebuilt from the job. Getwork miners send their full
   * MinerWork (they also change the timestamp and thread id), which the caller has already
   * checked against the job; `nonce` is then the dedupe key.
   * @param {{ worker: { minerId?: string | bigint, workerId: string | bigint }, workerName: string, job: import("./job-provider.js").MiningJob, nonce: string, minerWork?: Buffer | null, algorithm: string | null }} input
   */
  return async ({ worker, workerName, job, nonce, minerWork: submittedWork = null, algorithm }) => {
    if (algorithm !== "xel/v3" || job.algorithm !== "xel/v3") {
      return { error: { code: STRATUM_ERRORS.UNKNOWN, message: "Unsupported PoW algorithm" } };
    }

    const minerWork = submittedWork ?? job.buildMinerWork(nonce);
    const hash = asU256(await hashMinerWorkAsync(minerWork));
    const shareDifficulty = BigInt(job.shareDifficulty);
    const networkDifficulty = BigInt(job.networkDifficulty);
    const meetsShareTarget = hash <= MAX_U256 / shareDifficulty;
    const meetsNetworkTarget = hash <= MAX_U256 / networkDifficulty;

    const block = meetsNetworkTarget ? await submitBlockCandidate({ worker, workerName, job, minerWork }) : null;

    const persisted = await recordShare(pool, {
      workerId: worker.workerId,
      jobId: job.jobId,
      nonce,
      difficulty: String(job.shareDifficulty),
      networkDifficulty: job.networkDifficulty,
      accepted: meetsShareTarget,
      rejectReason: meetsShareTarget ? null : "low_difficulty",
    });
    if (persisted.duplicate) {
      return { error: { code: STRATUM_ERRORS.DUPLICATE_SHARE, message: "Duplicate share" } };
    }
    if (!meetsShareTarget) {
      return { error: { code: STRATUM_ERRORS.LOW_DIFFICULTY, message: "Share difficulty is below the assigned target" } };
    }
    return { accepted: true, block };
  };
}
