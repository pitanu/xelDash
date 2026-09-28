import { formatAgo, formatEffort, formatTime } from "../format.js";
import { Card } from "./ui.jsx";

/** @param {number} value */
function formatBlocks(value) {
  if (value > 0 && value < 1) return value.toLocaleString(undefined, { maximumSignificantDigits: 2 });
  return value.toLocaleString(undefined, { maximumFractionDigits: value < 10 ? 2 : 1 });
}

/**
 * Round effort and luck. Effort is the work done since the last block as a share of the work
 * expected per block; luck is blocks found per block expected. Both come from accepted shares
 * weighed against the network difficulty at the time.
 * @param {{ luck: { trackedSince: string | null, expectedBlocks: number, blocksFound: number, luck: number | null,
 *   round: { startedAt: string | null, effort: number | null } } | undefined }} props
 */
export default function LuckCard({ luck }) {
  if (!luck) return null;
  if (!luck.trackedSince) {
    return (
      <Card title="Luck" subtitle="Round effort and luck appear once shares arrive.">
        <p className="text-sm text-muted">No shares tracked yet.</p>
      </Card>
    );
  }
  const effort = luck.round.effort ?? 0;
  // The bar spans at least 200%, so 100% (the average round) sits in the middle.
  const span = Math.max(2, Math.ceil(effort));
  const fill = Math.min(100, (effort / span) * 100);
  const chance = 1 - Math.exp(-effort);
  return (
    <Card title="Luck"
      subtitle={`Tracked since ${formatTime(luck.trackedSince)}. Effort is the work done as a share of the work expected per block.`}>
      <div className="grid gap-6 md:grid-cols-[1fr_16rem]">
        <div>
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <span className="text-xs text-ink-2">Current round effort</span>
            {luck.round.startedAt && (
              <span className="text-xs text-muted" title={formatTime(luck.round.startedAt)}>
                round started {formatAgo(luck.round.startedAt)}
              </span>
            )}
          </div>
          <div className="mt-1 text-2xl font-semibold tracking-tight text-ink">{formatEffort(effort)}</div>
          <div className="relative mt-3 h-2 rounded-full bg-series-1/15" role="meter" aria-label="Current round effort"
            aria-valuemin={0} aria-valuemax={span * 100} aria-valuenow={Math.round(effort * 100)}>
            <div className="h-full rounded-full bg-series-1" style={{ width: `${fill}%` }} />
            <div className="absolute -top-1 h-4 w-px bg-ink-2" style={{ left: `${100 / span}%` }} aria-hidden="true" />
          </div>
          <div className="relative mt-1 h-4 text-xs text-muted">
            <span className="absolute left-0">0%</span>
            <span className="absolute -translate-x-1/2" style={{ left: `${100 / span}%` }}>100% (average)</span>
            <span className="absolute right-0">{span * 100}%</span>
          </div>
          <p className="mt-3 text-xs text-ink-2">
            With this much work, a block would have been found {chance < 0.01 ? "under 1%" : `${Math.round(chance * 100)}%`} of the time. Over 100% means an
            unlucky round so far, not a fault: each hash has the same chance.
          </p>
        </div>
        <div className="space-y-3 md:border-l md:border-line md:pl-6">
          <div>
            <div className="text-xs text-ink-2">Luck</div>
            <div className="mt-1 text-2xl font-semibold tracking-tight text-ink">
              {luck.luck === null ? "—" : luck.blocksFound === 0 ? "No blocks yet" : formatEffort(luck.luck)}
            </div>
            <div className="text-xs text-muted">
              {formatBlocks(luck.blocksFound)} found of {formatBlocks(luck.expectedBlocks)} expected
            </div>
          </div>
          <p className="text-xs text-muted">
            100% is exactly average. With few blocks, luck swings widely; it settles as blocks add up.
          </p>
        </div>
      </div>
    </Card>
  );
}
