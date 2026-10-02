// What a standby server's node-admin does that the main server's API does for it: it has no database, so it cannot record
// failover events or raise alerts from them. Instead it keeps a copy of the main server's alert settings (asked for over the
// ingest endpoint, with the cluster secret) and, when it takes over the shared address while the main server cannot be reached,
// sends the alert itself. If the main server answers, it says nothing: the main server reports its own state changes.

const SYNC_MS = 60_000;

export class StandbyAlerts {
  /**
   * @param {{ alertSettings: import("./alert-settings.js").AlertSettings, primaryUrl: string, secret: string, serverName?: string,
   *   fetch?: typeof fetch, logger?: Pick<Console, "info" | "warn"> }} options
   */
  constructor({ alertSettings, primaryUrl, secret, serverName = "standby", fetch: fetchImpl = fetch, logger = console }) {
    this.alertSettings = alertSettings;
    this.primaryUrl = primaryUrl.replace(/\/$/, "");
    this.secret = secret;
    this.serverName = serverName;
    this.fetch = fetchImpl;
    this.logger = logger;
    /** @type {ReturnType<typeof setInterval> | null} */
    this.timer = null;
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
      await this.alertSettings.importFrom(await response.json());
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
    const address = typeof payload.vip === "string" ? payload.vip : "";
    const text = type === "cluster_active"
      ? `🔀 Failover: the main server is not answering, so the standby server (${name}) now holds the shared address ${address}. Your rigs are mining here. The dashboard is offline until the main server returns; nothing is lost.`
      : type === "cluster_fault"
        ? `🚨 The standby server (${name}) cannot mine, and the main server is not answering. Check both servers.`
        : null;
    if (!text) return [];
    if (await this.mainReachable()) return [];
    return this.alertSettings.broadcast(text, "cluster");
  }
}
