import { useEffect, useMemo, useRef, useState } from "react";
import { usePolled } from "../api.js";
import { useCoin } from "../coin.js";
import { formatXel } from "../format.js";
import { Segmented } from "./ui.jsx";

const RANGES = ["30d", "90d", "1y"];
const HEIGHT = 220;
const PAD = { top: 14, right: 16, bottom: 28, left: 64 };
const ATOMIC = 1e8;

/** Round tick step to 1, 2 or 5 times a power of ten. @param {number} max @param {number} count */
function niceTicks(max, count) {
  if (max <= 0) return [0];
  const raw = max / count;
  const power = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * power).find((s) => s >= raw) ?? raw;
  const ticks = [];
  for (let v = 0; v <= max + step * 0.001; v += step) ticks.push(v);
  if (ticks[ticks.length - 1] < max) ticks.push(ticks[ticks.length - 1] + step);
  return ticks;
}

/** @param {number} xel */
function formatAxis(xel) {
  return xel >= 10 ? xel.toFixed(0) : xel >= 1 ? xel.toFixed(1) : xel.toFixed(2);
}

/** @param {string} iso */
function formatDay(iso) {
  return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", timeZone: "UTC" });
}

/**
 * Running total of the rewards found, next to the total expected from the work done (blocks it
 * should have found, at the current reward per block): the same unit on one axis, so the gap is
 * luck. Both start on the first day the work was tracked, and count from the start of the range.
 * @param {{ address?: string | null, rewardPerBlock: number | null }} props rewardPerBlock in atomic units
 */
