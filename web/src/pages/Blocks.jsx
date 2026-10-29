import { useState } from "react";
import { usePolled } from "../api.js";
import EffortChart from "../components/EffortChart.jsx";
import RewardsChart from "../components/RewardsChart.jsx";
import RewardsSummary from "../components/RewardsSummary.jsx";
import { BlocksTable, Card, Segmented } from "../components/ui.jsx";
import { formatEffort, formatInteger } from "../format.js";

// The table's status filter: everything, or one kind of block (orphaned and rejected together: neither is paid).
const FILTERS = /** @type {const} */ ([["all", "All"], ["main-chain", "Main chain"], ["side", "Side"], ["submitted", "Pending"], ["lost", "Orphaned"]]);
/** @typedef {typeof FILTERS[number][0]} Filter */

/** @param {{ status: string }} block @param {Filter} filter */
function matches(block, filter) {
  if (filter === "all") return true;
  if (filter === "lost") return block.status === "orphaned" || block.status === "rejected";
  return block.status === filter;
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
          <EffortChart blocks={list} />
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
