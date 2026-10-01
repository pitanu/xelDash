import { useState } from "react";
import { usePolled } from "../api.js";
import { formatAgo, formatDuration } from "../format.js";
import { Card, Segmented } from "./ui.jsx";

const RANGES = ["24h", "7d", "30d"];

/** @param {number} percent */
function formatPercent(percent) {
  if (percent >= 99.995) return "100%";
  return `${percent.toFixed(percent >= 99 ? 2 : 1)}%`;
}

/**
 * How much of the time miners could be given work, and the pauses behind the rest. A pause is a
 * time when no node could issue work (syncing or not responding); switching to another node is not.
 */
export default function UptimeCard() {
  const [range, setRange] = useState("7d");
  const uptime = usePolled(`/api/v1/uptime?range=${range}`, { intervalMs: 30_000 });
  const u = uptime.data;
  return (
    <Card title="Mining availability"
      subtitle="The share of time your miners could be given work. Pauses are when no node was ready, so rigs sat idle."
      action={<Segmented label="Availability range" value={range} options={RANGES} onChange={setRange} />}>
      {!u ? (
        <p className="text-sm text-ink-2">Loading...</p>
      ) : (
        <div className="space-y-4">
          <div className="flex flex-wrap items-end gap-x-6 gap-y-2">
            <div>
              <div className="text-3xl font-semibold tracking-tight text-ink tabular">{formatPercent(u.uptimePercent)}</div>
              <div className="text-xs text-ink-2">available over {u.seconds >= 86_400 ? `${(u.seconds / 86_400).toFixed(u.seconds >= 10 * 86_400 ? 0 : 1)} days` : formatDuration(u.seconds)}</div>
            </div>
            <div className="text-sm text-ink-2">
              {u.pausedSeconds === 0 ? "No pauses." : `${formatDuration(u.pausedSeconds)} paused in total.`}
              {u.restarts > 0 && ` Mining server restarted ${u.restarts} time${u.restarts === 1 ? "" : "s"}.`}
              {u.paused && <strong className="ml-1 text-critical">Paused right now.</strong>}
            </div>
          </div>
          {u.pauses.length > 0 && (
            <ul className="divide-y divide-line text-sm">
              {u.pauses.map((/** @type {{ from: string, to: string | null, seconds: number, reason: string }} */ p) => (
                <li key={p.from} className="flex flex-wrap items-baseline justify-between gap-x-4 py-1.5">
                  <span className="text-ink">
                    {p.reason === "syncing" ? "A node was syncing" : "No node was responding"}
                    <span className="text-ink-2"> · {p.to ? formatDuration(p.seconds) : `${formatDuration(p.seconds)} and counting`}</span>
                  </span>
                  <span className="text-xs text-muted">{formatAgo(p.from)}</span>
                </li>
              ))}
            </ul>
          )}
          <p className="text-xs text-muted">
            Counted from {new Date(u.since).toLocaleString()}, when xelDash started recording. Short gaps while the mining
            server restarts are not counted.
          </p>
        </div>
      )}
    </Card>
  );
}
