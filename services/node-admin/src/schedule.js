import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { message } from "./snapshot.js";
import { nodeView } from "./upgrade.js";

const TICK_MS = 10_000;

/**
 * @typedef {{ version: string, height: number, createdAt: string,
 *   status: "preparing" | "ready" | "started" | "done" | "failed", note: string | null, startedAt: string | null }} Schedule
 */

/**
 * A version switch at a block height, for network upgrades (hard forks) that name a minimum
 * version from a given height. The release is downloaded and checked on every node when the
 * switch is scheduled, so a problem shows long before the height; at the height, the nodes
 * switch one at a time as usual. Kept on the config volume, so it survives restarts.
 */
export class ScheduledUpgrade {
  /**
   * @param {{ configDir: string, releases: import("./releases.js").Releases, upgrade: import("./upgrade.js").RollingUpgrade,
   *   order: () => import("./nodes.js").Node[], logger?: Pick<Console, "info" | "warn"> }} options
   */
  constructor({ configDir, releases, upgrade, order, logger = console }) {
    this.configDir = configDir;
    this.file = join(configDir, "scheduled-upgrade.json");
    this.releases = releases;
    this.upgrade = upgrade;
    this.order = order;
    this.logger = logger;
    /** @type {NodeJS.Timeout | null} */
    this.timer = null;
    this.ticking = false;
  }

  /** @returns {Promise<Schedule | null>} */
  async read() {
    try {
      return JSON.parse(await readFile(this.file, "utf8"));
    } catch {
      return null;
    }
  }

  /** @param {Schedule} schedule */
  async write(schedule) {
    await mkdir(this.configDir, { recursive: true });
    await writeFile(`${this.file}.tmp`, `${JSON.stringify(schedule, null, 2)}\n`, { mode: 0o644 });
    await rename(`${this.file}.tmp`, this.file);
  }

  /** @param {Partial<Schedule>} patch */
  async update(patch) {
    const current = await this.read();
    if (current) await this.write({ ...current, ...patch });
  }

  /** The highest height any node reports, and its average block time. */
  async chain() {
    const views = await Promise.all(this.order().map((n) => nodeView(n.id)));
    const answering = views.filter((v) => v !== null);
    if (answering.length === 0) return null;
    const best = answering.reduce((a, b) => (b.height > a.height ? b : a));
    return { height: best.height, averageBlockTimeMs: best.averageBlockTimeMs };
  }

  /** A switch waiting for its height (or being prepared), which other updates should leave alone. */
  async pending() {
    const schedule = await this.read();
    return schedule !== null && ["preparing", "ready"].includes(schedule.status);
  }

  async status() {
    const schedule = await this.read();
    const chain = await this.chain();
    const blocksLeft = schedule && chain ? schedule.height - chain.height : null;
    return {
      schedule,
      height: chain?.height ?? null,
      averageBlockTimeMs: chain?.averageBlockTimeMs ?? null,
      etaSeconds: blocksLeft !== null && chain?.averageBlockTimeMs ? Math.max(0, (blocksLeft * chain.averageBlockTimeMs) / 1000) : null,
    };
  }

  /** @param {string} version @param {number} height */
  async create(version, height) {
    if (await this.pending()) throw new Error("A switch is already scheduled; cancel it first");
    if (!Number.isSafeInteger(height) || height < 1) throw new Error("The height must be a positive whole number");
    await this.releases.find(version);
    const chain = await this.chain();
    if (!chain) throw new Error("No node answers, so the current height is unknown");
    if (height <= chain.height) throw new Error(`Height ${height} has passed (the chain is at ${chain.height}); switch now instead`);
    const schedule = /** @type {Schedule} */ ({
      version, height, createdAt: new Date().toISOString(), status: "preparing", note: "Downloading and checking the release on every node", startedAt: null,
    });
    await this.write(schedule);
    void this.prepare(version);
    return this.status();
  }

  /** Download and check the release on every node now, not at the height. @param {string} version */
  async prepare(version) {
    try {
      for (const node of this.order()) await this.releases.install(node, version);
      const current = await this.read();
      if (current?.status === "preparing" && current.version === version) {
        await this.update({ status: "ready", note: "Downloaded and checked on every node; waiting for the height" });
      }
    } catch (error) {
      await this.update({ status: "failed", note: `Preparing failed: ${message(error)}` });
      this.logger.warn?.(`Scheduled switch to ${version} could not be prepared: ${message(error)}`);
    }
  }

  async cancel() {
    const schedule = await this.read();
    if (schedule?.status === "started") throw new Error("The switch has started; it cannot be cancelled now");
    await rm(this.file, { force: true });
  }

  start() {
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  async tick() {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const schedule = await this.read();
      if (!schedule) return;
      if (schedule.status === "started") {
        // Follow the switch this schedule started until it ends.
        const run = this.upgrade.state;
        if (run.trigger === "scheduled" && run.phase === "done") await this.update({ status: "done", note: `Switched to ${schedule.version}` });
        if (run.trigger === "scheduled" && run.phase === "failed") await this.update({ status: "failed", note: run.error });
        // node-admin restarted during the switch: the run is lost; report it rather than guess.
        if (run.phase === "idle") await this.update({ status: "failed", note: "node-admin restarted during the switch; check each node's version" });
        return;
      }
      if (schedule.status !== "ready") return;
      const chain = await this.chain();
      if (!chain || chain.height < schedule.height) return;
      if (this.upgrade.running) return;
      // Restarting a node in the middle of a snapshot or chain copy would break it; wait for the next tick.
      if (this.order().some((n) => n.snapshots.busy)) return;
      this.logger.info?.(`Height ${chain.height} reached; switching to ${schedule.version}`);
      await this.update({ status: "started", startedAt: new Date().toISOString(), note: `Height ${chain.height} reached; switching` });
      this.upgrade.start(this.order(), schedule.version, "scheduled");
    } catch (error) {
      this.logger.warn?.(`Scheduled switch check failed: ${message(error)}`);
    } finally {
      this.ticking = false;
    }
  }
}
