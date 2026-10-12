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

// Work from the node is shared between rigs instead of fetched for each one. A rig's own extra nonce and miner key are written into
// its own copy of the work locally (buildMinerWork, below), so what the node gives is the same for every rig on an address.
//
// It is also the same for every address: in XELIS the header work hash covers the version, height, tips and transactions, not the
// miner (xelis_common BlockHeader::get_work), the node's template differs between addresses only in its miner field, and
// submit_block takes the miner from the submitted MinerWork (BlockHeader::apply_miner_work), whose proof of work includes the miner
// key. So one template per block can serve every address, and the node is asked twice per block whatever the number of miners.
//
// That holds for XELIS today; it is checked on the running node rather than assumed. Until it has been seen to hold, work is shared
// only per address. The first time two addresses get work at the same height, their header work hashes are compared: one match
// proves the hash does not depend on the miner (a hash that did could not match for two different miners), and from then on work
// is shared between all addresses. Mismatches can come from new mempool transactions between the two fetches, so only several in a
// row with no match keep per-address sharing (and say so). The check starts again every `recheckMs` and after a node switch, so a
// node upgraded to a release that changes this falls back by itself. Shared work is dropped on every new block (`invalidate`).
const DEFAULT_SHARE_MS = 2_000;
const DEFAULT_RECHECK_MS = 10 * 60_000;
// Two fetches this close together usually see the same transactions.
const COMPARE_WITHIN_MS = 1_000;
const MISMATCHES_TO_GIVE_UP = 20;

export class MiningJobProvider {
  /**
   * @param {{ nodes: import("./node-pool.js").NodePool, shareMs?: number, recheckMs?: number, now?: () => number,
   *   beforeNodeCall?: () => Promise<void> | void, logger?: Pick<Console, "info" | "warn"> }} options
   *   beforeNodeCall: runs before every call to the node; the call budget waits there (see node-budget.js)
   */
  constructor({ nodes, shareMs = DEFAULT_SHARE_MS, recheckMs = DEFAULT_RECHECK_MS, now = Date.now, beforeNodeCall = () => {}, logger = console }) {
    this.nodes = nodes;
    this.shareMs = shareMs;
    this.recheckMs = recheckMs;
    this.now = now;
    this.beforeNodeCall = beforeNodeCall;
    this.logger = logger;
    /** @type {Map<string, { at: number, work: Promise<{ template: string, work: any }> }>} */
    this.shared = new Map();
    /**
     * Per node: whether its work is known to be the same for every address.
     * @type {Map<number, { mode: "checking" | "all" | "address", since: number, mismatches: number,
     *   seen: Map<string, { height: number, headerHash: string, at: number }> }>}
     */
    this.sharing = new Map();
  }

  /** Forget shared work: a new block or another node makes it stale. */
  invalidate() {
    this.shared.clear();
  }

  /** Start the check again (another node is in use, which may run another XELIS release). */
  recheck() {
    this.sharing.clear();
    this.shared.clear();
  }

  /** How work is shared on a node now: between all addresses, or per address. @param {{ id: number }} node */
  sharingFor(node) {
    const now = this.now();
    let state = this.sharing.get(node.id);
    if (!state || now - state.since >= this.recheckMs) {
      state = { mode: "checking", since: now, mismatches: 0, seen: new Map() };
      this.sharing.set(node.id, state);
    }
    return state;
  }

  /**
   * Compare a fresh per-address fetch with another address's at the same height (see the comment at the top).
   * @param {import("./node-pool.js").PoolNode} node @param {string} address @param {any} work
   */
  #observe(node, address, work) {
    const state = this.sharingFor(node);
    if (state.mode !== "checking" || typeof work?.miner_work !== "string") return;
    const now = this.now();
    const mine = { height: work.height, headerHash: work.miner_work.slice(0, 64).toLowerCase(), at: now };
    for (const [other, seen] of state.seen) {
      if (other === address || seen.height !== mine.height || now - seen.at > COMPARE_WITHIN_MS) continue;
      if (seen.headerHash === mine.headerHash) {
        state.mode = "all";
        this.logger.info?.(`Node ${node.label ?? node.id}: its work is the same for every address, so it is shared between all miners`);
        return;
      }
      state.mismatches++;
      if (state.mismatches >= MISMATCHES_TO_GIVE_UP) {
        state.mode = "address";
        this.logger.warn?.(`Node ${node.label ?? node.id}: its work differs between addresses, so it is shared only per address `
          + "(more calls to the node per block). A newer XELIS release may have changed how work is built.");
        return;
      }
      break;
    }
    state.seen.set(address, mine);
    if (state.seen.size > 32) state.seen.delete(/** @type {string} */ (state.seen.keys().next().value));
  }

  /**
   * The node's template and MinerWork for an address, fetched once and shared while fresh: between all addresses once the node is
   * known to give the same work to every address, otherwise per address. A failed fetch is not kept.
   * @param {import("./node-pool.js").PoolNode} node @param {string} address
   */
  #fetch(node, address) {
    const forAll = this.sharingFor(node).mode === "all";
    const key = forAll ? `${node.id}:*` : `${node.id}:${address}`;
    const now = this.now();
    const hit = this.shared.get(key);
    if (hit && now - hit.at < this.shareMs) return hit.work;
    const work = (async () => {
      await this.beforeNodeCall();
      const template = await node.client.getBlockTemplate(address);
      if (typeof template?.template !== "string" || template.template.length === 0) {
        throw new Error("Daemon returned an invalid block template");
      }
      if (template.algorithm !== "xel/v3") {
        throw new Error(`Daemon returned unsupported template algorithm: ${template.algorithm ?? "unknown"}`);
      }
      await this.beforeNodeCall();
      const minerWork = await node.client.getMinerWork(template.template, address);
      if (!forAll) this.#observe(node, address, minerWork);
      return { template: template.template, work: minerWork };
    })();
    const entry = { at: now, work };
    this.shared.set(key, entry);
    work.catch(() => { if (this.shared.get(key) === entry) this.shared.delete(key); });
    // Keep the map from growing with addresses that stopped mining.
    if (this.shared.size > 10_000) {
      for (const [k, v] of this.shared) if (now - v.at >= this.shareMs) this.shared.delete(k);
    }
    return work;
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
    const { template: templateText, work } = await this.#fetch(node, address);
    const template = { template: templateText };
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
