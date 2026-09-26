import { randomBytes } from "node:crypto";

const MINER_WORK_BYTES = 112;
const HEADER_HASH_BYTES = 32;
const TIMESTAMP_OFFSET = 32;

/** @typedef {{ jobId: string, template: string, timestampHex: string, headerWorkHash: string, algorithm: string, networkDifficulty: string, height: number, topoheight: number, nodeId: number, shareDifficulty: number, extraNonce: Buffer, publicKey: Buffer, buildMinerWork: (nonce: string) => Buffer }} MiningJob */

/**
 * Share difficulty never exceeds network difficulty: work at network difficulty is a block.
 * @param {number} shareDifficulty @param {string} networkDifficulty
 */
export function capShareDifficulty(shareDifficulty, networkDifficulty) {
  return BigInt(networkDifficulty) < BigInt(shareDifficulty) ? Number(networkDifficulty) : shareDifficulty;
}

/**
 * The same work at a new share difficulty, under a new job id so shares are checked against
 * the difficulty they were issued with.
 * @param {MiningJob} job @param {number} shareDifficulty @returns {MiningJob}
 */
export function reissueJob(job, shareDifficulty) {
  return {
    ...job,
    jobId: randomBytes(16).toString("hex"),
    shareDifficulty: capShareDifficulty(shareDifficulty, job.networkDifficulty),
  };
}

export class MiningJobProvider {
  /** @param {{ nodes: import("./node-pool.js").NodePool }} options */
  constructor({ nodes }) {
    this.nodes = nodes;
  }

  /** @param {{ address: string, publicKey: string, extraNonce: string, algorithm: string, shareDifficulty: number }} input @returns {Promise<MiningJob>} */
  async create({ address, publicKey, extraNonce, algorithm, shareDifficulty: requestedDifficulty }) {
    if (!Number.isSafeInteger(requestedDifficulty) || requestedDifficulty < 1) {
      throw new TypeError("Share difficulty must be a positive safe integer");
    }
    if (algorithm !== "xel/v3") {
      throw new Error(`Only xel/v3 work can be validated; negotiated ${algorithm}`);
    }

    // Template and miner work must come from the same node; the job remembers which one, so a
    // block found on it is submitted there first.
    const node = this.nodes.active;
    if (!node) throw new Error(this.nodes.reason);
    const template = await node.client.getBlockTemplate(address);
    if (typeof template?.template !== "string" || template.template.length === 0) {
      throw new Error("Daemon returned an invalid block template");
    }
    if (template.algorithm !== "xel/v3") {
      throw new Error(`Daemon returned unsupported template algorithm: ${template.algorithm ?? "unknown"}`);
    }
    const work = await node.client.getMinerWork(template.template, address);
    if (work?.algorithm !== "xel/v3") {
      throw new Error(`Daemon returned unsupported PoW algorithm: ${work?.algorithm ?? "unknown"}`);
    }
    if (!Number.isSafeInteger(work.height) || work.height < 0) {
      throw new Error("Daemon returned an invalid block height");
    }
    if (!/^[1-9]\d*$/.test(work.difficulty)) {
      throw new Error("Daemon returned an invalid network difficulty");
    }
    const shareDifficulty = capShareDifficulty(requestedDifficulty, work.difficulty);
    if (typeof work.miner_work !== "string" || !/^[0-9a-f]{224}$/i.test(work.miner_work)) {
      throw new Error("Daemon returned malformed MinerWork");
    }
    if (!/^[0-9a-f]{64}$/i.test(publicKey) || !/^[0-9a-f]{64}$/i.test(extraNonce)) {
      throw new Error("Mining identity or extranonce is malformed");
    }

    const daemonWork = Buffer.from(work.miner_work, "hex");
    if (daemonWork.length !== MINER_WORK_BYTES) throw new Error("Daemon MinerWork length is invalid");
    const timestampHex = BigInt(`0x${daemonWork.subarray(TIMESTAMP_OFFSET, TIMESTAMP_OFFSET + 8).toString("hex")}`).toString(16);
    const headerWorkHash = daemonWork.subarray(0, HEADER_HASH_BYTES).toString("hex");
    const extraNonceBytes = Buffer.from(extraNonce, "hex");
    const publicKeyBytes = Buffer.from(publicKey, "hex");

    return {
      jobId: randomBytes(16).toString("hex"),
      template: template.template,
      timestampHex,
      headerWorkHash,
      algorithm,
      networkDifficulty: work.difficulty,
      height: work.height,
      nodeId: node.id,
      topoheight: work.topoheight !== undefined && Number.isSafeInteger(work.topoheight) ? work.topoheight : work.height,
      shareDifficulty,
      extraNonce: extraNonceBytes,
      publicKey: publicKeyBytes,
      buildMinerWork(nonce) {
        if (!/^[0-9a-f]{16}$/i.test(nonce)) throw new TypeError("Nonce must be 8 bytes of hexadecimal");
        const minerWork = Buffer.alloc(MINER_WORK_BYTES);
        Buffer.from(headerWorkHash, "hex").copy(minerWork, 0);
        daemonWork.copy(minerWork, TIMESTAMP_OFFSET, TIMESTAMP_OFFSET, TIMESTAMP_OFFSET + 8);
        Buffer.from(nonce, "hex").copy(minerWork, 40);
        extraNonceBytes.copy(minerWork, 48);
        publicKeyBytes.copy(minerWork, 80);
        return minerWork;
      },
    };
  }
}
