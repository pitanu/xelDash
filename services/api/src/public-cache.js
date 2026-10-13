// Short-lived caches for a public server (public mode), so traffic from the internet cannot turn into load on the database or,
// above all, on the XELIS node: the public answers are the same for every visitor, so each is worked out at most once every few
// seconds, and requests that arrive while it is being worked out wait for that one result.

/**
 * Answers to public GET requests, by URL. The cluster's ingest routes (they carry a secret and its answer), live updates and the
 * CSV export are never cached.
 * @param {import("node:http").IncomingMessage} request @returns {string | null} the cache key, or null when not cacheable
 */
export function publicCacheKey(request) {
  if (request.method !== "GET") return null;
  // The same normalised path the router reads (dot segments resolved), so a request cannot be cached as one route and answered as another.
  let url;
  try {
    url = new URL(request.url ?? "/", "http://localhost");
  } catch {
    return null;
  }
  const path = url.pathname;
  if (!path.startsWith("/api/v1/")) return null;
  if (path.startsWith("/api/v1/ingest") || path === "/api/v1/live" || path === "/api/v1/blocks.csv") return null;
  return path + url.search;
}

/** Results by key, each kept `ttlMs`; one computation at a time per key. */
export class ShortCache {
  /** @param {{ ttlMs?: number, maxEntries?: number, now?: () => number }} [options] */
  constructor({ ttlMs = 2_000, maxEntries = 5_000, now = Date.now } = {}) {
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    this.now = now;
    /** @type {Map<string, { at: number, value?: any, pending?: Promise<any> }>} */
    this.entries = new Map();
  }

  /**
   * A fresh value, or the one being worked out right now (null if that one is abandoned), or undefined: work it out yourself.
   * @param {string} key
   */
  async lookup(key) {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.pending) return (await entry.pending) ?? undefined;
    if (this.now() - entry.at < this.ttlMs) return entry.value;
    this.entries.delete(key);
    return undefined;
  }

  /**
   * Start working out a key: others asking meanwhile wait for `complete` (or get nothing from `abandon` and work it out
   * themselves). @param {string} key
   */
  begin(key) {
    /** @type {(value: any) => void} */
    let settle = () => {};
    const pending = new Promise((resolve) => { settle = resolve; });
    const entry = { at: this.now(), pending };
    this.entries.set(key, entry);
    if (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined && oldest !== key) this.entries.delete(oldest);
    }
    let done = false;
    return {
      /** @param {any} value */
      complete: (value) => {
        if (done) return;
        done = true;
        if (this.entries.get(key) === entry) this.entries.set(key, { at: this.now(), value });
        settle(value);
      },
      abandon: () => {
        if (done) return;
        done = true;
        if (this.entries.get(key) === entry) this.entries.delete(key);
        settle(null);
      },
    };
  }

  /**
   * The cached result of `work` for a key, worked out at most once every ttlMs (a failure is not kept).
   * @template T @param {string} key @param {() => Promise<T>} work @returns {Promise<T>}
   */
  async get(key, work) {
    const cached = await this.lookup(key);
    if (cached !== undefined) return cached;
    const entry = this.begin(key);
    try {
      const value = await work();
      entry.complete(value);
      return value;
    } catch (error) {
      entry.abandon();
      throw error;
    }
  }
}