export default function RewardsChart({ address = null, rewardPerBlock }) {
  const coin = useCoin();
  const [range, setRange] = useState("90d");
  const history = usePolled(`/api/v1/rewards?range=${range}${address ? `&address=${encodeURIComponent(address)}` : ""}`);
  const frame = useRef(/** @type {HTMLDivElement | null} */ (null));
  const [width, setWidth] = useState(0);
  const [active, setActive] = useState(/** @type {number | null} */ (null));

  useEffect(() => {
    if (!frame.current) return undefined;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.floor(entry.contentRect.width)));
    observer.observe(frame.current);
    return () => observer.disconnect();
  }, []);

  /** @type {{ day: string, found: number, expected: number | null }[]} */
  const series = useMemo(() => {
    const points = history.data?.points ?? [];
    // Start on the first day with tracked work, or the first block if none is tracked.
    let from = points.findIndex((p) => p.expectedBlocks > 0);
    if (from < 0) from = Math.max(0, points.findIndex((p) => p.blocks > 0));
    let found = 0;
    let expectedBlocks = 0;
    return points.slice(from).map((p) => {
      found += Number(p.reward) / ATOMIC;
      expectedBlocks += p.expectedBlocks;
      return { day: p.day, found, expected: rewardPerBlock ? (expectedBlocks * rewardPerBlock) / ATOMIC : null };
    });
  }, [history.data, rewardPerBlock]);

  const hasExpected = series.some((p) => p.expected !== null && p.expected > 0);
  const max = Math.max(0, ...series.map((p) => Math.max(p.found, p.expected ?? 0)));
  const ticks = niceTicks(max, 4);
  const top = ticks[ticks.length - 1] || 1;
  const plotW = Math.max(0, width - PAD.left - PAD.right);
  const plotH = HEIGHT - PAD.top - PAD.bottom;
  const x = (/** @type {number} */ i) => PAD.left + (series.length > 1 ? (i / (series.length - 1)) * plotW : plotW / 2);
  const y = (/** @type {number} */ v) => PAD.top + plotH - (v / top) * plotH;
  const path = (/** @type {(p: typeof series[number]) => number} */ pick) =>
    series.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(pick(p)).toFixed(1)}`).join("");
  const last = series.length - 1;
  const empty = max === 0;
  const xTickCount = Math.max(2, Math.min(6, Math.floor(plotW / 110)));
  const xTicks = series.length > 1
    ? Array.from({ length: xTickCount }, (_, k) => Math.round((k / (xTickCount - 1)) * last))
    : [];

  /** @param {React.PointerEvent<SVGRectElement>} event */
  function onPointerMove(event) {
    const box = event.currentTarget.getBoundingClientRect();
    const ratio = (event.clientX - box.left) / box.width;
    setActive(Math.min(last, Math.max(0, Math.round(ratio * last))));
  }

  /** @param {React.KeyboardEvent<SVGSVGElement>} event */
  function onKeyDown(event) {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const step = event.key === "ArrowLeft" ? -1 : 1;
    setActive((i) => Math.min(last, Math.max(0, (i ?? last) + step)));
  }

  const tooltipLeft = active === null ? 0 : Math.min(Math.max(x(active) - 88, 0), Math.max(0, width - 176));
  const xel = (/** @type {number} */ v) => formatXel(String(Math.round(v * ATOMIC)), coin);

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <Segmented label="Rewards range" value={range} options={RANGES} onChange={setRange} />
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-ink-2">
          <span className="flex items-center gap-1.5"><span className="h-0.5 w-4 rounded bg-series-1" />Found</span>
          {hasExpected && <span className="flex items-center gap-1.5"><span className="h-0 w-4 border-t-2 border-dashed border-ink-2" />Expected from the work done</span>}
        </div>
      </div>
      <div ref={frame} className={`relative transition-opacity ${history.loading ? "opacity-60" : ""}`}>
        {width > 0 && (
          <svg width={width} height={HEIGHT} role="img" tabIndex={0} onKeyDown={onKeyDown}
            aria-label="Total rewards found over time, against the rewards expected from the work done. Use arrow keys to read values."
            onFocus={() => setActive((i) => i ?? last)} onBlur={() => setActive(null)}
            className="block rounded outline-none focus-visible:ring-2 focus-visible:ring-series-1/40">
            {ticks.map((t) => (
              <g key={t}>
                <line x1={PAD.left} x2={width - PAD.right} y1={y(t)} y2={y(t)}
                  stroke={t === 0 ? "var(--axis)" : "var(--grid)"} strokeWidth="1" shapeRendering="crispEdges" />
                <text x={PAD.left - 8} y={y(t)} dy="0.32em" textAnchor="end" fontSize="11" fill="var(--muted)" className="tabular">
                  {formatAxis(t)}
                </text>
              </g>
            ))}
            {xTicks.map((i) => (
              <text key={i} x={x(i)} y={HEIGHT - 8} fontSize="11" fill="var(--muted)" className="tabular"
                textAnchor={i === 0 ? "start" : i === last ? "end" : "middle"}>
                {formatDay(series[i].day)}
              </text>
            ))}
            {!empty && hasExpected && (
              <path d={path((p) => p.expected ?? 0)} fill="none" stroke="var(--ink-2)" strokeWidth="1.5" strokeDasharray="5 4" strokeLinejoin="round" />
            )}
            {!empty && <path d={path((p) => p.found)} fill="none" stroke="var(--series-1)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />}
            {!empty && active === null && last >= 0 && (
              <circle cx={x(last)} cy={y(series[last].found)} r="4" fill="var(--series-1)" stroke="var(--surface)" strokeWidth="2" />
            )}
            {active !== null && series[active] && (
              <>
                <line x1={x(active)} x2={x(active)} y1={PAD.top} y2={PAD.top + plotH} stroke="var(--axis)" strokeWidth="1" />
                <circle cx={x(active)} cy={y(series[active].found)} r="4" fill="var(--series-1)" stroke="var(--surface)" strokeWidth="2" />
              </>
            )}
            {empty && history.data && (
              <text x={PAD.left + plotW / 2} y={PAD.top + plotH / 2} textAnchor="middle" fontSize="13" fill="var(--muted)">
                No rewards found in this range yet
              </text>
            )}
            <rect x={PAD.left} y={PAD.top} width={plotW} height={plotH} fill="transparent"
              onPointerMove={onPointerMove} onPointerLeave={() => setActive(null)} />
          </svg>
        )}
        {active !== null && series[active] && (
          <div className="pointer-events-none absolute top-0 w-44 rounded-md border border-line bg-surface px-3 py-2 text-xs shadow-sm"
            style={{ left: tooltipLeft }}>
            <div className="text-ink-2">{formatDay(series[active].day)}</div>
            <div className="mt-1 flex items-center gap-2 tabular text-ink"><span className="h-0.5 w-3 rounded bg-series-1" />{xel(series[active].found)} found</div>
            {series[active].expected !== null && hasExpected && (
              <div className="flex items-center gap-2 tabular text-ink-2"><span className="h-0 w-3 border-t-2 border-dashed border-ink-2" />{xel(series[active].expected ?? 0)} expected</div>
            )}
          </div>
        )}
      </div>
      <p className="mt-2 text-xs text-muted">
        Totals count from the start of the range{hasExpected ? " (or from when xelDash began tracking work, if later)" : ""}. Only main-chain and side blocks count as found, so a block
        shows once it is final.
      </p>
    </div>
  );
}
