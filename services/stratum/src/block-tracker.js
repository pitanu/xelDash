import { finalizeBlock, listSubmittedBlocks, recordServiceEvent } from "@xeldash/db";

const FINAL_STATUS = new Map([
  ["Normal", "main-chain"],
  ["Sync", "main-chain"],
  ["Side", "side"],
  ["Orphaned", "orphaned"],
]);

/** @param {unknown} error */
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Moves submitted blocks to their final status once the daemon's stable height passes them.
 * Below stable height the DAG ordering can no longer change, so the daemon's block type is
 * final: Normal and Sync become `main-chain`, Side becomes `side`, and Orphaned or unknown
 * blocks become `orphaned`.
 */
export class BlockTracker {
  /**
   * @param {{ daemon: import("./node-pool.js").NodePool, pool: import("pg").Pool,
   *   intervalMs?: number, logger?: Pick<Console, "info" | "warn"> }} options
   */
  constructor({ daemon, pool, intervalMs = 30_000, logger = console }) {
    this.daemon = daemon;
    this.pool = pool;
    this.intervalMs = intervalMs;
    this.logger = logger;
    /** @type {ReturnType<typeof setInterval> | null} */
    this.timer = null;
    /** @type {Promise<void> | null} */
    this.running = null;
    this.queued = false;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.check(), this.intervalMs);
    this.timer.unref();
    this.check();
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.queued = false;
    await this.running;
  }

  /** Run a pass now; a call during a pass queues one more pass instead of overlapping. */
  check() {
    if (this.running) {
      this.queued = true;
      return;
    }
    this.running = (async () => {
      try {
        do {
          this.queued = false;
          await this.checkOnce();
        } while (this.queued && this.timer);
      } catch (error) {
        this.logger.warn?.("Block status check failed", { error: errorMessage(error) });
      } finally {
        this.running = null;
      }
    })();
  }

  async checkOnce() {
    const pending = await listSubmittedBlocks(this.pool);
    if (pending.length === 0) return;
    const { stableheight } = await this.daemon.getInfo();
    for (const { hash, height } of pending) {
      if (height > stableheight) break;
      const block = await this.daemon.getBlockByHash(hash);
      const status = block ? FINAL_STATUS.get(block.block_type) : "orphaned";
      if (!status) {
        this.logger.warn?.("Daemon returned an unknown block type", { hash, blockType: block?.block_type });
        continue;
      }
      const topoheight = block?.topoheight ?? null;
      const reward = topoheight === null ? null : block?.miner_reward ?? null;
      if (!await finalizeBlock(this.pool, { hash, status, topoheight, reward })) continue;
      this.logger.info?.("Block reached final status", { hash, height, status });
      await recordServiceEvent(this.pool, "block_final", { hash, height, topoheight, status, reward });
    }
  }
}
