import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { compareVersions } from "./releases.js";
import { message } from "./snapshot.js";
import { nodeView } from "./upgrade.js";

const CHECK_MS = 15 * 60_000;
const DEFAULT_DELAY_HOURS = 24;
// On a public server a new release waits at least this long: time for the XELIS community to notice a bad or tampered release
// (the release's checksums come from the same place as the binary, and there is no signature to check).
export const PUBLIC_MIN_DELAY_HOURS = 36;

/** "1.25.0-db59b5c2" to "1.25.0". @param {string | null | undefined} version */
function base(version) {
  return /^(\d+\.\d+\.\d+)/.exec(version ?? "")?.[1] ?? null;
}

/**
 * Keeps the nodes on the latest XELIS release by themselves, using the same one-at-a-time
 * switch as the dashboard. Only with at least two local nodes, so one always mines while the
 * other restarts. A release must be out for a while first (a broken one is usually pulled
 * or fixed by then), and a version that failed on a node is not tried again.
 */
export class AutoUpdate {
  /**
   * @param {{ configDir: string, releases: import("./releases.js").Releases, upgrade: import("./upgrade.js").RollingUpgrade,
   *   nodes: () => import("./nodes.js").Node[], order: () => import("./nodes.js").Node[], scheduled: () => Promise<boolean>,
   *   env: Partial<Record<string, string | undefined>>, publicMode?: () => boolean, logger?: Pick<Console, "info" | "warn"> }} options
   *   publicMode: whether this is a public server (its own XELDASH_PUBLIC_MODE, or its main server's)
   */
  constructor({ configDir, releases, upgrade, nodes, order, scheduled, env, publicMode = () => false, logger = console }) {
    this.configDir = configDir;
    this.file = join(configDir, "auto-update.json");
    this.releases = releases;
    this.upgrade = upgrade;
    this.nodes = nodes;
    this.order = order;
    this.scheduled = scheduled;
    this.logger = logger;
    // XELIS_AUTO_UPDATE in .env. On a public server it is also the only way to allow automatic updates: the dashboard switch can
    // turn them off, and back on only while .env allows them, because installing downloaded programs by themselves on a server
    // open to the internet should take access to the server itself.
    this.defaultEnabled = (env.XELIS_AUTO_UPDATE ?? "false").toLowerCase() === "true";
    this.publicMode = publicMode;
    const delay = Number(env.XELIS_AUTO_UPDATE_DELAY_HOURS || DEFAULT_DELAY_HOURS);
    this.configuredDelayHours = Number.isFinite(delay) && delay >= 0 ? delay : DEFAULT_DELAY_HOURS;
    /** Why nothing happened at the last check, for the dashboard. @type {string | null} */
    this.note = null;
    this.checkedAt = /** @type {string | null} */ (null);
    /** @type {NodeJS.Timeout | null} */
    this.timer = null;
  }

  /** @returns {Promise<{ enabled: boolean, failedVersion: string | null, lastStarted: { version: string, at: string } | null }>} */
  async read() {
    try {
      const saved = JSON.parse(await readFile(this.file, "utf8"));
      return { enabled: saved.enabled === true, failedVersion: saved.failedVersion ?? null, lastStarted: saved.lastStarted ?? null };
    } catch {
      return { enabled: this.defaultEnabled, failedVersion: null, lastStarted: null };
    }
  }

