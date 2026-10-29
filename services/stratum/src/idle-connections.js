// Connections that hold a place without mining. A logged-in connection that never sends a share costs the attacker nothing, and
// enough of them fill the per-IP and total connection limits so real miners are turned away ("server full"). Two answers: close a
// connection that has been quiet too long (the idle timeout, on public servers by default), and when a limit is reached, make room
// by closing a connection that has never had a share accepted and has been quiet for a while, rather than refusing the newcomer.

/**
 * What the decisions need from a session (session.js).
 * @typedef {{ openedAt: number, lastShareAt: number | null, hadAcceptedShare: boolean, ip?: string | null }} Activity
 */

/**
 * A connection is only made room for once it has been quiet this long: a slow rig can take a couple of minutes to send its first
 * share (start difficulty 100,000 at under 1 KH/s), and newcomers must not push out a real miner that is still finding it.
 */
export const EVICT_AFTER_QUIET_MS = 120_000;

/** @param {Activity} activity */
function lastActive(activity) {
  return activity.lastShareAt ?? activity.openedAt;
}

/**
 * The connections quiet for longer than the idle limit: `idleMs` since the last share, or half of it for a connection that has never
 * sent one (a real miner sends its first within minutes). An idle limit of 0 closes nothing.
 * @template K
 * @param {Map<K, Activity>} sessions @param {number} idleMs @param {number} [now]
 * @returns {K[]}
 */
export function idleConnections(sessions, idleMs, now = Date.now()) {
  if (!(idleMs > 0)) return [];
  /** @type {K[]} */
  const idle = [];
  for (const [key, activity] of sessions) {
    const limit = activity.lastShareAt === null ? idleMs / 2 : idleMs;
    if (now - lastActive(activity) > limit) idle.push(key);
  }
  return idle;
}

/**
 * The connection to close to make room for a new one: never had a share accepted, quiet for at least `quietMs`, and quiet the
 * longest. With `ip`, only a connection from that address (its own per-IP limit). Null when none qualifies: then the newcomer is
 * refused as before, so connections that mine are never closed for it.
 * @template K
 * @param {Map<K, Activity>} sessions @param {{ ip?: string, quietMs?: number, now?: number }} [options]
 * @returns {K | null}
 */
export function connectionToEvict(sessions, { ip, quietMs = EVICT_AFTER_QUIET_MS, now = Date.now() } = {}) {
  /** @type {K | null} */
  let pick = null;
  let pickSince = Infinity;
  for (const [key, activity] of sessions) {
    if (activity.hadAcceptedShare) continue;
    if (ip !== undefined && activity.ip !== ip) continue;
    const since = lastActive(activity);
    if (now - since < quietMs || since >= pickSince) continue;
    pick = key;
    pickSince = since;
  }
  return pick;
}

/**
 * Places for connections, on top of the IP guard's counts (ip-guard.js): when a limit is reached, a connection that has not mined is
 * closed to make room (connectionToEvict), and its place is given back at once, so its later close event must not give it back again.
 * Stratum and getwork share one, so either can make room in the other.
 */
export class ConnectionPlaces {
  /**
   * @param {{ connect: (ip: string, now?: number, options?: { attempted?: boolean }) => string | null, disconnect: (ip: string) => void }} guard
   * @param {Map<{ destroy: () => void }, Activity>} sessions
   * @param {{ onEvict?: (evictedIp: string, forIp: string, reason: string) => void }} [hooks]
   */
  constructor(guard, sessions, { onEvict = () => {} } = {}) {
    this.guard = guard;
    this.sessions = sessions;
    this.onEvict = onEvict;
    /** Connections whose place was given back when they were closed to make room. @type {WeakSet<object>} */
    this.released = new WeakSet();
  }

  /**
   * Count a new connection from this address, making room when the per-IP or total limit is reached. Returns why it is refused, or
   * null. `attempted`: its connection rate was charged when it was accepted (the TLS port).
   * @param {string} ip @param {number} [now] @param {{ attempted?: boolean }} [options]
   */
  admit(ip, now = Date.now(), options = {}) {
    const refused = this.guard.connect(ip, undefined, options);
    if (refused !== "server full" && refused !== "too many connections") return refused;
    const victim = connectionToEvict(this.sessions, refused === "too many connections" ? { ip, now } : { now });
    const victimIp = victim ? this.sessions.get(victim)?.ip : null;
    if (!victim || !victimIp) return refused;
    this.onEvict(victimIp, ip, refused);
    this.released.add(victim);
    this.guard.disconnect(victimIp);
    victim.destroy();
    // The first try was charged to the connection rate already.
    return this.guard.connect(ip, undefined, { attempted: true });
  }

  /** Give a closed connection's place back, unless that was done when it was closed to make room. @param {object} socket @param {string} ip */
  release(socket, ip) {
    if (!this.released.delete(socket)) this.guard.disconnect(ip);
  }
}
