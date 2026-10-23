import { useEffect, useRef, useState } from "react";
import { formatBestShare, formatTime } from "../format.js";
import { Card } from "./ui.jsx";

const HEIGHT = 220;
// Blocks are labelled beside their dot while there are this few in the range; with more, the legend and tooltip name them.
const MAX_BLOCK_LABELS = 6;
const PAD = { top: 16, right: 16, bottom: 28, left: 56 };

/** @param {React.RefObject<HTMLDivElement | null>} ref */
function useWidth(ref) {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    if (!ref.current) return undefined;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.floor(entry.contentRect.width)));
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}

/**
 * Powers of ten that span the values and always include 100% (a block), so the line a block reaches is always on the chart.
 * @param {number[]} values fractions of a block, all above zero
 */
export function bestShareScale(values) {
  const low = Math.min(0.001, ...values);
  const high = Math.max(1, ...values);
  const from = Math.floor(Math.log10(low));
  const to = Math.ceil(Math.log10(high));
  return { from, to, ticks: Array.from({ length: to - from + 1 }, (_, k) => 10 ** (from + k)) };
}

/**
 * The best share of each bucket, as a fraction of a block, on a logarithmic scale (a block is 1, a typical share far below it), with
 * the line a share must reach to be a block. One series: the card title names it, so there is no legend. Buckets without shares
 * have no dot. `points` is the hashrate history, which carries `best` per bucket.
 * @param {{ points: { time: string, best?: number | null }[] | null, dimmed?: boolean }} props
 */
