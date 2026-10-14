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
 *
 * On mainnet and testnet a node without peers cannot tell how far behind it is, and the blocks found on it reach nobody, so
 * `onPeers` is told when one has had none for `peerlessMs` (a node that just started takes a few seconds to find them), and again
 * when it has peers back. Mining is not paused for it: the operator is told instead.
 */
export class SyncMonitor {
  /**
   * @param {{ daemon: import("./daemon-client.js").DaemonClient,
   *   onChange?: (state: SyncState, detail: Record<string, unknown>) => void,
   *   onPeers?: (peerless: boolean, detail: { network: string, topoheight: number, peerlessSince: string }) => void,
   *   label?: string, intervalMs?: number, tolerance?: number, confirmations?: number, peerlessMs?: number,
   *   logger?: Pick<Console, "info" | "warn">, now?: () => number }} options
   */
  constructor({ daemon, onChange = () => {}, onPeers = () => {}, label = "Node", intervalMs = 10_000, tolerance = 16, confirmations = 2,
    peerlessMs = 120_000, logger = console, now = Date.now }) {
    this.daemon = daemon;
    this.onChange = onChange;
    this.onPeers = onPeers;
    this.peerlessMs = peerlessMs;
    this.now = now;
    /** Since when a mainnet or testnet node has had no peers, and whether that was announced. @type {number | null} */
    this.peerlessSince = null;
    this.peerlessAnnounced = false;
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
        this.watchPeers(String(info.network ?? "").toLowerCase(), p2p.peer_count, info.topoheight);
      } catch (error) {
        observed = "unreachable";
        detail = { error: message(error) };
      }
      this.apply(observed, detail);
    } finally {
      this.checking = false;
    }
  }

  /** @param {string} network @param {number} peers @param {number} topoheight */
  watchPeers(network, peers, topoheight) {
    // A private devnet has no other nodes to find.
    if (network !== "mainnet" && network !== "testnet") return;
    const now = this.now();
    if (peers > 0) {
      const since = this.peerlessSince;
      this.peerlessSince = null;
      if (this.peerlessAnnounced && since !== null) {
        this.peerlessAnnounced = false;
        this.logger.info?.(`${this.label} has peers again`, { peers });
        this.onPeers(false, { network, topoheight, peerlessSince: new Date(since).toISOString() });
      }
      return;
    }
    this.peerlessSince ??= now;
    if (!this.peerlessAnnounced && now - this.peerlessSince >= this.peerlessMs) {
      this.peerlessAnnounced = true;
      this.logger.warn?.(`${this.label} has had no peers for ${Math.round((now - this.peerlessSince) / 60_000)} min: blocks found on it reach no one`);
      this.onPeers(true, { network, topoheight, peerlessSince: new Date(this.peerlessSince).toISOString() });
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
