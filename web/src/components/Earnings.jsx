import { XEL_DECIMALS } from "../format.js";
import { formatMoney, usePrice } from "../price.js";

/**
 * Expected blocks and XEL per day at a hashrate. XELIS difficulty is the expected number of
 * hashes per block, so blocks a day = hashrate × 86,400 / difficulty; each pays the current
 * miner reward. An average only: solo mining pays in whole blocks, at random times.
 * @param {number} hashrate @param {string | number} difficulty @param {number} minerRewardAtomic
 */
export function dailyEarnings(hashrate, difficulty, minerRewardAtomic) {
  const blocks = (hashrate * 86_400) / Number(difficulty);
  return { blocks, xel: (blocks * minerRewardAtomic) / 10 ** XEL_DECIMALS };
}

/** @param {number} value */
function formatAmount(value) {
  return value.toLocaleString(undefined, value < 1 ? { maximumSignificantDigits: 2 } : { maximumFractionDigits: 2 });
}

/**
 * "≈ 0.49 XEL a day (≈ $0.23)", with the money part when the price is switched on.
 * @param {{ hashrate: number | null | undefined, difficulty: string | undefined, minerReward: number | undefined }} props
 */
export function EarningsText({ hashrate, difficulty, minerReward }) {
  const { price } = usePrice();
  if (!hashrate || !difficulty || !minerReward) return null;
  const { xel } = dailyEarnings(hashrate, difficulty, minerReward);
  return (
    <>
      ≈ {formatAmount(xel)} XEL a day{price ? ` (≈ ${formatMoney(xel * price.price, price.currency, "amount")})` : ""}
    </>
  );
}
