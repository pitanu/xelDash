/**
 * @typedef {{ maxConnectionsPerIp: number, messagesPerSecond: number, messageBurst: number,
 *   invalidWindowSeconds: number, invalidMinCount: number, invalidRatio: number,
 *   banMinutes: number, exemptIps: string[] }} IpGuardConfig
 */

/** @type {IpGuardConfig} */
export const DEFAULT_IP_GUARD = Object.freeze({
  maxConnectionsPerIp: 64,
  messagesPerSecond: 20,
  messageBurst: 40,
  invalidWindowSeconds: 300,
  invalidMinCount: 50,
  invalidRatio: 0.5,
  banMinutes: 15,
  exemptIps: [],
});

/** @param {Partial<Record<string, string | undefined>>} env @returns {IpGuardConfig} */
export function ipGuardConfigFromEnv(env) {
  /** @param {string} name @param {number} fallback */
  const read = (name, fallback) => {
    const value = env[name] === undefined || env[name] === "" ? fallback : Number(env[name]);
    if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number`);
    return value;
  };
  const invalidRatio = read("STRATUM_BAN_INVALID_RATIO", DEFAULT_IP_GUARD.invalidRatio);
  if (invalidRatio > 1) throw new Error("STRATUM_BAN_INVALID_RATIO must be between 0 and 1");
  return {
    maxConnectionsPerIp: read("STRATUM_MAX_CONNECTIONS_PER_IP", DEFAULT_IP_GUARD.maxConnectionsPerIp),
    messagesPerSecond: read("STRATUM_MESSAGES_PER_SECOND", DEFAULT_IP_GUARD.messagesPerSecond),
    messageBurst: read("STRATUM_MESSAGE_BURST", DEFAULT_IP_GUARD.messageBurst),
    invalidWindowSeconds: read("STRATUM_BAN_WINDOW_SECONDS", DEFAULT_IP_GUARD.invalidWindowSeconds),
    invalidMinCount: read("STRATUM_BAN_INVALID_COUNT", DEFAULT_IP_GUARD.invalidMinCount),
    invalidRatio,
    banMinutes: read("STRATUM_BAN_MINUTES", DEFAULT_IP_GUARD.banMinutes),
    exemptIps: (env.STRATUM_BAN_EXEMPT_IPS ?? "").split(",").map((ip) => normalizeIp(ip.trim())).filter(Boolean),
  };
}

/** IPv4 clients on a dual-stack socket appear as `::ffff:a.b.c.d`. @param {string | undefined} ip */
export function normalizeIp(ip) {
  if (!ip) return "unknown";
  return ip.startsWith("::ffff:") && ip.includes(".") ? ip.slice(7) : ip;
}

/**
 * Per-connection token bucket for incoming Stratum messages.
 */
export class MessageRateLimiter {
  /** @param {{ messagesPerSecond: number, messageBurst: number }} config @param {number} [now] */
  constructor({ messagesPerSecond, messageBurst }, now = Date.now()) {
    this.rate = messagesPerSecond;
    this.burst = messageBurst;
    this.tokens = messageBurst;
    this.updated = now;
  }

  /** @param {number} count @param {number} [now] Returns false when the messages exceed the limit. */
  take(count, now = Date.now()) {
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.updated) / 1000) * this.rate);
    this.updated = now;
    this.tokens -= count;
    return this.tokens >= 0;
  }
}

/**
 * Tracks connections, share validity and bans per client IP. Stale shares are neither good
 * nor bad: every miner sends some after each new block.
 */
export class IpGuard {
  /**
   * @param {IpGuardConfig} config
   * @param {{ onBan?: (ban: { ip: string, reason: string, until: Date }) => void }} [hooks]
   */
  constructor(config, { onBan = () => {} } = {}) {
    this.config = config;
    this.onBan = onBan;
    this.exempt = new Set(config.exemptIps);
    /** @type {Map<string, number>} */
    this.connections = new Map();
    /** @type {Map<string, number>} ip -> banned until (ms) */
    this.bans = new Map();
    /** @type {Map<string, { start: number, valid: number, invalid: number }>} */
    this.windows = new Map();
  }

  /** @param {{ ip: string, until: Date }[]} bans */
  loadBans(bans) {
    for (const { ip, until } of bans) this.bans.set(normalizeIp(ip), until.getTime());
  }

  /** @param {string} ip @param {number} [now] */
  isBanned(ip, now = Date.now()) {
    const until = this.bans.get(ip);
    if (until === undefined) return false;
    if (until > now) return true;
    this.bans.delete(ip);
    return false;
  }

  /**
   * Register a new connection. Returns a reason string when it must be refused.
   * @param {string} ip @param {number} [now]
   */
  connect(ip, now = Date.now()) {
    if (this.isBanned(ip, now)) return "banned";
    const open = this.connections.get(ip) ?? 0;
    if (open >= this.config.maxConnectionsPerIp && !this.exempt.has(ip)) return "too many connections";
    this.connections.set(ip, open + 1);
    return null;
  }

  /** @param {string} ip */
  disconnect(ip) {
    const open = (this.connections.get(ip) ?? 1) - 1;
    if (open <= 0) this.connections.delete(ip);
    else this.connections.set(ip, open);
  }

  /**
   * Count a good or bad submission. Returns true when this call banned the IP.
   * @param {string} ip @param {boolean} valid @param {number} [now]
   */
  record(ip, valid, now = Date.now()) {
    if (this.exempt.has(ip)) return false;
    let window = this.windows.get(ip);
    if (!window || now - window.start >= this.config.invalidWindowSeconds * 1000) {
      window = { start: now, valid: 0, invalid: 0 };
      this.windows.set(ip, window);
    }
    if (valid) window.valid += 1;
    else window.invalid += 1;
    if (valid || window.invalid < this.config.invalidMinCount) return false;
    if (window.invalid / (window.valid + window.invalid) <= this.config.invalidRatio) return false;
    this.ban(ip, `${window.invalid} invalid of ${window.valid + window.invalid} submissions in ${this.config.invalidWindowSeconds}s`, now);
    return true;
  }

  /** Drop expired windows and bans so the maps stay bounded. @param {number} [now] */
  prune(now = Date.now()) {
    for (const [ip, window] of this.windows) {
      if (now - window.start >= this.config.invalidWindowSeconds * 1000) this.windows.delete(ip);
    }
    for (const [ip, until] of this.bans) if (until <= now) this.bans.delete(ip);
  }

  /** @param {string} ip @param {string} reason @param {number} [now] */
  ban(ip, reason, now = Date.now()) {
    if (this.exempt.has(ip)) return;
    const until = new Date(now + this.config.banMinutes * 60_000);
    this.bans.set(ip, until.getTime());
    this.windows.delete(ip);
    this.onBan({ ip, reason, until });
  }
}
