import { useState } from "react";
import { usePolled } from "../api.js";
import HashrateChart from "../components/HashrateChart.jsx";
import { BlocksTable, Card, EventsList, MinersTable, Segmented, StatTile } from "../components/ui.jsx";
import { formatCompact, formatDuration, formatHashrate, formatInteger } from "../format.js";

/** @param {{ status: string, count: string }[]} rows @param {string} status */
function countOf(rows, status) {
  return Number(rows.find((r) => r.status === status)?.count ?? 0);
}

export default function Overview() {
  const [range, setRange] = useState("24h");
  const overview = usePolled("/api/v1/overview");
  const history = usePolled(`/api/v1/hashrate?range=${range}`);
  const miners = usePolled("/api/v1/miners");
  const blocks = usePolled("/api/v1/blocks?limit=10");
  const events = usePolled("/api/v1/events?limit=10");

  const o = overview.data;
  const blockRows = o?.blocks ?? [];
  const found = blockRows.reduce((sum, r) => sum + (r.status === "rejected" ? 0 : Number(r.count)), 0);

  return (
    <div className="space-y-6">
      {overview.error && !o && <p className="text-sm text-critical">Unable to reach the xelDash API.</p>}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <div className="col-span-2">
          <StatTile hero label="Hashrate, last hour" value={formatHashrate(o?.miningEstimates?.["1h"]?.estimatedHashesPerSecond)}
            detail={`Last 5 min: ${formatHashrate(o?.miningEstimates?.["5m"]?.estimatedHashesPerSecond)}`} />
        </div>
        <StatTile label="Expected time to block" value={formatDuration(o?.miningEstimates?.["1h"]?.expectedTimeToBlockSeconds)}
          detail="At last hour's hashrate" />
        <StatTile label="Blocks found" value={formatInteger(found)}
          detail={o ? `${countOf(blockRows, "main-chain")} main chain · ${countOf(blockRows, "submitted")} pending` : undefined} />
        <StatTile label="Network difficulty" value={formatCompact(o?.network?.difficulty)}
          detail={o?.network?.hashrate ? `Network ${formatHashrate(o.network.hashrate)}` : undefined} />
        <StatTile label="Active workers" value={formatInteger(o?.miners?.active_workers)}
          detail={o ? `${formatInteger(o.miners.active_miners)} miner addresses` : undefined} />
        <StatTile label="Shares, last hour" value={formatInteger(o?.shares?.accepted_1h)}
          detail={o ? `${formatInteger(o.shares.rejected_1h)} rejected` : undefined} />
        <StatTile label="Node height" value={formatInteger(o?.node?.height)}
          detail={o ? `${o.node.network} · ${o.node.version}` : undefined} />
      </div>

      <div className="flex items-center gap-3">
        <span className="text-xs text-ink-2">Chart range</span>
        <Segmented label="Chart range" value={range} options={["6h", "24h", "7d"]} onChange={setRange} />
      </div>
      <Card title="Hashrate" subtitle={history.data ? `Accepted share difficulty per second, ${history.data.bucketSeconds / 60}-minute buckets` : undefined}>
        {history.data ? <HashrateChart points={history.data.points} dimmed={history.loading} /> : <div className="h-[220px]" />}
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Miners">{miners.data && <MinersTable miners={miners.data.miners} />}</Card>
        <Card title="Recent blocks" action={<a href="#/blocks" className="text-xs text-ink-2 hover:text-ink hover:underline">All blocks</a>}>
          {blocks.data && <BlocksTable blocks={blocks.data.blocks} />}
        </Card>
      </div>

      <Card title="Recent events">{events.data && <EventsList events={events.data.events} />}</Card>
    </div>
  );
}
