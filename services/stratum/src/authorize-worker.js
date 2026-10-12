import { NodeBusy } from "./node-budget.js";

/**
 * A login refused for a reason the miner should be told plainly (not an invalid address). `abusive` refusals count against the
 * connection like a failed login (so spraying addresses ends in a ban); others, such as a busy server, do not.
 */
export class LoginRefused extends Error {
  /** @param {string} message @param {{ reason: string, abusive?: boolean }} options */
  constructor(message, { reason, abusive = false }) {
    super(message);
    this.name = "LoginRefused";
    this.reason = reason;
    this.abusive = abusive;
  }
}

/**
 * The worker for a login. The node checks the address; the store finds or creates the worker (during a
 * database outage, from the workers seen before, or a provisional one that is created when the database
 * is back).
 *
 * Checked addresses are remembered (`cacheMs`; an invalid one for `invalidCacheMs`), so rigs logging in again, or a farm
 * reconnecting hundreds of rigs, cost the node nothing. Each check that does reach the node first passes the call budget. With
 * `maxAddressesPerIp`, one IP address may log in with at most that many different addresses within `addressWindowMs`: a farm uses
 * a few, while made-up addresses (each one a call to the node) are what an attack on the node would need.
 * @param {{ daemon: import("./node-pool.js").NodePool, store: import("./store.js").DurableStore,
 *   budget?: { take: () => Promise<void> } | null, cacheMs?: number, invalidCacheMs?: number, maxEntries?: number,
 *   maxAddressesPerIp?: number | (() => number), addressWindowMs?: number, now?: () => number }} dependencies
 *   maxAddressesPerIp may be a function, read at each login (a standby can become a public server while running)
 */
export function createWorkerAuthorizer({ daemon, store, budget = null, cacheMs = 10 * 60_000, invalidCacheMs = 60_000, maxEntries = 10_000,
  maxAddressesPerIp = 0, addressWindowMs = 10 * 60_000, now = Date.now }) {
  /** @type {Map<string, { at: number, identity: Promise<any> }>} */
  const identities = new Map();
  /** @type {Map<string, Map<string, number>>} */
  const addressesByIp = new Map();

  /** @param {string} address */
  function identityOf(address) {
    const t = now();
    const hit = identities.get(address);
    if (hit) return hit.identity;
    const identity = (async () => {
      await budget?.take();
      return daemon.getMiningIdentity(address);
    })();
    const entry = { at: t, identity };
    identities.set(address, entry);
    identity.then(
      (found) => {
        // Kept for cacheMs when valid, invalidCacheMs when the node said no.
        const ttl = found ? cacheMs : invalidCacheMs;
        setTimeout(() => { if (identities.get(address) === entry) identities.delete(address); }, ttl).unref?.();
      },
      () => { if (identities.get(address) === entry) identities.delete(address); },
    );
    if (identities.size > maxEntries) {
      const oldest = identities.keys().next().value;
      if (oldest !== undefined && oldest !== address) identities.delete(oldest);
    }
    return identity;
  }

  /** Refuse a new address from an IP address that already used its share. @param {string | undefined} ip @param {string} address */
  function checkAddressesPerIp(ip, address) {
    const limit = typeof maxAddressesPerIp === "function" ? maxAddressesPerIp() : maxAddressesPerIp;
    if (!(limit > 0) || !ip) return;
    const t = now();
    let seen = addressesByIp.get(ip);
    if (!seen) {
      seen = new Map();
      addressesByIp.set(ip, seen);
    }
    for (const [a, at] of seen) if (t - at > addressWindowMs) seen.delete(a);
    if (!seen.has(address) && seen.size >= limit) {
      throw new LoginRefused(`Too many different addresses from your connection (at most ${limit}); mine to fewer addresses`,
        { reason: "too_many_addresses", abusive: true });
    }
    seen.set(address, t);
    // Forget IP addresses that went quiet, so the map does not grow without end.
    if (addressesByIp.size > 50_000) {
      for (const [k, v] of addressesByIp) {
        if ([...v.values()].every((at) => t - at > addressWindowMs)) addressesByIp.delete(k);
      }
    }
  }

  /** @param {{ address: string, workerName: string, password?: string, ip?: string }} input */
  return async ({ address, workerName, ip }) => {
    checkAddressesPerIp(ip, address);
    let identity;
    try {
      identity = await identityOf(address);
    } catch (error) {
      if (error instanceof NodeBusy) {
        throw new LoginRefused("The server is busy; try again in a moment", { reason: "busy" });
      }
      throw error;
    }
    if (!identity) return null;
    const ids = await store.ensureWorker({ address, name: workerName, ip });
    return { ...ids, address, publicKey: identity.publicKey, provisional: ids.workerId === null };
  };
}
