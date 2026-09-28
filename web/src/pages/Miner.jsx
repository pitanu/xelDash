import { useState } from "react";
import { usePolled } from "../api.js";
import { EarningsText, dailyEarnings } from "../components/Earnings.jsx";
import HashrateChart from "../components/HashrateChart.jsx";
import LuckCard from "../components/LuckCard.jsx";
import { BlocksTable, Card, StatTile, WorkersTable } from "../components/ui.jsx";
import { formatAgo, formatHashrate, formatInteger, formatBucket } from "../format.js";

/** @param {{ address: string }} props */
/** Blocks a day as a readable rate: "1.6 blocks a day", or "1 block every 4 days". @param {number} blocks */
function formatBlocksPerDay(blocks) {
  if (blocks >= 1) return `${blocks.toLocaleString(undefined, { maximumFractionDigits: 1 })} blocks a day`;
  const days = 1 / blocks;
  return `1 block every ${days.toLocaleString(undefined, { maximumFractionDigits: days < 10 ? 1 : 0 })} days`;
}

export default function Miner({ address }) {
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
  const hashrate5m = m?.workers.reduce((sum, w) => sum + Number(w.hashrate5m), 0);
  const hashrate1h = m?.workers.reduce((sum, w) => sum + Number(w.hashrate1h), 0);
  const blockList = blocks.data?.blocks ?? [];

  return (
    <div className="space-y-6">
      <div>
        <a href="#/" className="text-xs text-ink-2 hover:text-ink hover:underline">← Overview</a>
        <h1 className="mt-1 break-all text-lg font-semibold text-ink">{address}</h1>
        {m && <p className="text-xs text-muted">First seen {formatAgo(m.firstSeen)} · last seen {formatAgo(m.lastSeen)}</p>}
      </div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <div className="col-span-2">
          <StatTile hero icon="hashrate" label="Hashrate, last hour" value={formatHashrate(hashrate1h)} detail={`Last 5 min: ${formatHashrate(hashrate5m)}`} />
        </div>
        <StatTile icon="clock" label="Expected earnings"
          value={hashrate1h && overview.data?.node?.miner_reward
            ? `${formatBlocksPerDay(dailyEarnings(hashrate1h, overview.data.network.difficulty, overview.data.node.miner_reward).blocks)}`
            : "—"}
          detail={overview.data && <EarningsText hashrate={hashrate1h} difficulty={overview.data.network.difficulty} minerReward={overview.data.node.miner_reward} />} />
        <StatTile icon="block" label="Blocks found" value={formatInteger(blockList.filter((b) => b.status !== "rejected").length)}
          detail={`${blockList.filter((b) => b.status === "main-chain").length} main chain`} />
      </div>

      <LuckCard luck={m?.luck} />

      <Card title="Hashrate" subtitle={history.data ? `${formatBucket(history.data.bucketSeconds)} buckets` : undefined}>
        <HashrateChart points={history.data?.points ?? null} dimmed={history.loading} range={range} onRangeChange={setRange} />
      </Card>

      <Card title="Workers">{m && <WorkersTable workers={m.workers} address={address} />}</Card>
      <Card title="Blocks">{blocks.data && <BlocksTable blocks={blockList} showMiner={false} />}</Card>
    </div>
  );
}
