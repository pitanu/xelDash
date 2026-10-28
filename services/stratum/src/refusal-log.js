// Refused connections, logged at most once a minute per address and reason. A client reconnecting in a loop is refused thousands of
// times a second, and a log line for each one cost Stratum a large part of a processor core (docs/REQUIREMENTS.md, "Under attack");
// the first refusal is logged at once, and the next line after a minute says how many there were in between.

const INTERVAL_MS = 60_000;
const MAX_KEYS = 10_000;

export class RefusalLog {
  /** @param {{ warn: (message: string) => void }} [logger] @param {number} [intervalMs] */
  constructor(logger = console, intervalMs = INTERVAL_MS) {
    this.logger = logger;
    this.intervalMs = intervalMs;
    /** @type {Map<string, { at: number, skipped: number }>} */
    this.seen = new Map();
  }

  /**
   * @param {string} kind "Stratum" or "getwork" @param {string} ip @param {string} reason @param {number} [now]
   */
  refused(kind, ip, reason, now = Date.now()) {
    const key = `${kind}|${ip}|${reason}`;
    const entry = this.seen.get(key);
    if (entry && now - entry.at < this.intervalMs) {
      entry.skipped += 1;
      return;
    }
    const more = entry?.skipped ? ` (and ${entry.skipped} more in the last ${Math.round((now - entry.at) / 1000)} s)` : "";
    this.logger.warn(`Refusing ${kind} connection from ${ip}: ${reason}${more}`);
    this.seen.set(key, { at: now, skipped: 0 });
    if (this.seen.size > MAX_KEYS) {
      for (const [k, e] of this.seen) if (now - e.at >= this.intervalMs) this.seen.delete(k);
      if (this.seen.size > MAX_KEYS) this.seen.clear();
    }
  }
}