  /** @param {Partial<Awaited<ReturnType<AutoUpdate["read"]>>>} patch */
  async write(patch) {
    const next = { ...(await this.read()), ...patch };
    await mkdir(this.configDir, { recursive: true });
    await writeFile(`${this.file}.tmp`, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o644 });
    await rename(`${this.file}.tmp`, this.file);
    return next;
  }

  /** How long a release must be out before it is installed: the setting, but at least PUBLIC_MIN_DELAY_HOURS on a public server. */
  get delayHours() {
    return this.publicMode() ? Math.max(this.configuredDelayHours, PUBLIC_MIN_DELAY_HOURS) : this.configuredDelayHours;
  }

  /** Whether .env allows automatic updates on this server (always, unless it is a public server without XELIS_AUTO_UPDATE=true). */
  get allowedByEnv() {
    return !this.publicMode() || this.defaultEnabled;
  }

  /** At least two local nodes, so one keeps mining while the other updates. */
  get eligible() {
    return this.nodes().filter((n) => n.present).length >= 2;
  }

  async status() {
    const saved = await this.read();
    // Once an automatic run has ended, say how, instead of "Updating to …" until the next check.
    const run = this.upgrade.state;
    const note = run.trigger === "automatic" && run.phase === "done" && this.note?.startsWith("Updating")
      ? `Updated to ${run.target} (${run.finishedAt})`
      : run.trigger === "automatic" && run.phase === "failed" && this.note?.startsWith("Updating")
        ? `The update to ${run.target} failed: ${run.error}`
        : this.note;
    return {
      ...saved,
      // Saved "on" from the dashboard does not count on a public server whose .env does not allow automatic updates.
      enabled: saved.enabled && this.allowedByEnv,
      publicMode: this.publicMode(),
      allowedByEnv: this.allowedByEnv,
      eligible: this.eligible,
      delayHours: this.delayHours,
      note,
      checkedAt: this.checkedAt,
    };
  }

  /** @param {boolean} enabled */
  async setEnabled(enabled) {
    if (enabled && !this.allowedByEnv) {
      throw new Error("This is a public server: allow automatic updates in .env first (XELIS_AUTO_UPDATE=true), then restart node-admin.");
    }
    if (enabled && !this.eligible) throw new Error("Automatic updates need two local nodes (the redundant profile)");
    await this.write({ enabled });
    if (enabled) void this.check();
    return this.status();
  }

  start() {
    void this.read().then((saved) => {
      if (this.publicMode() && saved.enabled && this.allowedByEnv) {
        this.logger.warn?.(`Public mode with automatic node updates on: new XELIS releases from GitHub are installed ${this.delayHours} h after `
          + "they come out. That trusts the XELIS release process (the checksums come with the release; there is no signature).");
      }
    }).catch(() => {});
    this.timer = setInterval(() => void this.check(), CHECK_MS);
    this.timer.unref();
    setTimeout(() => void this.check(), 60_000).unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  async check() {
    this.checkedAt = new Date().toISOString();
    try {
      this.note = await this.checkOnce();
    } catch (error) {
      this.note = `Check failed: ${message(error)}`;
      this.logger.warn?.(`Automatic update check failed: ${message(error)}`);
    }
  }

  /** One check; returns what it found, for the dashboard. */
  async checkOnce() {
    const saved = await this.read();
    // Remember a version that failed during an automatic run, so it is not retried.
    const last = this.upgrade.state;
    if (last.trigger === "automatic" && last.phase === "failed" && last.target && saved.failedVersion !== last.target) {
      await this.write({ failedVersion: last.target });
      saved.failedVersion = last.target;
    }
    if (!saved.enabled) return null;
    if (!this.allowedByEnv) return "Off on a public server until .env allows it (XELIS_AUTO_UPDATE=true)";
    if (!this.eligible) return "Waiting for a second local node";
    if (this.upgrade.running) return "A version switch is running";
    if (this.nodes().some((n) => n.snapshots.busy)) return "A snapshot or chain copy is running; waiting for it to finish";
    if (await this.scheduled()) return "A switch at a set height is scheduled; automatic updates wait for it";

    const latest = (await this.releases.list())[0];
    if (!latest) return "No release found for this machine";
    if (saved.failedVersion === latest.version) return `${latest.version} failed on a node before; waiting for a newer release`;

    const nodes = this.nodes().filter((n) => n.present);
    const views = await Promise.all(nodes.map((n) => nodeView(n.id)));
    const behind = nodes.filter((_, i) => {
      const running = base(views[i]?.version);
      return running !== null && compareVersions(latest.version, running) > 0;
    });
    if (behind.length === 0) return `Up to date (${latest.version})`;

    const readyAt = latest.publishedAt ? Date.parse(latest.publishedAt) + this.delayHours * 3_600_000 : Date.now();
    if (Date.now() < readyAt) {
      return `${latest.version} is out; updating after ${new Date(readyAt).toISOString()} (${this.delayHours} h after release)`;
    }
    if (nodes.some((n, i) => n.state !== "running" || !views[i]?.synced)) return `${latest.version} is ready; waiting until every node runs and is in sync`;

    this.logger.info?.(`Automatic update to ${latest.version} starting`);
    await this.write({ lastStarted: { version: latest.version, at: new Date().toISOString() } });
    this.upgrade.start(this.order(), latest.version, "automatic");
    return `Updating to ${latest.version}`;
  }
}
