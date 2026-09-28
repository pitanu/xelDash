// Switching nodes to another daemon version, one node at a time. Each node is switched,
// restarted, and must report the new version and catch up with its peers before the next
// one is touched, so mining always has an up-to-date node (with two nodes). The node that
// normally mines (the first) goes last. Runs here, not in the browser, so closing the page
// does not stop it halfway.

import { message } from "./snapshot.js";

const SYNC_TOLERANCE = 16;
const START_TIMEOUT_MS = 5 * 60_000;
const SYNC_TIMEOUT_MS = 30 * 60_000;
const POLL_MS = 5_000;

/** @param {string} nodeId @param {string} method */
async function rpc(nodeId, method) {
  const response = await fetch(`http://${nodeId}:8080/json_rpc`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method }),
    signal: AbortSignal.timeout(3_000),
  });
  const body = await response.json();
  if (body.error) throw new Error(body.error.message);
  return body.result;
}

/** What a node reports right now, or null when it does not answer. @param {string} nodeId */
export async function nodeView(nodeId) {
  try {
    const [version, info, p2p] = await Promise.all([rpc(nodeId, "get_version"), rpc(nodeId, "get_info"), rpc(nodeId, "p2p_status")]);
    const synced = p2p.peer_count > 0 && p2p.median_topoheight <= info.topoheight + SYNC_TOLERANCE;
    return { version: String(version), topoheight: info.topoheight, peers: p2p.peer_count, synced };
  } catch {
    return null;
  }
}

/** @param {number} ms */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @typedef {{ node: string, status: "waiting" | "downloading" | "restarting" | "syncing" | "done" | "skipped" | "failed", note: string | null }} Step
 * @typedef {{ phase: "idle" | "running" | "done" | "failed", target: string | null, steps: Step[], startedAt: string | null, finishedAt: string | null, error: string | null }} UpgradeState
 */

export class RollingUpgrade {
  /** @param {{ releases: import("./releases.js").Releases, logger?: Pick<Console, "info" | "warn"> }} options */
  constructor({ releases, logger = console }) {
    this.releases = releases;
    this.logger = logger;
    /** @type {UpgradeState} */
    this.state = { phase: "idle", target: null, steps: [], startedAt: null, finishedAt: null, error: null };
  }

  get running() {
    return this.state.phase === "running";
  }

  /**
   * Start switching the given nodes (in order) to a version: a release number, or "image"
   * for each node's image's own daemon.
   * @param {import("./nodes.js").Node[]} nodes @param {string} target
   */
  start(nodes, target) {
    if (this.running) throw new Error("A version switch is already running");
    this.state = {
      phase: "running",
      target,
      steps: nodes.map((n) => ({ node: n.id, status: "waiting", note: null })),
      startedAt: new Date().toISOString(),
      finishedAt: null,
      error: null,
    };
    void this.run(nodes, target);
  }

  /** @param {string} nodeId @param {Partial<Step>} patch */
  step(nodeId, patch) {
    this.state = { ...this.state, steps: this.state.steps.map((s) => (s.node === nodeId ? { ...s, ...patch } : s)) };
  }

  /** @param {import("./nodes.js").Node[]} nodes @param {string} target */
  async run(nodes, target) {
    for (const node of nodes) {
      try {
        await this.switchNode(node, target);
      } catch (error) {
        const text = message(error);
        this.step(node.id, { status: "failed", note: text });
        this.logger.warn?.(`Version switch stopped at ${node.id}: ${text}`);
        this.state = { ...this.state, phase: "failed", error: `${node.id}: ${text}. Later nodes were left as they were.`, finishedAt: new Date().toISOString() };
        return;
      }
    }
    this.state = { ...this.state, phase: "done", finishedAt: new Date().toISOString() };
  }

  /** @param {import("./nodes.js").Node} node @param {string} target */
  async switchNode(node, target) {
    const before = await this.releases.nodeStatus(node);
    if (before.binary === target) {
      this.step(node.id, { status: "skipped", note: "Already on this version" });
      return;
    }
    if (node.state !== "running") throw new Error("The node is stopped; start it first");
    if (target !== "image") {
      this.step(node.id, { status: "downloading", note: "Downloading and checking the release" });
      await this.releases.install(node, target);
    }
    this.step(node.id, { status: "restarting", note: "Restarting on the new version" });
    const resultBefore = before.lastResult?.at ?? null;
    await this.releases.activate(node, target);

    // The supervisor records applied, rejected or reverted; wait for it to report this switch.
    const deadline = Date.now() + START_TIMEOUT_MS;
    for (;;) {
      if (Date.now() > deadline) throw new Error("The node did not come back on the new version in time");
      await sleep(POLL_MS);
      const now = await this.releases.nodeStatus(node);
      const result = now.lastResult;
      if (result && result.at !== resultBefore && result.outcome !== "applied") {
        throw new Error(result.message ?? `The switch was ${result.outcome}`);
      }
      const view = await nodeView(node.id);
      if (result?.at !== resultBefore && result?.outcome === "applied" && view
          && (target === "image" || view.version.startsWith(target))) break;
    }
    // Stay on this node until the settle time has passed, so a quick crash is caught here.
    await sleep(35_000);
    const settled = await this.releases.nodeStatus(node);
    if (settled.lastResult?.outcome === "reverted") throw new Error(settled.lastResult.message ?? "The node was switched back");

    this.step(node.id, { status: "syncing", note: "Catching up with the network" });
    const syncDeadline = Date.now() + SYNC_TIMEOUT_MS;
    let confirmations = 0;
    while (confirmations < 2) {
      if (Date.now() > syncDeadline) throw new Error("The node did not catch up within 30 minutes");
      await sleep(POLL_MS);
      const view = await nodeView(node.id);
      confirmations = view?.synced ? confirmations + 1 : 0;
      if (view) this.step(node.id, { note: `Catching up: topoheight ${view.topoheight}, ${view.peers} peers` });
    }
    await this.releases.prune(node);
    const view = await nodeView(node.id);
    this.step(node.id, { status: "done", note: view ? `Running ${view.version}, in sync` : "In sync" });
    this.logger.info?.(`${node.id} switched to ${target}`);
  }
}
