import { useState } from "react";
import { usePolled } from "../api.js";
import HashrateChart from "../components/HashrateChart.jsx";
import { BlocksTable, Card, StatTile } from "../components/ui.jsx";
import { formatAgo, formatHashrate, formatInteger, shorten, formatBucket } from "../format.js";

const REJECT_LABELS = {
  low_difficulty: "Below share target",
  duplicate: "Duplicate share",
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
    <div className="space-y-6">
      <div>
        <a href={`#/miner/${address}`} className="text-xs text-ink-2 hover:text-ink hover:underline" title={address}>
          ← {shorten(address, 10)}
        </a>
        <h1 className="mt-1 break-all text-lg font-semibold text-ink">{name}</h1>
        {w && (
          <p className="text-xs text-muted">
            First seen {formatAgo(w.firstSeen)} · last seen {formatAgo(w.lastSeen)}
            {w.lastIp && <> · {w.lastIp}</>}
          </p>
        )}
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <div className="col-span-2">
          <StatTile hero icon="hashrate" label="Hashrate, last hour" value={formatHashrate(w?.hashrate["1h"])}
            detail={w ? `Last 5 min: ${formatHashrate(w.hashrate["5m"])} · 24 h: ${formatHashrate(w.hashrate["24h"])}`
              + (w.reportedHashrate !== null ? ` · miner reports ${formatHashrate(w.reportedHashrate)}` : "") : undefined} />
        </div>
        <StatTile icon="shares" label="Accepted shares, 24 h" value={formatInteger(w?.shares.accepted24h)}
          detail={w ? `${formatInteger(w.shares.accepted1h)} in the last hour` : undefined} />
        <StatTile icon="rejected" label="Rejected shares, 24 h" value={formatInteger(w?.shares.rejected24h)}
          detail={rejectRate === null ? "No shares yet" : `${rejectRate.toFixed(1)}% of submissions`} />
      </div>

      <Card title="Hashrate" subtitle={history.data ? `${formatBucket(history.data.bucketSeconds)} buckets` : undefined}>
        <HashrateChart points={history.data?.points ?? null} dimmed={history.loading} range={range} onRangeChange={setRange} />
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Rejected shares by reason" subtitle="Last 24 hours; stale shares are not stored">
          {w && (w.rejectReasons24h.length === 0
            ? <p className="text-sm text-muted">No rejected shares.</p>
            : (
              <ul className="divide-y divide-line text-sm">
                {w.rejectReasons24h.map((r) => (
                  <li key={r.reason ?? "unknown"} className="flex justify-between py-2">
                    <span className="text-ink-2">{REJECT_LABELS[/** @type {keyof typeof REJECT_LABELS} */ (r.reason)] ?? r.reason ?? "Unknown"}</span>
                    <span className="tabular text-ink">{formatInteger(r.count)}</span>
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
