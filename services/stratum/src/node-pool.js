import { DaemonClient, DaemonUnreachableError } from "./daemon-client.js";
import { SyncMonitor } from "./sync-monitor.js";

const DEFAULT_RPC_URL = "http://daemon:8080/json_rpc";

/**
 * Node RPC endpoints in priority order: XELIS_RPC_URLS (comma-separated), else XELIS_RPC_URL.
 * @param {Partial<Record<string, string | undefined>>} env
 */
export function rpcUrlsFromEnv(env) {
  const raw = env.XELIS_RPC_URLS?.trim() || env.XELIS_RPC_URL?.trim() || DEFAULT_RPC_URL;
  const urls = raw.split(",").map((url) => url.trim()).filter(Boolean);
  for (const url of urls) {
    const { protocol } = new URL(url);
    if (protocol !== "http:" && protocol !== "https:") throw new Error(`XELIS_RPC_URLS: ${url} must be http(s)`);
  }
  if (new Set(urls).size !== urls.length) throw new Error("XELIS_RPC_URLS lists the same node twice");
  return urls;
}

/** Short name for logs and the dashboard: the host, plus the port if it is not 8080. @param {string} url */
export function nodeLabel(url) {
  const { hostname, port } = new URL(url);
  return port && port !== "8080" ? `${hostname}:${port}` : hostname;
}

/** @typedef {{ id: number, url: string, label: string, client: DaemonClient, monitor: SyncMonitor }} PoolNode */

/**
 * The XELIS nodes Stratum can mine through. Work comes from the active node: the first node,
 * in configured order, that is in sync with its own peers and not behind our other nodes.
 * When it stops qualifying, the next one takes over; when it recovers, mining moves back.
 * Each node's state needs two consecutive checks to change, so a single slow reply does not
 * cause a switch. Found blocks go to the node that issued the job, then to the others if it
 * cannot be reached.
 */
export class NodePool {
  /**
   * @param {{ urls: string[], intervalMs?: number, tolerance?: number,
   *   onActiveChange?: (active: PoolNode | null, previous: PoolNode | null) => void,
   *   logger?: Pick<Console, "info" | "warn"> }} options
   */
  constructor({ urls, intervalMs = 5_000, tolerance = 16, onActiveChange = () => {}, logger = console }) {
    if (urls.length === 0) throw new Error("At least one node RPC URL is required");
    this.tolerance = tolerance;
    this.onActiveChange = onActiveChange;
    this.logger = logger;
    /** @type {PoolNode | null} */
    this.active = null;
    /** @type {PoolNode[]} */
    this.nodes = urls.map((url, id) => {
      const client = new DaemonClient(url);
      const label = nodeLabel(url);
      return {
        id,
        url,
        label,
        client,
        monitor: new SyncMonitor({
          daemon: client,
          label: `Node ${label}`,
          intervalMs,
          tolerance,
          logger,
          onChange: () => this.select(),
        }),
      };
    });
  }

  async start() {
    await Promise.all(this.nodes.map((node) => node.monitor.start()));
    this.select();
  }

  stop() {
    for (const node of this.nodes) node.monitor.stop();
  }

  /** Re-check one node now, for example when its event connection drops. @param {PoolNode} node */
  checkNow(node) {
    void node.monitor.check().then(() => this.select());
  }

  /** Nodes that can issue work: ready, and not far behind the most advanced ready node. */
  eligible() {
    const ready = this.nodes.filter((node) => node.monitor.ready);
    const best = Math.max(...ready.map((node) => Number(node.monitor.detail.topoheight ?? 0)));
    return ready.filter((node) => best - Number(node.monitor.detail.topoheight ?? 0) <= this.tolerance);
  }

  select() {
    const next = this.eligible()[0] ?? null;
    if (next === this.active) return;
    const previous = this.active;
    this.active = next;
    if (next) this.logger.info?.(`Mining through node ${next.label}${previous ? ` (was ${previous.label})` : ""}`);
    else this.logger.warn?.(`No node can issue work: ${this.reason}`);
    this.onActiveChange(next, previous);
  }

  get ready() {
    return this.active !== null;
  }

  /** Why no node can issue work, for miners and logs. */
  get reason() {
    if (this.nodes.length === 1) return this.nodes[0].monitor.reason;
    const syncing = this.nodes.find((node) => node.monitor.state === "syncing");
    if (syncing) return `No node is ready (${syncing.label}: ${syncing.monitor.reason})`;
    return "No node is responding; try again shortly";
  }

  /** The active node's client. Throws while no node can issue work. */
  client() {
    if (!this.active) throw new Error(this.reason);
    return this.active.client;
  }

  // The DaemonClient methods other modules use, routed to the active node.

  /** @param {string} address */
  getMiningIdentity(address) {
    return this.client().getMiningIdentity(address);
  }

  getInfo() {
    return this.client().getInfo();
  }

  /** @param {string} hash */
  getBlockByHash(hash) {
    return this.client().getBlockByHash(hash);
  }

  /**
   * Submit to the node that issued the job first. Only if it cannot be reached, try the other
   * ready nodes: a node that answers has judged the block, and another node would too.
   * @param {string} template @param {string} minerWork @param {number} [nodeId]
   */
  async submitBlock(template, minerWork, nodeId) {
    const issuer = this.nodes.find((node) => node.id === nodeId) ?? this.active;
    const order = [issuer, ...this.nodes.filter((node) => node !== issuer && node.monitor.ready)].filter(Boolean);
    /** @type {unknown} */
    let lastError = new Error(this.reason);
    for (const node of /** @type {PoolNode[]} */ (order)) {
      try {
        const accepted = await node.client.submitBlock(template, minerWork);
        if (node !== issuer) this.logger.warn?.(`Submitted a block through ${node.label}; ${issuer?.label} was unreachable`);
        return accepted;
      } catch (error) {
        lastError = error;
        if (!(error instanceof DaemonUnreachableError)) throw error;
      }
    }
    throw lastError;
  }
}
