// A ceiling on how often Stratum may call its XELIS node for miners (templates, work, address checks), whatever miners do. On a
// public server many strangers can connect; without a ceiling, enough of them (with many addresses) could make xelDash send the
// node more requests than it should serve, and the node may be one the XELIS network depends on. Found blocks never wait here.

/** The default burst: a fifth of a second's worth of calls. @param {number} perSecond */
export function burstFor(perSecond) {
  return Math.max(1, Math.ceil(perSecond / 5));
}

/** The call budget is used up and the caller waited long enough: the miner is told to retry. */
export class NodeBusy extends Error {
  constructor() {
    super("The server is busy; try again shortly");
    this.name = "NodeBusy";
  }
}

/**
 * A token bucket: `perSecond` calls a second on average, up to `burst` at once (a fifth of a second's worth by default, so no
 * single second carries much more than `perSecond`). Callers that find it empty wait their turn, in
 * order, up to `maxWaitMs`; after that, or when `maxQueue` are already waiting, they are refused with a "busy" error (the miner
 * retries; its current work stays valid meanwhile).
 */
export class NodeBudget {
  /**
   * @param {{ perSecond: number, burst?: number, maxWaitMs?: number, maxQueue?: number, now?: () => number,
   *   onGrant?: (at: number) => void }} options
   *   perSecond 0 means no ceiling (the default outside public mode); onGrant is told the moment each call is let through
   */
  constructor({ perSecond, burst = burstFor(perSecond), maxWaitMs = 10_000, maxQueue = 1_000, now = Date.now, onGrant = () => {} }) {
    this.onGrant = onGrant;
    this.perSecond = perSecond;
    this.burst = burst;
    this.maxWaitMs = maxWaitMs;
    this.maxQueue = maxQueue;
    this.now = now;
    this.tokens = burst;
    this.last = now();
    /** @type {{ resolve: () => void, reject: (error: Error) => void, timer: ReturnType<typeof setTimeout> }[]} */
    this.queue = [];
    /** @type {ReturnType<typeof setTimeout> | null} */
    this.drainTimer = null;
    this.stats = { granted: 0, refused: 0 };
  }

  get unlimited() {
    return !(this.perSecond > 0);
  }

  #refill() {
    const now = this.now();
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.last) / 1000) * this.perSecond);
    this.last = now;
  }

  /** Wait for permission to make one call to the node. */
  take() {
    if (this.unlimited) {
      this.stats.granted++;
      this.onGrant(this.now());
      return Promise.resolve();
    }
    this.#refill();
    if (this.queue.length === 0 && this.tokens >= 1) {
      this.tokens -= 1;
      this.stats.granted++;
      this.onGrant(this.now());
      return Promise.resolve();
    }
    if (this.queue.length >= this.maxQueue) {
      this.stats.refused++;
      return Promise.reject(new NodeBusy());
    }
    return new Promise((resolve, reject) => {
      const entry = {
        resolve: () => resolve(undefined),
        reject,
        timer: setTimeout(() => {
          const i = this.queue.indexOf(entry);
          if (i >= 0) this.queue.splice(i, 1);
          this.stats.refused++;
          reject(new NodeBusy());
        }, this.maxWaitMs),
      };
      this.queue.push(entry);
      this.#scheduleDrain();
    });
  }

  #scheduleDrain() {
    if (this.drainTimer || this.queue.length === 0) return;
    this.#refill();
    const wait = this.tokens >= 1 ? 0 : Math.ceil(((1 - this.tokens) / this.perSecond) * 1000);
    this.drainTimer = setTimeout(() => {
      this.drainTimer = null;
      this.#refill();
      while (this.queue.length > 0 && this.tokens >= 1) {
        const entry = /** @type {NonNullable<typeof this.queue[number]>} */ (this.queue.shift());
        clearTimeout(entry.timer);
        this.tokens -= 1;
        this.stats.granted++;
        this.onGrant(this.now());
        entry.resolve();
      }
      this.#scheduleDrain();
    }, wait);
    this.drainTimer.unref?.();
  }

  /** How many calls are waiting, for the status page. */
  get waiting() {
    return this.queue.length;
  }
}
