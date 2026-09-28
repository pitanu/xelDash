/**
 * @typedef {{ startDifficulty: number, minDifficulty: number, targetShareSeconds: number,
 *   retargetSeconds: number, retargetShares: number }} VardiffConfig
 */

/** @type {VardiffConfig} */
export const DEFAULT_VARDIFF = Object.freeze({
  startDifficulty: 100_000,
  minDifficulty: 1_000,
  targetShareSeconds: 10,
  retargetSeconds: 60,
  retargetShares: 20,
});

// Retargets never move more than 2x up or down at once. Changes under 50% are skipped:
// with about 6 shares per window, share-timing noise alone is around +-40%.
const MAX_STEP = 2;
const DEAD_BAND = 1.5;

/** @param {Partial<Record<string, string | undefined>>} env @returns {VardiffConfig} */
export function vardiffConfigFromEnv(env) {
  /** @param {string} name @param {number} fallback */
  const read = (name, fallback) => {
    const value = env[name] === undefined || env[name] === "" ? fallback : Number(env[name]);
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
    return value;
  };
  const config = {
    startDifficulty: read("STRATUM_START_DIFFICULTY", DEFAULT_VARDIFF.startDifficulty),
    minDifficulty: read("STRATUM_MIN_DIFFICULTY", DEFAULT_VARDIFF.minDifficulty),
    targetShareSeconds: read("STRATUM_TARGET_SHARE_SECONDS", DEFAULT_VARDIFF.targetShareSeconds),
    retargetSeconds: read("STRATUM_RETARGET_SECONDS", DEFAULT_VARDIFF.retargetSeconds),
    retargetShares: read("STRATUM_RETARGET_SHARES", DEFAULT_VARDIFF.retargetShares),
  };
  if (config.startDifficulty < config.minDifficulty) {
    throw new Error("STRATUM_START_DIFFICULTY must be at least STRATUM_MIN_DIFFICULTY");
  }
  return config;
}

/**
 * Per-connection variable difficulty. The miner's hashrate is estimated from the difficulty
 * of accepted shares over the window, and the next difficulty aims for one share every
 * `targetShareSeconds`.
 */
export class Vardiff {
  /** @param {VardiffConfig} config @param {number} [now] */
  constructor(config, now = Date.now()) {
    this.config = config;
    this.difficulty = config.startDifficulty;
    this.windowStart = now;
    this.windowShares = 0;
    this.windowDifficulty = 0;
    this.fixed = false;
  }

  /**
   * Hold the difficulty at a value the miner asked for (password d=...), never below the
   * configured minimum. Retargeting stops for this connection.
   * @param {number} difficulty
   */
  fix(difficulty) {
    this.difficulty = Math.max(this.config.minDifficulty, Math.floor(difficulty));
    this.fixed = true;
  }

  /** @param {number} now */
  reset(now) {
    this.windowStart = now;
    this.windowShares = 0;
    this.windowDifficulty = 0;
  }

  /**
   * Count an accepted share. Returns the new difficulty when this share closes a window
   * and the difficulty changes, otherwise null.
   * @param {number} shareDifficulty @param {number} maxDifficulty @param {number} [now]
   */
  recordShare(shareDifficulty, maxDifficulty, now = Date.now()) {
    this.windowShares += 1;
    this.windowDifficulty += shareDifficulty;
    if (this.windowShares < this.config.retargetShares) return this.retargetIfDue(maxDifficulty, now);
    return this.retarget(maxDifficulty, now);
  }

  /**
   * Retarget if the time window has elapsed; call periodically so idle miners are lowered.
   * @param {number} maxDifficulty @param {number} [now]
   */
  retargetIfDue(maxDifficulty, now = Date.now()) {
    if (now - this.windowStart < this.config.retargetSeconds * 1000) return null;
    return this.retarget(maxDifficulty, now);
  }

  /** @param {number} maxDifficulty @param {number} now */
  retarget(maxDifficulty, now) {
    if (this.fixed) return null;
    const elapsedSeconds = Math.max((now - this.windowStart) / 1000, 1);
    const hashrate = this.windowDifficulty / elapsedSeconds;
    const ideal = hashrate * this.config.targetShareSeconds;
    this.reset(now);

    const current = this.difficulty;
    let factor = ideal / current;
    if (factor > 1 / DEAD_BAND && factor < DEAD_BAND) return null;
    factor = Math.min(Math.max(factor, 1 / MAX_STEP), MAX_STEP);
    const ceiling = Math.max(this.config.minDifficulty, Math.floor(maxDifficulty));
    const next = Math.min(Math.max(Math.round(current * factor), this.config.minDifficulty), ceiling);
    if (next === current) return null;
    this.difficulty = next;
    return next;
  }
}
