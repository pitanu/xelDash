// Cost and profit of a rig's mining from its on-time (activity.js on the API): energy is its power draw over the time it was on, the
// reward is what its work was expected to find (blocks expected × the reward per block), so luck does not move the figure.

const ATOMIC_PER_XEL = 1e8;

/**
 * @param {{ onMinutes: number, expectedBlocks: number, watts: number, pricePerKwh: number | null,
 *   rewardAtomic: number | null, xelPrice: number | null }} input
 *   rewardAtomic: the miner's reward per block now (atomic units); xelPrice: one XEL in the electricity's currency, or null
 */
export function powerFigures({ onMinutes, expectedBlocks, watts, pricePerKwh, rewardAtomic, xelPrice }) {
  const hours = onMinutes / 60;
  const kwh = (watts * hours) / 1000;
  const cost = pricePerKwh === null ? null : kwh * pricePerKwh;
  const rewardXel = rewardAtomic === null ? null : (expectedBlocks * rewardAtomic) / ATOMIC_PER_XEL;
  const value = rewardXel === null || xelPrice === null ? null : rewardXel * xelPrice;
  const profit = value === null || cost === null ? null : value - cost;
  return {
    kwh,
    cost,
    rewardXel,
    value,
    profit,
    /** The same per hour it was on: comparable between rigs and ranges. */
    perHour: hours > 0 ? { cost: cost === null ? null : cost / hours, profit: profit === null ? null : profit / hours } : null,
    /** The XEL price at which the reward pays for the power; null without a cost or a reward. */
    breakEvenPrice: cost !== null && rewardXel ? cost / rewardXel : null,
  };
}
