import { useState } from "react";
import { usePolled } from "../api.js";
import HashrateChart from "../components/HashrateChart.jsx";
import ActivityCard from "../components/ActivityCard.jsx";
import BlockCalendar from "../components/BlockCalendar.jsx";
import PowerCard from "../components/PowerCard.jsx";
import { BestShareCard } from "../components/BestShareChart.jsx";
import SharesChart from "../components/SharesChart.jsx";
import RewardsSummary from "../components/RewardsSummary.jsx";
import { BlocksTable, Card, StatTile } from "../components/ui.jsx";
import { formatAgo, formatHashrate, formatInteger, shorten, formatBucket } from "../format.js";

const REJECT_LABELS = {
  low_difficulty: "Below share target",
  duplicate: "Duplicate share",
  stale: "Stale (arrived after a new block)",
};

/** @param {{ address: string, name: string }} props */
export default function Worker({ address, name }) {
  const [range, setRange] = useState("24h");
  const a = encodeURIComponent(address);
  const n = encodeURIComponent(name);
  const worker = usePolled(`/api/v1/miners/${a}/workers/${n}`);
  const history = usePolled(`/api/v1/hashrate?range=${range}&address=${a}&worker=${n}`);
  const blocks = usePolled(`/api/v1/blocks?limit=50&address=${a}&worker=${n}`);

  if (worker.error && !worker.data) {
    return <p className="text-sm text-ink-2">No worker named <span className="text-ink">{name}</span> for this address.</p>;
  }
  const w = worker.data;
  const rejectRate = w && Number(w.shares.accepted24h) + Number(w.shares.rejected24h) > 0
    ? (Number(w.shares.rejected24h) / (Number(w.shares.accepted24h) + Number(w.shares.rejected24h))) * 100
    : null;

  return (
    <div className="flex flex-col gap-5">
      <div className="page-head">
        <div className="min-w-0">
          <a href={`#/miner/${address}`} className="mono text-[13px]" title={address}>← {shorten(address, 10)}</a>
          <h1 className="mt-1 break-all">{name}</h1>
          {w && (
            <p>
              First seen {formatAgo(w.firstSeen)} · last seen {formatAgo(w.lastSeen)}
              {w.lastIp && <> · <span className="mono">{w.lastIp}</span></>}
            </p>
          )}
        </div>
      </div>

      <div className="tiles">
        <div className="col-span-2">
          <StatTile hero icon="hashrate" label="Hashrate, last hour" value={formatHashrate(w?.hashrate["1h"])}
            detail={w ? `Last 5 min: ${formatHashrate(w.hashrate["5m"])} · 24 h average: ${formatHashrate(w.hashrate["24h"])}`
              + (w.reportedHashrate !== null ? ` · miner reports ${formatHashrate(w.reportedHashrate)}` : "") : undefined} />
        </div>
        <StatTile icon="shares" label="Accepted shares, 24 h" value={formatInteger(w?.shares.accepted24h)}
          detail={w ? `${formatInteger(w.shares.accepted1h)} in the last hour` : undefined} />
        <StatTile icon="rejected" label="Rejected shares, 24 h" value={formatInteger(w?.shares.rejected24h)}
          detail={rejectRate === null ? "No shares yet" : `${rejectRate.toFixed(1)}% of submissions`} />
      </div>

      <RewardsSummary totals={blocks.data?.totals} />

      <Card title="Hashrate" subtitle={history.data ? `${formatBucket(history.data.bucketSeconds)} buckets` : undefined}>
        <HashrateChart points={history.data?.points ?? null} dimmed={history.loading} range={range} onRangeChange={setRange} />
      </Card>

      <Card title="Shares" subtitle="Accepted, stale and invalid shares per bucket, for the range chosen above">
        <SharesChart points={history.data?.points ?? null} dimmed={history.loading} />
      </Card>

      <ActivityCard address={address} worker={name} />
      <BlockCalendar address={address} worker={name} />
      <PowerCard address={address} worker={name} />

      <BestShareCard best={w?.bestShare} points={history.data?.points ?? null} dimmed={history.loading} />

      <div className="grid gap-5 lg:grid-cols-2">
        <Card title="Rejected shares by reason" subtitle="Last 24 hours">
          {w && (w.rejectReasons24h.length === 0
            ? <p className="text-sm text-muted">No rejected shares.</p>
            : (
              <ul className="row-list">
                {w.rejectReasons24h.map((/** @type {{ reason: string | null, count: string }} */ r) => (
                  <li key={r.reason ?? "unknown"} className="justify-between">
                    <span className="text-ink-2">{REJECT_LABELS[/** @type {keyof typeof REJECT_LABELS} */ (r.reason)] ?? r.reason ?? "Unknown"}</span>
                    <span className="mono text-ink">{formatInteger(r.count)}</span>
                  </li>
                ))}
              </ul>
            ))}
        </Card>
        <Card title="Blocks">{blocks.data && <BlocksTable blocks={blocks.data.blocks} showMiner={false} />}</Card>
      </div>
    </div>
  );
}
