/**
 * The daemon could not be reached (connection refused, DNS failure, timeout), as opposed to
 * answering with an error. Only this kind of failure is worth retrying on another node.
 */
export class DaemonUnreachableError extends Error {
  /** @param {string} endpoint @param {unknown} cause */
  constructor(endpoint, cause) {
    super(`Daemon at ${endpoint} is unreachable: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    this.name = "DaemonUnreachableError";
  }
}

/** The daemon answered, with a JSON-RPC error: it judged the request (for example, an invalid address). */
export class DaemonRpcError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = "DaemonRpcError";
  }
}

export class DaemonClient {
  #id = 0;

  constructor(endpoint = process.env.XELIS_RPC_URL ?? "http://daemon:8080/json_rpc") {
    this.endpoint = endpoint;
  }

  /** @template T @param {string} method @param {Record<string, unknown>} [params] @returns {Promise<T>} */
  async call(method, params) {
    const id = ++this.#id;
    /** @type {Response} */
    let response;
    try {
      response = await fetch(this.endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) }),
        signal: AbortSignal.timeout(5_000),
      });
    } catch (error) {
      throw new DaemonUnreachableError(this.endpoint, error);
    }
    if (!response.ok) throw new Error(`Daemon RPC returned HTTP ${response.status}`);
    const body = await response.json();
    if (body.id !== id || body.error || !Object.hasOwn(body, "result")) {
      if (body.error) throw new DaemonRpcError(`Daemon RPC ${method} failed: ${body.error.message ?? "error"}`);
      throw new Error(`Daemon RPC ${method} failed: malformed response`);
    }
    return /** @type {T} */ (body.result);
  }

  /** @param {string} address @returns {Promise<{ publicKey: string } | null>} */
  async getMiningIdentity(address) {
    /** @type {{ is_integrated?: boolean, is_valid?: boolean }} */
    const validation = /** @type {{ is_integrated?: boolean, is_valid?: boolean }} */ (
      await this.call("validate_address", { address, allow_integrated: false })
    );
    if (!validation?.is_valid || validation.is_integrated) return null;
    /** @type {{ hex?: string }} */
    const key = /** @type {{ hex?: string }} */ (
      await this.call("extract_key_from_address", { address, as_hex: true })
    );
    if (typeof key?.hex !== "string") throw new Error("Daemon did not return the mining public key");
    return { publicKey: key.hex };
  }

  /** @param {string} address @returns {Promise<{ algorithm: string, difficulty: string, height: number, template: string }>} */
  getBlockTemplate(address) {
    return this.call("get_block_template", { address });
  }

  /** @param {string} template @param {string} address @returns {Promise<{ algorithm: string, difficulty: string, height: number, topoheight?: number, miner_work: string }>} */
  getMinerWork(template, address) {
    return this.call("get_miner_work", { template, address });
  }

  /** @param {string} template @param {string} minerWork @returns {Promise<boolean>} */
  submitBlock(template, minerWork) {
    return this.call("submit_block", { block_template: template, miner_work: minerWork });
  }

  /** @returns {Promise<{ height: number, topoheight: number, stableheight: number }>} */
  getInfo() {
    return this.call("get_info");
  }

  /** @returns {Promise<{ peer_count: number, median_topoheight: number, best_topoheight: number, our_topoheight: number }>} */
  getP2pStatus() {
    return this.call("p2p_status");
  }

  /**
   * @param {string} hash
   * @returns {Promise<{ block_type: string, height: number, topoheight: number | null, miner_reward?: number | null } | null>}
   * Resolves to null when the daemon does not know the block.
   */
  async getBlockByHash(hash) {
    try {
      return await this.call("get_block_by_hash", { hash });
    } catch (error) {
      if (error instanceof Error && /not found/i.test(error.message)) return null;
      throw error;
    }
  }
}
