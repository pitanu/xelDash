import { useState } from "react";
import { usePolled } from "../api.js";
import HashrateChart from "../components/HashrateChart.jsx";
import { BlocksTable, Card, Segmented, StatTile, WorkersTable } from "../components/ui.jsx";
import { formatAgo, formatHashrate, formatInteger } from "../format.js";

/** @param {{ address: string }} props */
export default function Miner({ address }) {
  const [range, setRange] = useState("24h");
  const encoded = encodeURIComponent(address);
  const miner = usePolled(`/api/v1/miners/${encoded}`);
  const history = usePolled(`/api/v1/hashrate?range=${range}&address=${encoded}`);
  const blocks = usePolled(`/api/v1/blocks?limit=50&address=${encoded}`);

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
          <StatTile hero label="Hashrate, last hour" value={formatHashrate(hashrate1h)} detail={`Last 5 min: ${formatHashrate(hashrate5m)}`} />
        </div>
        <StatTile label="Workers" value={formatInteger(m?.workers.length)} />
        <StatTile label="Blocks found" value={formatInteger(blockList.filter((b) => b.status !== "rejected").length)}
          detail={`${blockList.filter((b) => b.status === "main-chain").length} main chain`} />
      </div>

      <div className="flex items-center gap-3">
        <span className="text-xs text-ink-2">Chart range</span>
        <Segmented label="Chart range" value={range} options={["6h", "24h", "7d"]} onChange={setRange} />
      </div>
      <Card title="Hashrate" subtitle={history.data ? `${history.data.bucketSeconds / 60}-minute buckets` : undefined}>
        {history.data ? <HashrateChart points={history.data.points} dimmed={history.loading} /> : <div className="h-[220px]" />}
      </Card>

      <Card title="Workers">{m && <WorkersTable workers={m.workers} address={address} />}</Card>
      <Card title="Blocks">{blocks.data && <BlocksTable blocks={blockList} showMiner={false} />}</Card>
    </div>
  );
}
