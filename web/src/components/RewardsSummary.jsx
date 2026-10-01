import { formatInteger, formatXel } from "../format.js";
import { formatMoney, usePrice } from "../price.js";
import { StatTile } from "./ui.jsx";

/**
 * What the blocks found are worth: the total paid so far (main-chain and side blocks), how many
 * of each, and how many are still waiting to become final.
 * @param {{ totals: { reward: string, byStatus: Record<string, { blocks: number, reward: string }> } | undefined }} props
 */
export default function RewardsSummary({ totals }) {
  const { price } = usePrice();
  if (!totals) return null;
  const count = (/** @type {string} */ status) => totals.byStatus[status]?.blocks ?? 0;
  const xel = Number(totals.reward) / 1e8;
  return (
    <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
      <StatTile icon="block" label="Rewards found" value={<span className="whitespace-nowrap text-xl sm:text-2xl">{formatXel(totals.reward).replace(/ XEL$/, "")}<span className="ml-1 text-sm font-medium text-ink-2">XEL</span></span>}
        detail={price && xel > 0 ? `≈ ${formatMoney(xel * price.price, price.currency, "amount")} at today's price` : "Main-chain and side blocks"} />
      <StatTile label="Main chain" value={formatInteger(count("main-chain"))} detail={formatXel(totals.byStatus["main-chain"]?.reward ?? "0")} />
      <StatTile label="Side blocks" value={formatInteger(count("side"))} detail={count("side") > 0 ? `${formatXel(totals.byStatus.side?.reward ?? "0")} (reduced reward)` : "Paid at a reduced reward"} />
      <StatTile label="Waiting to be final" value={formatInteger(count("submitted"))} detail={count("orphaned") > 0 ? `${count("orphaned")} orphaned, no reward` : "Reward known once final"} />
    </div>
  );
}
