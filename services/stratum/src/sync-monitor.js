/** @typedef {"unknown" | "ready" | "syncing" | "unreachable"} SyncState */

/** @param {unknown} error */
function message(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Tracks whether the local node is caught up with the network, so Stratum never hands out
 * work on an old chain. Uses the peers' median topoheight, not the best one, so a single peer
 * claiming a high topoheight cannot pause mining. A node with no peers counts as ready: on a
 * private devnet that is normal, and the Health page warns about it separately.
 */
export class SyncMonitor {
  /**
   * @param {{ daemon: import("./daemon-client.js").DaemonClient,
   *   onChange?: (state: SyncState, detail: Record<string, unknown>) => void,
   *   label?: string, intervalMs?: number, tolerance?: number, confirmations?: number,
   *   logger?: Pick<Console, "info" | "warn"> }} options
   */
  constructor({ daemon, onChange = () => {}, label = "Node", intervalMs = 10_000, tolerance = 16, confirmations = 2, logger = console }) {
    this.daemon = daemon;
    this.onChange = onChange;
    this.label = label;
    this.intervalMs = intervalMs;
    this.tolerance = tolerance;
    this.confirmations = confirmations;
    this.logger = logger;
    /** @type {SyncState} */
    this.state = "unknown";
    /** @type {Record<string, unknown>} */
    this.detail = {};
    /** @type {SyncState | null} */
    this.pending = null;
    this.pendingCount = 0;
    /** @type {ReturnType<typeof setInterval> | null} */
    this.timer = null;
    this.checking = false;
  }

  /** Jobs may only be issued while this is true. */
  get ready() {
    return this.state === "ready";
  }

  /** Why mining is paused, for miners and logs. */
  get reason() {
    if (this.state === "syncing") {
      return `Node is syncing (topoheight ${this.detail.topoheight} of ${this.detail.networkTopoheight}); try again shortly`;
    }
    if (this.state === "unreachable") return "Node is not responding; try again shortly";
    return "Node status is not known yet; try again shortly";
  }

  async start() {
    await this.check();
    this.timer = setInterval(() => void this.check(), this.intervalMs);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async check() {
    if (this.checking) return;
    this.checking = true;
    try {
      /** @type {SyncState} */
      let observed;
      /** @type {Record<string, unknown>} */
      let detail;
      try {
        const [info, p2p] = await Promise.all([this.daemon.getInfo(), this.daemon.getP2pStatus()]);
        const behind = p2p.peer_count > 0 ? p2p.median_topoheight - info.topoheight : 0;
        observed = behind > this.tolerance ? "syncing" : "ready";
        detail = { topoheight: info.topoheight, networkTopoheight: p2p.median_topoheight, peers: p2p.peer_count };
      } catch (error) {
        observed = "unreachable";
        detail = { error: message(error) };
      }
      this.apply(observed, detail);
    } finally {
      this.checking = false;
    }
  }

  /** @param {SyncState} observed @param {Record<string, unknown>} detail */
  apply(observed, detail) {
    if (observed === this.state) {
      this.detail = detail;
      this.pending = null;
      return;
    }
    // The first reading is trusted; later changes need consecutive confirmations.
    if (this.state !== "unknown") {
      if (this.pending !== observed) {
        this.pending = observed;
        this.pendingCount = 1;
      } else {
        this.pendingCount += 1;
      }
      if (this.pendingCount < this.confirmations) return;
    }
    const previous = this.state;
    this.state = observed;
    this.detail = detail;
    this.pending = null;
    if (observed === "ready") this.logger.info?.(`${this.label} is ready`, detail);
    else this.logger.warn?.(`${this.label} is not ready: ${this.reason}`, detail);
    this.onChange(observed, { ...detail, previous });
  }
}
