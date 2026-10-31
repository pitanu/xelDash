import { useState } from "react";
import { usePolled } from "../api.js";
import { EarningsText, dailyEarnings } from "../components/Earnings.jsx";
import HashrateChart from "../components/HashrateChart.jsx";
import ActivityCard from "../components/ActivityCard.jsx";
import BlockCalendar from "../components/BlockCalendar.jsx";
import PowerCard from "../components/PowerCard.jsx";
import { BestShareCard } from "../components/BestShareChart.jsx";
import SharesChart from "../components/SharesChart.jsx";
import LuckCard from "../components/LuckCard.jsx";
import RewardsChart from "../components/RewardsChart.jsx";
import RewardsSummary from "../components/RewardsSummary.jsx";
import { BlocksTable, Card, StatTile } from "../components/ui.jsx";
import WorkersCard from "../components/WorkersCard.jsx";
import { formatAgo, formatHashrate, formatInteger, formatBucket } from "../format.js";

/** Blocks a day as a readable rate: "1.6 blocks a day", or "1 block every 4 days". @param {number} blocks */
function formatBlocksPerDay(blocks) {
  if (blocks >= 1) return `${blocks.toLocaleString(undefined, { maximumFractionDigits: 1 })} blocks a day`;
  const days = 1 / blocks;
  return `1 block every ${days.toLocaleString(undefined, { maximumFractionDigits: days < 10 ? 1 : 0 })} days`;
}

/**
 * One miner address: hashrate, earnings, luck, workers and blocks. `back` shows the link
 * to the Miners tab (not when this page is the Miners tab itself).
 * @param {{ address: string, back?: boolean }} props
 */
export default function Miner({ address, back = true }) {
  const [range, setRange] = useState("24h");
  const encoded = encodeURIComponent(address);
  const miner = usePolled(`/api/v1/miners/${encoded}`);
  const history = usePolled(`/api/v1/hashrate?range=${range}&address=${encoded}`);
  const blocks = usePolled(`/api/v1/blocks?limit=50&address=${encoded}`);
  // Network difficulty and the current block reward, for the earnings estimate.
  const overview = usePolled("/api/v1/overview");

  if (miner.error && !miner.data) {
    return <p className="text-sm text-ink-2">No miner with address <span className="break-all text-ink">{address}</span> has connected.</p>;
  }
  const m = miner.data;
  // With worker names kept private (a public server's choice), the server sends the totals instead of the list.
  const hidden = m?.workersHidden ? m.workerTotals : null;
  const hashrate5m = hidden ? Number(hidden.hashrate5m) : m?.workers.reduce((/** @type {number} */ sum, /** @type {{ hashrate5m: string }} */ w) => sum + Number(w.hashrate5m), 0);
  const hashrate1h = hidden ? Number(hidden.hashrate1h) : m?.workers.reduce((/** @type {number} */ sum, /** @type {{ hashrate1h: string }} */ w) => sum + Number(w.hashrate1h), 0);
  const blockList = blocks.data?.blocks ?? [];
  const expectedBlocks = hashrate1h && overview.data?.node?.miner_reward
    ? dailyEarnings(hashrate1h, overview.data.network.difficulty, overview.data.node.miner_reward).blocks : null;

  return (
    <div className="flex flex-col gap-5">
      <div className="page-head">
        <div className="min-w-0">
          {back && <a href="#/miners" className="text-[13px]">← Miners</a>}
          <h1 className="mono mt-1 break-all text-[22px]!">{address}</h1>
          {m && <p>First seen {formatAgo(m.firstSeen)} · last seen {formatAgo(m.lastSeen)}</p>}
        </div>
      </div>
      <div className="tiles">
        <div className="col-span-2">
          <StatTile hero icon="hashrate" label="Hashrate, last hour" value={formatHashrate(hashrate1h)} detail={`Last 5 min: ${formatHashrate(hashrate5m)}`} />
        </div>
        {/* The number alone in the tile (a phrase would not fit at tile size); the phrase and the XEL go underneath. */}
        <StatTile icon="clock" label="Expected blocks a day"
          value={expectedBlocks !== null ? expectedBlocks.toLocaleString(undefined, { maximumFractionDigits: expectedBlocks < 1 ? 2 : 1 }) : "—"}
          detail={overview.data && expectedBlocks !== null
            ? <>{formatBlocksPerDay(expectedBlocks)} · <EarningsText hashrate={hashrate1h} difficulty={overview.data.network.difficulty} minerReward={overview.data.node.miner_reward} /></>
            : undefined} />
        <StatTile icon="block" label="Blocks found" value={formatInteger(blockList.filter((/** @type {{ status: string }} */ b) => b.status !== "rejected").length)}
          detail={`${blockList.filter((/** @type {{ status: string }} */ b) => b.status === "main-chain").length} main chain`} />
      </div>

      <RewardsSummary totals={blocks.data?.totals} />
      <Card title="Rewards over time" subtitle="Running total found, against what the work done should have found">
        <RewardsChart address={address} rewardPerBlock={Number(overview.data?.node?.miner_reward) || null} />
      </Card>

      <LuckCard luck={m?.luck} />

      <Card title="Hashrate" subtitle={history.data ? `${formatBucket(history.data.bucketSeconds)} buckets` : undefined}>
        <HashrateChart points={history.data?.points ?? null} dimmed={history.loading} range={range} onRangeChange={setRange} />
      </Card>

      <Card title="Shares" subtitle="Accepted, stale and invalid shares per bucket, for the range chosen above">
        <SharesChart points={history.data?.points ?? null} dimmed={history.loading} />
      </Card>

      <ActivityCard address={address} />
      <BlockCalendar address={address} />
      <PowerCard address={address} />

      <BestShareCard best={m?.bestShare} points={history.data?.points ?? null} dimmed={history.loading} />

      <WorkersCard address={address} workers={m?.workers} onChanged={miner.reload} hidden={hidden} />
      <Card title="Blocks"
        action={<a href={`/api/v1/blocks.csv?address=${encoded}`} download className="inline-flex min-h-6 items-center text-xs text-ink-2 underline decoration-line underline-offset-2 hover:text-ink">Download all as CSV</a>}>{blocks.data && <BlocksTable blocks={blockList} showMiner={false} />}</Card>
    </div>
  );
}
