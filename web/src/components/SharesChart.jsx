import { useEffect, useMemo, useRef, useState } from "react";
import { formatInteger, formatTime } from "../format.js";

const HEIGHT = 200;
const PAD = { top: 12, right: 16, bottom: 28, left: 52 };

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

/**
 * Shares per time bucket: accepted, with rejected stacked on top. A rig that suddenly rejects
 * shares (stale work, a wrong setting) shows up here long before the hashrate line moves. Uses
 * the same data and range as the hashrate chart above it.
 * @param {{ points: { time: string, accepted: string, rejected: string }[] | null, dimmed?: boolean }} props
 */
export default function SharesChart({ points: loaded, dimmed = false }) {
  const points = loaded ?? [];
  const frame = useRef(/** @type {HTMLDivElement | null} */ (null));
  const [width, setWidth] = useState(0);
  const [active, setActive] = useState(/** @type {number | null} */ (null));

  useEffect(() => {
    if (!frame.current) return undefined;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.floor(entry.contentRect.width)));
    observer.observe(frame.current);
    return () => observer.disconnect();
  }, []);

  const accepted = useMemo(() => points.map((p) => Number(p.accepted)), [points]);
  const rejected = useMemo(() => points.map((p) => Number(p.rejected)), [points]);
  const max = Math.max(0, ...accepted.map((a, i) => a + rejected[i]));
  const ticks = niceTicks(max, 4);
  const top = ticks[ticks.length - 1] || 1;
  const plotW = Math.max(0, width - PAD.left - PAD.right);
  const plotH = HEIGHT - PAD.top - PAD.bottom;
  const slot = points.length ? plotW / points.length : 0;
  const barW = Math.max(1, slot - (slot > 4 ? 2 : 0));
  const y = (/** @type {number} */ v) => PAD.top + plotH - (v / top) * plotH;
  const totalAccepted = accepted.reduce((a, b) => a + b, 0);
  const totalRejected = rejected.reduce((a, b) => a + b, 0);
  const rate = totalAccepted + totalRejected > 0 ? (totalRejected / (totalAccepted + totalRejected)) * 100 : null;
  const empty = max === 0;
  const last = points.length - 1;

  /** @param {React.PointerEvent<SVGRectElement>} event */
  function onPointerMove(event) {
    const box = event.currentTarget.getBoundingClientRect();
    setActive(Math.min(last, Math.max(0, Math.floor(((event.clientX - box.left) / box.width) * points.length))));
  }

  /** @param {React.KeyboardEvent<SVGSVGElement>} event */
  function onKeyDown(event) {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const step = event.key === "ArrowLeft" ? -1 : 1;
    setActive((i) => Math.min(last, Math.max(0, (i ?? last) + step)));
  }

  const center = active === null ? 0 : PAD.left + slot * (active + 0.5);
  const tooltipLeft = Math.min(Math.max(center - 88, 0), Math.max(0, width - 176));
  const xTickCount = Math.max(2, Math.min(6, Math.floor(plotW / 110)));
  const xTicks = points.length > 1
    ? Array.from({ length: xTickCount }, (_, k) => Math.round((k / (xTickCount - 1)) * last))
    : [];

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-ink-2">
        <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm bg-series-1" />Accepted</span>
        <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm bg-critical" />Rejected (stale or invalid)</span>
        {rate !== null && (
          <span className="tabular text-muted">
            In this range: {formatInteger(totalAccepted)} accepted, {formatInteger(totalRejected)} rejected ({rate < 0.1 && rate > 0 ? "<0.1" : rate.toFixed(1)}%)
          </span>
        )}
      </div>
      <div ref={frame} className={`relative transition-opacity ${dimmed ? "opacity-60" : ""}`}>
        {width > 0 && (
          <svg width={width} height={HEIGHT} role="img" tabIndex={0} onKeyDown={onKeyDown}
            aria-label="Accepted and rejected shares over time. Use arrow keys to read values."
            onFocus={() => setActive((i) => i ?? last)} onBlur={() => setActive(null)}
            className="block rounded outline-none focus-visible:ring-2 focus-visible:ring-series-1/40">
            {ticks.map((t) => (
              <g key={t}>
                <line x1={PAD.left} x2={width - PAD.right} y1={y(t)} y2={y(t)}
                  stroke={t === 0 ? "var(--axis)" : "var(--grid)"} strokeWidth="1" shapeRendering="crispEdges" />
                <text x={PAD.left - 8} y={y(t)} dy="0.32em" textAnchor="end" fontSize="11" fill="var(--muted)" className="tabular">
                  {formatInteger(t)}
                </text>
              </g>
            ))}
            {xTicks.map((i) => (
              <text key={i} x={PAD.left + slot * (i + 0.5)} y={HEIGHT - 8} fontSize="11" fill="var(--muted)" className="tabular"
                textAnchor={i === 0 ? "start" : i === last ? "end" : "middle"}>
                {formatTime(points[i].time)}
              </text>
            ))}
            {!empty && points.map((p, i) => {
              const x = PAD.left + slot * i + (slot - barW) / 2;
              const acceptedH = (accepted[i] / top) * plotH;
              const rejectedH = (rejected[i] / top) * plotH;
              return (
                <g key={p.time} opacity={active === null || active === i ? 1 : 0.55}>
                  {accepted[i] > 0 && <rect x={x} y={y(accepted[i])} width={barW} height={acceptedH} fill="var(--series-1)" />}
                  {rejected[i] > 0 && <rect x={x} y={y(accepted[i]) - rejectedH} width={barW} height={Math.max(1, rejectedH)} fill="var(--critical)" />}
                </g>
              );
            })}
            {empty && loaded && (
              <text x={PAD.left + plotW / 2} y={PAD.top + plotH / 2} textAnchor="middle" fontSize="13" fill="var(--muted)">
                No shares in this range
              </text>
            )}
            <rect x={PAD.left} y={PAD.top} width={plotW} height={plotH} fill="transparent"
              onPointerMove={onPointerMove} onPointerLeave={() => setActive(null)} />
          </svg>
        )}
        {active !== null && points[active] && (
          <div className="pointer-events-none absolute top-0 w-44 rounded-md border border-line bg-surface px-3 py-2 text-xs shadow-sm"
            style={{ left: tooltipLeft }}>
            <div className="text-ink-2">{formatTime(points[active].time)}</div>
            <div className="mt-1 flex items-center gap-2 tabular text-ink">
              <span className="h-2 w-2 rounded-sm bg-series-1" />{formatInteger(accepted[active])} accepted
            </div>
            <div className="flex items-center gap-2 tabular text-ink">
              <span className="h-2 w-2 rounded-sm bg-critical" />{formatInteger(rejected[active])} rejected
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
