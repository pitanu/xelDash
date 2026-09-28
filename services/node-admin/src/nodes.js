import { existsSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DaemonSettings } from "./settings.js";
import { SnapshotManager } from "./snapshot.js";

/**
 * One XELIS node in this stack, managed through files on its data volume that the node's
 * supervisor (docker/daemon/entrypoint.sh) watches: RESTART, STOP and STOPPED.
 */
export class Node {
  /**
   * @param {{ id: string, dataDir: string, network: string, snapshotUrl: string | null, checksumUrl: string | null }} options
   */
  constructor({ id, dataDir, network, snapshotUrl, checksumUrl }) {
    this.id = id;
    this.dataDir = dataDir;
    this.control = join(dataDir, ".xeldash");
    this.snapshots = new SnapshotManager({ dataDir, network, snapshotUrl, checksumUrl });
    this.settings = new DaemonSettings({ dataDir });
  }

  /** The node has started at least once on this volume (its supervisor wrote base-args). */
  get present() {
    return existsSync(join(this.control, "base-args"));
  }

  /** @param {string} name */
  marker(name) {
    return join(this.control, name);
  }

  /** running, stopping (asked to stop, database not closed yet) or stopped. */
  get state() {
    if (!existsSync(this.marker("STOP"))) return "running";
    return existsSync(this.marker("STOPPED")) ? "stopped" : "stopping";
  }

  async stop() {
    await writeFile(this.marker("STOP"), new Date().toISOString());
  }

  async start() {
    await rm(this.marker("STOP"), { force: true });
  }

  async restart() {
    if (this.state !== "running") throw new Error(`${this.id} is stopped; start it instead`);
    await writeFile(this.marker("RESTART"), new Date().toISOString());
  }

  /**
   * Stop and wait until the supervisor reports the daemon has exited, so its database is
   * closed and can be copied. Gives up (and starts it again) after the timeout.
   * @param {number} [timeoutMs]
   */
  async stopAndWait(timeoutMs = 180_000) {
    await this.stop();
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.state === "stopped") return;
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    await this.start();
    throw new Error(`${this.id} did not stop within ${Math.round(timeoutMs / 1000)} s`);
  }

  async status() {
    return {
      id: this.id,
      present: this.present,
      state: this.state,
      dataPresent: this.snapshots.hasData(),
      staged: this.snapshots.isStaged(),
      phase: this.snapshots.state.phase,
    };
  }
}
