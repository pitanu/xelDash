// What a standby server's node-admin does that the main server's API does for it: it has no database, so it cannot record
// failover events or raise alerts from them. Instead it keeps a copy of the main server's alert settings (asked for over the
// ingest endpoint, with the cluster secret) and, when it takes over the shared address while the main server cannot be reached,
// sends the alert itself. If the main server answers, it says nothing: the main server reports its own state changes.

import { readFile, rename, writeFile } from "node:fs/promises";

const SYNC_MS = 60_000;

export class StandbyAlerts {
  /**
   * @param {{ alertSettings: import("./alert-settings.js").AlertSettings, primaryUrl: string, secret: string, serverName?: string,
   *   publicMode?: boolean, stateFile?: string | null, fetch?: typeof fetch, logger?: Pick<Console, "info" | "warn"> }} options
   *   publicMode: this server's own XELDASH_PUBLIC_MODE; stateFile: where the main server's public flag is kept across restarts
   */
  constructor({ alertSettings, primaryUrl, secret, serverName = "standby", publicMode = false, stateFile = null, fetch: fetchImpl = fetch, logger = console }) {
    this.alertSettings = alertSettings;
    this.primaryUrl = primaryUrl.replace(/\/$/, "");
    this.secret = secret;
    this.serverName = serverName;
    this.fetch = fetchImpl;
    this.logger = logger;
    this.envPublicMode = publicMode;
    this.stateFile = stateFile;
    // Whether the main server is a public server, as it said last (kept in stateFile while it is away).
    this.mainPublic = false;
    /** @type {ReturnType<typeof setInterval> | null} */
    this.timer = null;
  }

  /** A public server's alerts leave out the shared address (an address on the operator's network). */
  get publicMode() {
    return this.envPublicMode || this.mainPublic;
  }

  /** Read what the main server last said about public mode. */
  async init() {
    if (!this.stateFile) return;
    try {
      this.mainPublic = JSON.parse(await readFile(this.stateFile, "utf8")).publicMode === true;
    } catch {
      // Never told yet.
    }
  }

  /** @param {boolean} value */
  async #rememberPublic(value) {
    if (value === this.mainPublic) return;
    this.mainPublic = value;
    if (!this.stateFile) return;
    const tmp = `${this.stateFile}.tmp`;
    await writeFile(tmp, JSON.stringify({ publicMode: value, updatedAt: new Date().toISOString() }), { mode: 0o600 });
    await rename(tmp, this.stateFile);
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => void this.sync().catch(() => {}), SYNC_MS);
    this.timer.unref();
    void this.sync().catch(() => {});
  }

  /** @param {string} path */
  async #get(path) {
    return this.fetch(`${this.primaryUrl}${path}`, { headers: { "x-cluster-secret": this.secret }, signal: AbortSignal.timeout(4_000) });
  }

  /** Whether the main server answers right now. */
  async mainReachable() {
    try {
      return (await this.#get("/api/v1/ingest/ping")).ok;
    } catch {
      return false;
    }
  }

  /** Copy the main server's alert settings, so an alert can be sent while it is away. Keeps the last copy if it cannot be reached. */
  async sync() {
    try {
      const response = await this.#get("/api/v1/ingest/alerts");
      if (!response.ok) return false;
      const settings = await response.json();
      if (typeof settings?.publicMode === "boolean") await this.#rememberPublic(settings.publicMode);
      await this.alertSettings.importFrom(settings);
      return true;
    } catch (error) {
      this.logger.warn?.("Could not copy the alert settings from the main server:", error instanceof Error ? error.message : String(error));
      return false;
    }
  }

  /**
   * The cluster role of this server changed. Only a failover that the main server cannot report is alerted here.
   * @param {string} type @param {Record<string, unknown>} payload
   */
  async onClusterChange(type, payload) {
    const name = typeof payload.server === "string" ? payload.server : this.serverName;
    const address = typeof payload.vip === "string" && !this.publicMode ? ` ${payload.vip}` : "";
    const text = type === "cluster_active"
      ? `Failover: the main server is not answering, so the standby server (${name}) now holds the shared address${address}. Your rigs are mining here. The dashboard is offline until the main server returns; nothing is lost.`
      : type === "cluster_fault"
        ? `The standby server (${name}) cannot mine, and the main server is not answering. Check both servers.`
        : null;
    if (!text) return [];
    if (await this.mainReachable()) return [];
    return this.alertSettings.broadcast(text, "cluster");
  }
}
