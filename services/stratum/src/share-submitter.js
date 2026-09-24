import { recordShare } from "@xeldash/db";
import { hashMinerWork } from "@xeldash/xelis-hash";
import { STRATUM_ERRORS } from "./protocol.js";

const MAX_U256 = (1n << 256n) - 1n;

/** @param {Buffer} hash */
function asU256(hash) {
  if (!Buffer.isBuffer(hash) || hash.length !== 32) throw new TypeError("PoW hash must be 32 bytes");
  return BigInt(`0x${hash.toString("hex")}`);
}

/**
 * @param {{ daemon: import("./daemon-client.js").DaemonClient, pool: import("pg").Pool, logger?: Pick<Console, "warn"> }} dependencies
 */
export function createShareSubmitter({ daemon, pool, logger = console }) {
  /** @param {{ worker: { workerId: string | bigint }, workerName: string, job: import("./job-provider.js").MiningJob, nonce: string, algorithm: string | null }} input */
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
      try {
        const submitted = await daemon.submitBlock(job.template, minerWork.toString("hex"));
        if (!submitted) logger.warn?.("Daemon did not accept a locally valid block candidate", { jobId: job.jobId, workerName });
      } catch (error) {
        logger.warn?.("Failed to submit a valid block candidate", {
          jobId: job.jobId,
          workerName,
          error: error instanceof Error ? error.message : String(error),
        });
      }
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
