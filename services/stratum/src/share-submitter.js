import { blake3 } from "@noble/hashes/blake3.js";
import { recordBlock, recordServiceEvent, recordShare } from "@xeldash/db";
import { hashMinerWork } from "@xeldash/xelis-hash";
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

/**
 * @param {{ daemon: import("./daemon-client.js").DaemonClient, pool: import("pg").Pool, logger?: Pick<Console, "warn" | "info"> }} dependencies
 */
export function createShareSubmitter({ daemon, pool, logger = console }) {
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
      const submitted = await daemon.submitBlock(job.template, minerWork.toString("hex"));
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

    try {
      await recordBlock(pool, {
        hash,
        height: job.height,
        minerId: worker.minerId ?? null,
        workerId: worker.workerId,
        status,
      });
      await recordServiceEvent(pool, failure ? "block_rejected" : "block_submitted", {
        hash,
        height: job.height,
        jobId: job.jobId,
        workerName,
        ...(failure ? { error: failure } : {}),
      });
    } catch (error) {
      logger.warn?.("Failed to record a submitted block candidate", { hash, error: errorMessage(error) });
    }
  }

  /** @param {{ worker: { minerId?: string | bigint, workerId: string | bigint }, workerName: string, job: import("./job-provider.js").MiningJob, nonce: string, algorithm: string | null }} input */
  return async ({ worker, workerName, job, nonce, algorithm }) => {
    if (algorithm !== "xel/v3" || job.algorithm !== "xel/v3") {
      return { error: { code: STRATUM_ERRORS.UNKNOWN, message: "Unsupported PoW algorithm" } };
    }

    const minerWork = job.buildMinerWork(nonce);
    const hash = asU256(hashMinerWork(minerWork));
    const shareDifficulty = BigInt(job.shareDifficulty);
    const networkDifficulty = BigInt(job.networkDifficulty);
    const meetsShareTarget = hash <= MAX_U256 / shareDifficulty;
    const meetsNetworkTarget = hash <= MAX_U256 / networkDifficulty;

    if (meetsNetworkTarget) {
      await submitBlockCandidate({ worker, workerName, job, minerWork });
    }

    const persisted = await recordShare(pool, {
      workerId: worker.workerId,
      jobId: job.jobId,
      nonce,
      difficulty: String(job.shareDifficulty),
      accepted: meetsShareTarget,
      rejectReason: meetsShareTarget ? null : "low_difficulty",
    });
    if (persisted.duplicate) {
      return { error: { code: STRATUM_ERRORS.DUPLICATE_SHARE, message: "Duplicate share" } };
    }
    if (!meetsShareTarget) {
      return { error: { code: STRATUM_ERRORS.LOW_DIFFICULTY, message: "Share difficulty is below the assigned target" } };
    }
    return { accepted: true };
  };
}
