import { useState } from "react";
import { usePolled } from "../api.js";
import RewardsChart from "../components/RewardsChart.jsx";
import RewardsSummary from "../components/RewardsSummary.jsx";
import { BlocksTable, Card, Segmented } from "../components/ui.jsx";
import { formatEffort, formatInteger, formatTime } from "../format.js";

// The table's status filter: everything, or one kind of block (orphaned and rejected together: neither is paid).
const FILTERS = /** @type {const} */ ([["all", "All"], ["main-chain", "Main chain"], ["side", "Side"], ["submitted", "Pending"], ["lost", "Orphaned"]]);
/** @typedef {typeof FILTERS[number][0]} Filter */

/** @param {{ status: string }} block @param {Filter} filter */
function matches(block, filter) {
  if (filter === "all") return true;
  if (filter === "lost") return block.status === "orphaned" || block.status === "rejected";
  return block.status === filter;
}

/**
 * The effort of the rounds that found the last blocks, oldest first: under the 100% line came quicker than average, over it took
 * longer. Each bar's height and title carry its value; the table below lists the same efforts.
 * @param {{ blocks: { hash: string, height: string, effort: number | null, foundAt: string }[] }} props
 */
function EffortBars({ blocks }) {
  const shown = blocks.filter((b) => b.effort !== null && b.effort !== undefined).slice(0, 12).reverse();
  if (shown.length === 0) return <p className="text-sm text-muted">The effort of each round appears once blocks are found while shares are tracked.</p>;
  // The scale reaches at least 200%, so the 100% line sits in the middle or lower.
  const top = Math.max(2, ...shown.map((b) => /** @type {number} */ (b.effort)));
  const line = (1 / top) * 100;
  return (
    <div className="relative h-44" role="img"
      aria-label={`Effort of the last ${shown.length} blocks, oldest first: ${shown.map((b) => formatEffort(/** @type {number} */ (b.effort))).join(", ")}`}>
      <div className="absolute inset-x-0 border-t border-dashed border-ink-2" style={{ bottom: `${line}%` }} aria-hidden="true" />
      <span className="label absolute -top-0.5 right-0 bg-panel pl-1" style={{ bottom: `calc(${line}% + 2px)`, top: "auto" }} aria-hidden="true">100%</span>
      <div className="absolute inset-0 flex items-end gap-1.5" aria-hidden="true">
        {shown.map((b, i) => {
          const effort = /** @type {number} */ (b.effort);
          return (
            <div key={b.hash} className={`chart-grow flex-1 rounded-t-[4px] ${effort <= 1 ? "bg-accent" : "bg-gold"}`}
              style={/** @type {React.CSSProperties} */ ({ height: `${Math.max(2, (effort / top) * 100)}%`, "--i": i })}
              title={`Block ${formatInteger(b.height)}: ${formatEffort(effort)} · ${formatTime(b.foundAt)}`} />
          );
        })}
      </div>
    </div>
  );
}

/** Every block found here: what they are worth, how lucky the rounds were, and the list. */
export default function Blocks() {
  const blocks = usePolled("/api/v1/blocks?limit=200");
  const overview = usePolled("/api/v1/overview");
  const rewards = usePolled("/api/v1/rewards?range=30d");
  const [filter, setFilter] = useState(/** @type {Filter} */ ("all"));

  const list = /** @type {any[]} */ (blocks.data?.blocks ?? []);
  // Luck over the last 7 and 30 days, from the daily history: blocks found per block expected.
  const days = /** @type {{ blocks: number, expectedBlocks: number }[]} */ (rewards.data?.points ?? []);
  const luckOver = (/** @type {number} */ n) => {
    const recent = days.slice(-n);
    const expected = recent.reduce((sum, d) => sum + d.expectedBlocks, 0);
    return expected > 0 ? recent.reduce((sum, d) => sum + d.blocks, 0) / expected : null;
  };
  // Orphan rate over all blocks found: orphaned out of every block that reached a final state.
  const rows = /** @type {{ status: string, count: string }[]} */ (overview.data?.blocks ?? []);
  const count = (/** @type {string} */ status) => Number(rows.find((r) => r.status === status)?.count ?? 0);
  const settled = count("main-chain") + count("side") + count("orphaned");
  const found = rows.reduce((sum, r) => sum + (r.status === "rejected" ? 0 : Number(r.count)), 0);
  const shownBlocks = list.filter((b) => matches(b, filter));

  return (
    <div className="flex flex-col gap-5">
      <div className="page-head">
        <div><h1>Blocks</h1><p>Every block found here. Rewards go straight to the finder's address.</p></div>
        <a href="/api/v1/blocks.csv" download className="btn">Download CSV</a>
      </div>

      <RewardsSummary totals={blocks.data?.totals} />

      <div className="split">
        <section className="card pad main">
          <div className="mb-4 flex flex-wrap items-start justify-between gap-2">
            <div>
              <h2 className="text-base font-semibold text-ink">Effort per block</h2>
              <div className="label">Below the line was lucky, above it took longer than average.</div>
            </div>
            <span className="label mono">last {Math.min(12, list.filter((b) => b.effort !== null && b.effort !== undefined).length)} blocks</span>
          </div>
          <EffortBars blocks={list} />
          <div className="label mt-3 flex flex-wrap gap-x-4 gap-y-1">
            <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm bg-accent" aria-hidden="true" />100% or less: quicker than average</span>
            <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm bg-gold" aria-hidden="true" />Over 100%: took longer</span>
          </div>
        </section>
        <section className="card pad side">
          <h2 className="mb-4 text-base font-semibold text-ink">Luck</h2>
          <div className="grid grid-cols-2 gap-4">
            <div><div className="label">7 days</div><div className="mono mt-1 text-xl font-medium text-ink">{luckOver(7) === null ? "—" : formatEffort(/** @type {number} */ (luckOver(7)))}</div></div>
            <div><div className="label">30 days</div><div className="mono mt-1 text-xl font-medium text-ink">{luckOver(30) === null ? "—" : formatEffort(/** @type {number} */ (luckOver(30)))}</div></div>
            <div><div className="label">Blocks found</div><div className="mono mt-1 text-xl font-medium text-ink">{formatInteger(found)}</div></div>
            <div>
              <div className="label">Orphan rate</div>
              <div className="mono mt-1 text-xl font-medium text-ink" title={`${formatInteger(count("orphaned"))} orphaned of ${formatInteger(settled)} final`}>
                {settled > 0 ? formatEffort(count("orphaned") / settled) : "—"}
              </div>
            </div>
          </div>
          <div className="label mt-4">Luck is blocks found per block expected from the work done; 100% is exactly average.</div>
        </section>
      </div>

      <Card title="Rewards over time" subtitle="Running total found, against what the work done should have found">
        <RewardsChart rewardPerBlock={Number(overview.data?.node?.miner_reward) || null} />
      </Card>

      <Card title="All blocks" subtitle="Most recent 200; the CSV has them all."
        action={<Segmented label="Show" value={filter} options={FILTERS} onChange={setFilter} />}>
        {blocks.data && (shownBlocks.length > 0 || filter === "all"
          ? <BlocksTable blocks={shownBlocks} />
          : <p className="text-sm text-muted">No blocks of this kind among the most recent 200.</p>)}
      </Card>
    </div>
  );
}
