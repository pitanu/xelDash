export interface BlockTemplate {
  algorithm: string;
  difficulty: string;
  height: number;
  topoheight: number;
  template: string;
}

interface JsonRpcResponse<T> {
  id: number;
  result?: T;
  error?: { code: number; message: string; data?: unknown };
}

export class DaemonRpc {
  private nextId = 1;

  constructor(
    private readonly endpoint: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async call<T>(method: string, params?: Record<string, unknown>): Promise<T> {
    const id = this.nextId++;
    const response = await this.fetchImpl(this.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      throw new Error(`Daemon RPC HTTP ${response.status} ${response.statusText}`);
    }

    const body = (await response.json()) as JsonRpcResponse<T>;
    if (body.error) {
      throw new Error(`Daemon RPC ${method} failed (${body.error.code}): ${body.error.message}`);
    }
    if (body.id !== id || !Object.hasOwn(body, "result")) {
      throw new Error(`Malformed daemon RPC response for ${method}`);
    }
    return body.result as T;
  }

  getBlockTemplate(address: string): Promise<BlockTemplate> {
    return this.call<BlockTemplate>("get_block_template", { address });
  }

  getMinerWork(template: string, address?: string): Promise<{
    algorithm: string;
    difficulty: string;
    height: number;
    miner_work: string;
    topoheight: number;
  }> {
    return this.call("get_miner_work", { template, ...(address ? { address } : {}) });
  }

  submitBlock(blockTemplate: string, minerWork?: string): Promise<boolean> {
    return this.call("submit_block", {
      block_template: blockTemplate,
      ...(minerWork ? { miner_work: minerWork } : {}),
    });
  }
}
