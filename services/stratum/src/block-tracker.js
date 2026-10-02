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
    /** Blocks already reported as unknown to a pruned node, so the log is not repeated every pass. @type {Set<string>} */
    this.unknownWarned = new Set();
    /** @type {Set<string>} */
    this.sideNoticed = new Set();
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

  /**
   * A block that another block beat to the same height is a side block right away, well before it
   * is final. Its miner is told then, since side blocks are paid too (a reduced reward) and it will
   * not be shown as a main-chain block. Told once per block, also after a restart.
   * @param {string} hash @param {number} height
   */
  async noticeSideBlock(hash, height) {
    if (this.sideNoticed.has(hash)) return;
    const block = await this.daemon.getBlockByHash(hash).catch(() => null);
    if (block?.block_type !== "Side") return;
    this.sideNoticed.add(hash);
    if (this.sideNoticed.size > 1_000) this.sideNoticed.clear();
    const seen = await this.pool.query("SELECT 1 FROM service_events WHERE type = 'block_side' AND payload->>'hash' = $1 LIMIT 1", [hash]);
    if (seen.rowCount) return;
    this.logger.info?.("Block is a side block for now", { hash, height });
    await recordServiceEvent(this.pool, "block_side", { hash, height });
  }

  async checkOnce() {
    const pending = await listSubmittedBlocks(this.pool);
    if (pending.length === 0) return;
    const info = await this.daemon.getInfo();
    const { stableheight } = info;
    // A pruned node has deleted old blocks, so "the node does not know this block" no longer means it was orphaned.
    const pruned = info.pruned_topoheight !== null && info.pruned_topoheight !== undefined;
    for (const { hash, height } of pending) {
      if (height > stableheight) {
        await this.noticeSideBlock(hash, height);
        continue;
      }
      const block = await this.daemon.getBlockByHash(hash);
      if (!block && pruned) {
        // Keep it pending rather than guess: it may have been paid and then pruned away (docs/OPERATIONS.md, pruning).
        if (!this.unknownWarned.has(hash)) {
          this.unknownWarned.add(hash);
          this.logger.warn?.("A pruned node does not know this block, so its status is left as pending", { hash, height });
        }
        continue;
      }
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
