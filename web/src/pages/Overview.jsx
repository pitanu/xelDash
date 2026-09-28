import { useState } from "react";
import { usePolled } from "../api.js";
import { EarningsText } from "../components/Earnings.jsx";
import HashrateChart from "../components/HashrateChart.jsx";
import LuckCard from "../components/LuckCard.jsx";
import { BlocksTable, Card, EventsList, HealthBadge, MinersTable, StatTile } from "../components/ui.jsx";
import { formatCompact, formatDuration, formatHashrate, formatInteger, formatBucket } from "../format.js";

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
  const status = usePolled("/api/v1/status");

  const o = overview.data;
  const blockRows = o?.blocks ?? [];
  const found = blockRows.reduce((sum, r) => sum + (r.status === "rejected" ? 0 : Number(r.count)), 0);
  const stratum = status.data?.services.stratum;
  // Whether miners get work right now, from the Health page's source.
  const miningBadge = !stratum ? null
    : stratum.paused ? <HealthBadge level="warning" label={stratum.paused === "syncing" ? "Paused: node syncing" : "Paused: node down"} />
      : stratum.ok ? <HealthBadge level="good" label={stratum.node ? `Mining via ${stratum.node}` : "Mining"} />
        : <HealthBadge level="critical" label="Stratum down" />;

  return (
    <div className="space-y-6">
      {overview.error && !o && <p className="text-sm text-critical">Unable to reach the xelDash API.</p>}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <div className="col-span-2">
          <StatTile hero icon="hashrate" aside={miningBadge} label="Hashrate, last hour" value={formatHashrate(o?.miningEstimates?.["1h"]?.estimatedHashesPerSecond)}
            detail={`Last 5 min: ${formatHashrate(o?.miningEstimates?.["5m"]?.estimatedHashesPerSecond)}`} />
        </div>
        <StatTile icon="clock" label="Expected time to block" value={formatDuration(o?.miningEstimates?.["1h"]?.expectedTimeToBlockSeconds)}
          detail={<>At last hour's hashrate{o?.node?.miner_reward ? <>{" · "}<EarningsText hashrate={Number(o.miningEstimates["1h"].estimatedHashesPerSecond)}
            difficulty={o.network.difficulty} minerReward={o.node.miner_reward} /></> : null}</>} />
        <StatTile icon="block" label="Blocks found" value={formatInteger(found)}
          detail={o ? `${countOf(blockRows, "main-chain")} main chain · ${countOf(blockRows, "submitted")} pending` : undefined} />
        <StatTile icon="difficulty" label="Network difficulty" value={formatCompact(o?.network?.difficulty)}
          detail={o?.network?.hashrate ? `Network ${formatHashrate(o.network.hashrate)}` : undefined} />
        <StatTile icon="workers" label="Active workers" value={formatInteger(o?.miners?.active_workers)}
          detail={o ? `${formatInteger(o.miners.active_miners)} miner addresses` : undefined} />
        <StatTile icon="shares" label="Shares, last hour" value={formatInteger(o?.shares?.accepted_1h)}
          detail={o ? `${formatInteger(o.shares.rejected_1h)} rejected` : undefined} />
        <StatTile icon="height" label="Node height" value={formatInteger(o?.node?.height)}
          detail={o ? `${o.node.network} · ${o.node.version}` : undefined} />
      </div>

      <LuckCard luck={o?.luck} />

      <Card title="Hashrate" subtitle={history.data ? `Accepted share difficulty per second, ${formatBucket(history.data.bucketSeconds)} buckets` : undefined}>
        <HashrateChart points={history.data?.points ?? null} dimmed={history.loading} range={range} onRangeChange={setRange} />
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
