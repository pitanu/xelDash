import { readFile } from "node:fs/promises";
import { join } from "node:path";

// This server's part in a redundancy cluster, as reported by the address manager (docker/keepalived), which
// writes cluster.json to the shared config volume whenever its role changes: MASTER (this server holds the
// shared address and the rigs mine here), BACKUP (standing by), FAULT (cannot mine, so it gave the address up).
// Changes are recorded as events, which become alerts. Without a cluster there is no file and nothing shows.

const POLL_MS = 5_000;
const EVENT_FOR = /** @type {Record<string, string>} */ ({ MASTER: "cluster_active", BACKUP: "cluster_standby", FAULT: "cluster_fault" });

/** @typedef {{ state: "MASTER" | "BACKUP" | "FAULT" | "STOP", since: string, vip: string, interface: string, server: string }} ClusterState */

export class ClusterWatch {
  /** @param {{ configDir: string, record: (type: string, payload: Record<string, unknown>) => void }} options */
  constructor({ configDir, record }) {
    this.file = join(configDir, "cluster.json");
    this.record = record;
    /** @type {string | null} */
    this.last = null;
    /** @type {ReturnType<typeof setInterval> | null} */
    this.timer = null;
  }

  /** @returns {Promise<ClusterState | null>} */
  async read() {
    try {
      const state = JSON.parse(await readFile(this.file, "utf8"));
      return typeof state?.state === "string" ? state : null;
    } catch {
      return null;
    }
  }

  async status() {
    const state = await this.read();
    return state ? { configured: true, ...state } : { configured: false };
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => void this.check().catch(() => {}), POLL_MS);
    this.timer.unref();
    void this.check().catch(() => {});
  }

  /** Record a change of role; the first look only remembers it. */
  async check() {
    const state = await this.read();
    if (!state) return;
    const key = `${state.state}@${state.since}`;
    if (this.last === null) {
      this.last = key;
      return;
    }
    if (key === this.last) return;
    this.last = key;
    const type = EVENT_FOR[state.state];
    if (type) this.record(type, { server: state.server, vip: state.vip });
  }
}