export default function BestShareChart({ points: loaded, dimmed = false }) {
  const points = loaded ?? [];
  const frame = useRef(null);
  const width = useWidth(frame);
  const [active, setActive] = useState(/** @type {number | null} */ (null));
  const [showTable, setShowTable] = useState(false);

  const dots = points.flatMap((p, i) => (typeof p.best === "number" && p.best > 0 ? [{ i, time: p.time, best: p.best }] : []));
  const { from, to, ticks } = bestShareScale(dots.map((d) => d.best));
  const plotW = Math.max(0, width - PAD.left - PAD.right);
  const plotH = HEIGHT - PAD.top - PAD.bottom;
  const x = (/** @type {number} */ i) => PAD.left + (points.length > 1 ? (i / (points.length - 1)) * plotW : plotW / 2);
  const y = (/** @type {number} */ v) => PAD.top + plotH - ((Math.log10(v) - from) / (to - from)) * plotH;
  const xTickCount = Math.max(2, Math.min(6, Math.floor(plotW / 160)));
  const xTicks = points.length > 1
    ? Array.from({ length: xTickCount }, (_, k) => Math.round((k / (xTickCount - 1)) * (points.length - 1)))
    : [];
  const shown = active === null ? null : dots[active] ?? null;
  const blockY = y(1);
  const blocks = dots.filter((d) => d.best >= 1).length;

  /** The dot nearest the pointer, by time. @param {React.PointerEvent<SVGRectElement>} event */
  function onPointerMove(event) {
    if (dots.length === 0) return;
    const box = event.currentTarget.getBoundingClientRect();
    const at = (event.clientX - box.left) / box.width * (points.length - 1);
    let best = 0;
    for (let k = 1; k < dots.length; k++) if (Math.abs(dots[k].i - at) < Math.abs(dots[best].i - at)) best = k;
    setActive(best);
  }

  /** @param {React.KeyboardEvent<SVGSVGElement>} event */
  function onKeyDown(event) {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight" || dots.length === 0) return;
    event.preventDefault();
    const step = event.key === "ArrowLeft" ? -1 : 1;
    setActive((k) => Math.min(dots.length - 1, Math.max(0, (k ?? dots.length - 1) + step)));
  }

  const tooltipLeft = shown === null ? 0 : Math.min(Math.max(x(shown.i) - 88, 0), Math.max(0, width - 176));

  return (
    <div>
      {blocks > 0 && (
        <ul className="mb-2 flex flex-wrap gap-x-4 text-xs text-ink-2" aria-label="Legend">
          <li className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-series-1" />Best share</li>
          <li className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full bg-series-block" />A block</li>
        </ul>
      )}
      <div ref={frame} className={`relative transition-opacity ${dimmed ? "opacity-60" : ""}`}>
        {width > 0 && (
          <svg
            width={width}
            height={HEIGHT}
            role="img"
            aria-label="Best share per bucket, as a percentage of a block. Use arrow keys to read values."
            tabIndex={0}
            onKeyDown={onKeyDown}
            onFocus={() => setActive((k) => k ?? (dots.length ? dots.length - 1 : null))}
            onBlur={() => setActive(null)}
            className="block outline-none focus-visible:ring-2 focus-visible:ring-series-1/40 rounded"
          >
            {ticks.map((t) => (
              <g key={t}>
                <line x1={PAD.left} x2={width - PAD.right} y1={y(t)} y2={y(t)}
                  stroke={t === ticks[0] ? "var(--axis)" : "var(--grid)"} strokeWidth="1" shapeRendering="crispEdges" />
                <text x={PAD.left - 8} y={y(t)} dy="0.32em" textAnchor="end" fontSize="11" fill="var(--muted)" className="tabular">
                  {formatBestShare(t)}
                </text>
              </g>
            ))}
            {/* The line a share must reach to be a block: heavier than the grid and named, so it never reads as one. */}
            <line x1={PAD.left} x2={width - PAD.right} y1={blockY} y2={blockY} stroke="var(--ink-2)" strokeWidth="1.5" />
            <text x={width - PAD.right} y={blockY - 6} textAnchor="end" fontSize="11" fill="var(--ink-2)"
              stroke="var(--surface)" strokeWidth="4" strokeLinejoin="round" paintOrder="stroke">A block</text>
            {xTicks.map((i) => (
              <text key={i} x={x(i)} y={HEIGHT - 8} fontSize="11" fill="var(--muted)" className="tabular"
                textAnchor={i === 0 ? "start" : i === points.length - 1 ? "end" : "middle"}>
                {formatTime(points[i].time)}
              </text>
            ))}
            {dots.map((d, k) => (
              <circle key={d.time} cx={x(d.i)} cy={y(d.best)} r={d.best >= 1 ? 5 : 4} fill={d.best >= 1 ? "var(--series-block)" : "var(--series-1)"}
                stroke="var(--surface)" strokeWidth="2" opacity={shown && active !== k ? 0.55 : 1} className="chart-pop"
                style={/** @type {React.CSSProperties} */ ({ "--i": k })} />
            ))}
            {blocks <= MAX_BLOCK_LABELS && dots.filter((d) => d.best >= 1).map((d) => (
              <text key={`label-${d.time}`} x={x(d.i)} y={y(d.best) - 10} textAnchor="middle" fontSize="11" fill="var(--ink-2)"
                stroke="var(--surface)" strokeWidth="4" strokeLinejoin="round" paintOrder="stroke">Block</text>
            ))}
            {shown !== null && (
              <line x1={x(shown.i)} x2={x(shown.i)} y1={PAD.top} y2={PAD.top + plotH} stroke="var(--axis)" strokeWidth="1" />
            )}
            {dots.length === 0 && loaded && (
              <text x={PAD.left + plotW / 2} y={PAD.top + plotH / 2 + 18} textAnchor="middle" fontSize="13" fill="var(--muted)">
                No accepted shares in this range
              </text>
            )}
            <rect x={PAD.left} y={PAD.top} width={plotW} height={plotH} fill="transparent"
              onPointerMove={onPointerMove} onPointerLeave={() => setActive(null)} />
          </svg>
        )}
        {shown !== null && (
          <div className="pointer-events-none absolute top-0 w-44 rounded-md border border-line bg-surface px-3 py-2 text-xs shadow-sm"
            style={{ left: tooltipLeft }}>
            <div className="flex items-center gap-2">
              <span className={`h-2 w-2 rounded-full ${shown.best >= 1 ? "bg-series-block" : "bg-series-1"}`} />
              <span className="text-sm font-semibold text-ink tabular">{formatBestShare(shown.best)}</span>
              <span className="text-muted">of a block</span>
            </div>
            {shown.best >= 1 && <div className="mt-0.5 text-ink-2">A block</div>}
            <div className="mt-1 text-ink-2">{formatTime(shown.time)}</div>
          </div>
        )}
      </div>
      <button type="button" onClick={() => setShowTable((v) => !v)}
        className="inline-flex min-h-6 items-center mt-2 text-xs text-ink-2 underline decoration-line underline-offset-2 hover:text-ink">
        {showTable ? "Hide table" : "Show as table"}
      </button>
      {showTable && (
        <div className="mt-2 max-h-64 overflow-auto rounded border border-line">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-surface text-left text-muted">
              <tr><th className="px-3 py-1.5 font-medium">Time</th><th className="px-3 py-1.5 text-right font-medium">Best share</th></tr>
            </thead>
            <tbody className="tabular">
              {[...dots].reverse().map((d) => (
                <tr key={d.time} className="border-t border-line">
                  <td className="px-3 py-1 text-ink-2">{formatTime(d.time)}</td>
                  <td className="px-3 py-1 text-right">{formatBestShare(d.best)}{d.best >= 1 ? " (a block)" : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/**
 * The best share card for a miner or a worker: this round's, the last day's or the best ever, and the chart. Nothing while best share
 * is turned off (XELDASH_BEST_SHARE=off: the API sends null).
 * @param {{ best: { round?: number | null, day?: number | null, ever?: number | null } | null | undefined,
 *   points: { time: string, best?: number | null }[] | null, dimmed?: boolean }} props
 */
export function BestShareCard({ best, points, dimmed = false }) {
  if (!best) return null;
  const figures = /** @type {[string, number | null | undefined][]} */ ([
    ["This round", best.round], ["Last 24 hours", best.day], ["Best ever", best.ever],
  ]).filter(([, value]) => value !== undefined);
  return (
    <Card
      title={<span title="Closest to a block" className="cursor-help underline decoration-dotted decoration-line underline-offset-4">Best share</span>}
      subtitle="How close the best share came to a block, per bucket, for the range chosen above">
      <dl className="mb-3 flex flex-wrap gap-x-8 gap-y-2">
        {figures.map(([label, value]) => (
          <div key={label}>
            <dt className="text-xs text-ink-2">{label}</dt>
            <dd className="text-lg font-semibold text-ink tabular">{formatBestShare(value)}</dd>
          </div>
        ))}
      </dl>
      <BestShareChart points={points} dimmed={dimmed} />
      <p className="mt-2 text-xs text-muted">
        Each hash is a fresh draw: a share that came close does not make the next block more likely. Round effort and luck say how
        mining is going.
      </p>
    </Card>
  );
}
