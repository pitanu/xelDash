import { useEffect, useId, useMemo, useRef, useState } from "react";
import { RANGES, formatHashrate, formatInteger, formatTime } from "../format.js";
import { SMOOTHING, monotonePath, smooth } from "./chart-math.js";
import { Segmented } from "./ui.jsx";

const HEIGHT = 240;
const SMOOTHING_KEY = "xeldash.chartSmoothing";

/** @returns {"raw" | "light" | "strong"} */
function readSmoothing() {
  try {
    const saved = localStorage.getItem(SMOOTHING_KEY);
    return saved === "raw" || saved === "strong" ? saved : "light";
  } catch {
    return "light";
  }
}
const PAD = { top: 16, right: 16, bottom: 28, left: 68 };

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
 * Single-series hashrate area chart. The card title names the series, so there is no legend.
 * The line is smoothed (a choice kept per browser); the raw buckets stay behind it as a
 * faint line, so short spikes and gaps remain visible.
 * `points` is null while the first load is in flight; the frame and controls show already.
 * @param {{ points: { time: string, hashrate: string, accepted: string, rejected: string }[] | null, dimmed?: boolean,
 *   range: string, onRangeChange: (range: string) => void }} props
 */
export default function HashrateChart({ points: loaded, dimmed = false, range, onRangeChange }) {
  const points = loaded ?? [];
  const frame = useRef(null);
  const width = useWidth(frame);
  const [active, setActive] = useState(/** @type {number | null} */ (null));
  const [showTable, setShowTable] = useState(false);
  const [smoothing, setSmoothing] = useState(readSmoothing);
  const gradientId = useId();

  const raw = useMemo(() => points.map((p) => Number(p.hashrate)), [points]);
  const values = useMemo(() => smooth(raw, smoothing), [raw, smoothing]);
  const smoothed = smoothing !== "raw";
  // The scale fits the smoothed line; raw spikes above it are clipped at the top.
  const max = Math.max(0, ...values);
  const ticks = niceTicks(max, 4);
  const top = ticks[ticks.length - 1] || 1;
  const plotW = Math.max(0, width - PAD.left - PAD.right);
  const plotH = HEIGHT - PAD.top - PAD.bottom;
  const x = (/** @type {number} */ i) => PAD.left + (points.length > 1 ? (i / (points.length - 1)) * plotW : plotW / 2);
  const y = (/** @type {number} */ v) => PAD.top + plotH - (v / top) * plotH;

  const xs = values.map((_, i) => x(i));
  const line = smoothed
    ? monotonePath(xs, values.map(y))
    : values.map((v, i) => `${i === 0 ? "M" : "L"}${xs[i].toFixed(1)},${y(v).toFixed(1)}`).join("");
  const rawLine = smoothed ? raw.map((v, i) => `${i === 0 ? "M" : "L"}${xs[i].toFixed(1)},${y(Math.min(v, top)).toFixed(1)}`).join("") : "";
  const area = values.length ? `${line}L${x(values.length - 1).toFixed(1)},${y(0)}L${x(0).toFixed(1)},${y(0)}Z` : "";

  /** @param {"raw" | "light" | "strong"} level */
  function chooseSmoothing(level) {
    setSmoothing(level);
    try {
      localStorage.setItem(SMOOTHING_KEY, level);
    } catch {
      // Not remembered in private mode.
    }
  }
  const xTickCount = Math.max(2, Math.min(6, Math.floor(plotW / 110)));
  const xTicks = points.length > 1
    ? Array.from({ length: xTickCount }, (_, k) => Math.round((k / (xTickCount - 1)) * (points.length - 1)))
    : [];
  const empty = max === 0;
  const last = values.length - 1;
  const shown = active ?? null;

  /** @param {React.PointerEvent<SVGRectElement>} event */
  function onPointerMove(event) {
    const box = event.currentTarget.getBoundingClientRect();
    const ratio = (event.clientX - box.left) / box.width;
    setActive(Math.min(points.length - 1, Math.max(0, Math.round(ratio * (points.length - 1)))));
  }

  /** @param {React.KeyboardEvent<SVGSVGElement>} event */
  function onKeyDown(event) {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const step = event.key === "ArrowLeft" ? -1 : 1;
    setActive((i) => Math.min(points.length - 1, Math.max(0, (i ?? last) + step)));
  }

  const tooltipLeft = shown === null ? 0 : Math.min(Math.max(x(shown) - 88, 0), Math.max(0, width - 176));

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <Segmented label="Chart range" value={range} options={RANGES} onChange={onRangeChange} />
        <Segmented label="Smoothing" value={smoothing} options={SMOOTHING} onChange={chooseSmoothing} />
      </div>
      <div ref={frame} className={`relative transition-opacity ${dimmed ? "opacity-60" : ""}`}>
        {width > 0 && (
          <svg
            width={width}
            height={HEIGHT}
            role="img"
            aria-label="Hashrate over time. Use arrow keys to read values."
            tabIndex={0}
            onKeyDown={onKeyDown}
            onFocus={() => setActive((i) => i ?? last)}
            onBlur={() => setActive(null)}
            className="block outline-none focus-visible:ring-2 focus-visible:ring-series-1/40 rounded"
          >
            {ticks.map((t) => (
              <g key={t}>
                <line x1={PAD.left} x2={width - PAD.right} y1={y(t)} y2={y(t)}
                  stroke={t === 0 ? "var(--axis)" : "var(--grid)"} strokeWidth="1" shapeRendering="crispEdges" />
                <text x={PAD.left - 8} y={y(t)} dy="0.32em" textAnchor="end" fontSize="11" fill="var(--muted)" className="tabular">
                  {formatHashrate(t)}
                </text>
              </g>
            ))}
            {xTicks.map((i) => (
              <text key={i} x={x(i)} y={HEIGHT - 8} fontSize="11" fill="var(--muted)" className="tabular"
                textAnchor={i === 0 ? "start" : i === points.length - 1 ? "end" : "middle"}>
                {formatTime(points[i].time)}
              </text>
            ))}
            <defs>
              <linearGradient id={gradientId} x1="0" x2="0" y1="0" y2="1">
                <stop offset="0" stopColor="var(--series-1)" stopOpacity="0.18" />
                <stop offset="1" stopColor="var(--series-1)" stopOpacity="0.01" />
              </linearGradient>
            </defs>
            {!empty && (
              <>
                <path d={area} fill={`url(#${gradientId})`} />
                {smoothed && <path d={rawLine} fill="none" stroke="var(--series-1)" strokeOpacity="0.3" strokeWidth="1" strokeLinejoin="round" />}
                <path d={line} fill="none" stroke="var(--series-1)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
              </>
            )}
            {!empty && shown === null && last >= 0 && (
              <>
                <circle cx={x(last)} cy={y(values[last])} r="4" fill="var(--series-1)" stroke="var(--surface)" strokeWidth="2" />
                <text x={x(last) - 8} y={y(values[last]) - 10} textAnchor="end" fontSize="12" fill="var(--ink-2)" className="tabular"
                  stroke="var(--surface)" strokeWidth="4" strokeLinejoin="round" paintOrder="stroke">
                  {formatHashrate(values[last])}
                </text>
              </>
            )}
            {shown !== null && (
              <>
                <line x1={x(shown)} x2={x(shown)} y1={PAD.top} y2={PAD.top + plotH} stroke="var(--axis)" strokeWidth="1" />
                <circle cx={x(shown)} cy={y(values[shown])} r="4" fill="var(--series-1)" stroke="var(--surface)" strokeWidth="2" />
              </>
            )}
            {empty && loaded && (
              <text x={PAD.left + plotW / 2} y={PAD.top + plotH / 2} textAnchor="middle" fontSize="13" fill="var(--muted)">
                No accepted shares in this range
              </text>
            )}
            <rect x={PAD.left} y={PAD.top} width={plotW} height={plotH} fill="transparent"
              onPointerMove={onPointerMove} onPointerLeave={() => setActive(null)} />
          </svg>
        )}
        {shown !== null && points[shown] && (
          <div className="pointer-events-none absolute top-0 w-44 rounded-md border border-line bg-surface px-3 py-2 text-xs shadow-sm"
            style={{ left: tooltipLeft }}>
            <div className="flex items-center gap-2">
              <span className="h-0.5 w-3 rounded bg-series-1" />
              <span className="text-sm font-semibold text-ink tabular">{formatHashrate(values[shown])}</span>
              {smoothed && <span className="text-muted">smoothed</span>}
            </div>
            {smoothed && <div className="mt-0.5 text-ink-2 tabular">This bucket: {formatHashrate(raw[shown])}</div>}
            <div className="mt-1 text-ink-2">{formatTime(points[shown].time)}</div>
            <div className="text-muted tabular">
              {formatInteger(points[shown].accepted)} accepted · {formatInteger(points[shown].rejected)} rejected
            </div>
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
              <tr><th className="px-3 py-1.5 font-medium">Time</th><th className="px-3 py-1.5 text-right font-medium">Hashrate</th>
                <th className="px-3 py-1.5 text-right font-medium">Accepted</th><th className="px-3 py-1.5 text-right font-medium">Rejected</th></tr>
            </thead>
            <tbody className="tabular">
              {[...points].reverse().map((p) => (
                <tr key={p.time} className="border-t border-line">
                  <td className="px-3 py-1 text-ink-2">{formatTime(p.time)}</td>
                  <td className="px-3 py-1 text-right">{formatHashrate(p.hashrate)}</td>
                  <td className="px-3 py-1 text-right">{formatInteger(p.accepted)}</td>
                  <td className="px-3 py-1 text-right">{formatInteger(p.rejected)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
