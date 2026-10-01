// Free space on the nodes' disks. A node that runs out of space stops, and a half-written chain
// database may need a resync, so a low disk is reported early: on the dashboard, and as a
// `disk_low` event that becomes an alert. Docker volumes often share one disk, so nodes whose
// disks look the same are reported together.

// Binary gigabytes, which is what Windows Explorer, Finder and df show as "GB".
const GB = 1024 ** 3;
const CHECK_INTERVAL_MS = 10 * 60_000;
const REPEAT_MS = 24 * 60 * 60_000;
const CRITICAL_BYTES = 5 * GB;

/** @typedef {{ id: string, snapshots: { disk(): Promise<{ free: number, total: number, source?: string, virtualized?: boolean }> }, present?: boolean }} WatchedNode */
/** @typedef {{ nodes: string[], free: number, total: number, source: string, virtualized: boolean, level: "ok" | "low" | "critical" }} DiskReport */

/** @param {number} free @param {number} warnBytes @returns {"ok" | "low" | "critical"} */
export function diskLevel(free, warnBytes) {
  if (free < Math.min(CRITICAL_BYTES, warnBytes)) return "critical";
  return free < warnBytes ? "low" : "ok";
}

export class DiskWatch {
  /**
   * @param {{ nodes: () => WatchedNode[], record: (type: string, payload: Record<string, unknown>) => void,
   *   env: Partial<Record<string, string | undefined>>, logger?: Pick<Console, "info" | "warn"> }} options
   */
  constructor({ nodes, record, env, logger = console }) {
    this.nodes = nodes;
    this.record = record;
    this.logger = logger;
    const gigabytes = Number(env.XELDASH_DISK_WARN_GB ?? "20");
    // A bad setting falls back to the default rather than switching the warning off.
    this.warnBytes = (Number.isFinite(gigabytes) && gigabytes > 0 ? gigabytes : 20) * GB;
    /** @type {Map<string, { level: string, at: number }>} */
    this.notified = new Map();
    /** @type {ReturnType<typeof setInterval> | null} */
    this.timer = null;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => void this.check().catch(() => {}), CHECK_INTERVAL_MS);
    this.timer.unref();
    void this.check().catch(() => {});
  }

  /** Free space now, nodes on the same disk grouped. @returns {Promise<DiskReport[]>} */
  async report() {
    /** @type {Map<string, DiskReport>} */
    const groups = new Map();
    for (const node of this.nodes()) {
      let disk;
      try {
        disk = await node.snapshots.disk();
      } catch {
        continue;
      }
      // Same size and nearly the same free space means the same disk.
      const key = `${disk.total}:${Math.round(disk.free / GB)}`;
      const group = groups.get(key);
      if (group) group.nodes.push(node.id);
      else {
        groups.set(key, {
          nodes: [node.id], free: disk.free, total: disk.total, source: disk.source ?? "volume", virtualized: Boolean(disk.virtualized),
          level: diskLevel(disk.free, this.warnBytes),
        });
      }
    }
    return [...groups.values()];
  }

  /** Record `disk_low` when a disk first runs low, gets worse, or stays low for a day. */
  async check() {
    const now = Date.now();
    for (const disk of await this.report()) {
      const key = disk.nodes.join(",");
      if (disk.level === "ok") {
        this.notified.delete(key);
        continue;
      }
      const before = this.notified.get(key);
      if (before && before.level === disk.level && now - before.at < REPEAT_MS) continue;
      this.notified.set(key, { level: disk.level, at: now });
      this.logger.warn?.(`Low disk space: ${Math.round(disk.free / GB)} GB free of ${Math.round(disk.total / GB)} GB (${key}, ${disk.source})`);
      this.record("disk_low", { nodes: disk.nodes, freeBytes: disk.free, totalBytes: disk.total, level: disk.level, source: disk.source });
    }
  }

  status() {
    return this.report().then((disks) => ({ warnBytes: this.warnBytes, disks }));
  }
}
