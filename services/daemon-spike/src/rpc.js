/** @typedef {{ algorithm: string, difficulty: string, height: number, topoheight: number, template: string }} BlockTemplate */
/** @typedef {{ algorithm: string, difficulty: string, height: number, miner_work: string, topoheight: number }} MinerWork */

export class DaemonRpc {
  #nextId = 1;

  /**
   * @param {string} endpoint
   * @param {typeof fetch} [fetchImpl]
   */
  constructor(endpoint, fetchImpl = fetch) {
    this.endpoint = endpoint;
    this.fetchImpl = fetchImpl;
  }

  /**
   * @template T
   * @param {string} method
   * @param {Record<string, unknown>} [params]
   * @returns {Promise<T>}
   */
  async call(method, params) {
    const id = this.#nextId++;
    const response = await this.fetchImpl(this.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      throw new Error(`Daemon RPC HTTP ${response.status} ${response.statusText}`);
    }

    /** @type {{ id: number, result?: T, error?: { code: number, message: string, data?: unknown } }} */
    const body = await response.json();
    if (body.error) {
      throw new Error(`Daemon RPC ${method} failed (${body.error.code}): ${body.error.message}`);
    }
    if (body.id !== id || !Object.hasOwn(body, "result")) {
      throw new Error(`Malformed daemon RPC response for ${method}`);
    }
    return /** @type {T} */ (body.result);
  }

  /** @param {string} address @returns {Promise<BlockTemplate>} */
  getBlockTemplate(address) {
    return this.call("get_block_template", { address });
  }

  /** @param {string} template @param {string} [address] @returns {Promise<MinerWork>} */
  getMinerWork(template, address) {
    return this.call("get_miner_work", { template, ...(address ? { address } : {}) });
  }

  /** @param {string} blockTemplate @param {string} [minerWork] @returns {Promise<boolean>} */
  submitBlock(blockTemplate, minerWork) {
    return this.call("submit_block", {
      block_template: blockTemplate,
      ...(minerWork ? { miner_work: minerWork } : {}),
    });
  }
}
