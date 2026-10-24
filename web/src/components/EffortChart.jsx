import { useEffect, useState } from "react";
import { formatEffort, formatInteger, formatTime } from "../format.js";
import { StatusBadge } from "./ui.jsx";

const HEIGHT = 190;
const PAD = { top: 14, right: 12, bottom: 22, left: 48 };

/**
 * The width of an element, given by a callback ref, so it is measured from whenever the element appears (the chart shows a note
 * instead until there are blocks with an effort).
 * @returns {[number, (el: HTMLDivElement | null) => void]}
 */
function useWidth() {
  const [el, setEl] = useState(/** @type {HTMLDivElement | null} */ (null));
  const [width, setWidth] = useState(0);
  useEffect(() => {
    if (!el) return undefined;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.floor(entry.contentRect.width)));
    observer.observe(el);
    return () => observer.disconnect();
  }, [el]);
  return [width, setEl];
}

/**
 * The effort of the rounds that found the last blocks, oldest first, as bars against the 100% line: up to 100% came quicker than
 * average (the accent), over it took longer (the highlight). Hover or the arrow keys show a block's height, effort, status and when it
 * was found; the table view lists them all.
 * @param {{ blocks: { hash: string, height: string, status: string, effort: number | null, foundAt: string }[], count?: number }} props
 */
export default function EffortChart({ blocks, count = 12 }) {
  const [width, frame] = useWidth();
  const [active, setActive] = useState(/** @type {number | null} */ (null));
  const [showTable, setShowTable] = useState(false);
  const shown = blocks.filter((b) => b.effort !== null && b.effort !== undefined).slice(0, count).reverse();
  if (shown.length === 0) return <p className="text-sm text-muted">The effort of each round appears once blocks are found while shares are tracked.</p>;

  const efforts = shown.map((b) => /** @type {number} */ (b.effort));
  // The scale reaches at least 200%, in whole hundreds, so the 100% line sits in the middle or lower.
  const top = Math.max(2, Math.ceil(Math.max(...efforts)));
  const ticks = Array.from({ length: top + 1 }, (_, i) => i).filter((t) => top <= 4 || t % Math.ceil(top / 4) === 0 || t === 1);
  const plotW = Math.max(0, width - PAD.left - PAD.right);
  const plotH = HEIGHT - PAD.top - PAD.bottom;
  const slot = plotW / shown.length;
  const barW = Math.max(2, Math.min(48, slot - Math.min(10, slot * 0.25)));
  const y = (/** @type {number} */ v) => PAD.top + plotH - (v / top) * plotH;
  const last = shown.length - 1;

  /** @param {React.PointerEvent<SVGRectElement>} event */
  function onPointerMove(event) {
    const box = event.currentTarget.getBoundingClientRect();
    setActive(Math.min(last, Math.max(0, Math.floor(((event.clientX - box.left) / box.width) * shown.length))));
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
  const block = active === null ? null : shown[active];

  return (
    <div>
      <div ref={frame} className="relative">
        {width > 0 && (
          <svg width={width} height={HEIGHT} role="img" tabIndex={0} onKeyDown={onKeyDown}
            aria-label={`Effort of the last ${shown.length} blocks, oldest first: ${efforts.map((e) => formatEffort(e)).join(", ")}. Use arrow keys to read each.`}
            onFocus={() => setActive((i) => i ?? last)} onBlur={() => setActive(null)}
            className="block rounded outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
            {ticks.map((t) => (
              <g key={t}>
                <line x1={PAD.left} x2={width - PAD.right} y1={y(t)} y2={y(t)} shapeRendering="crispEdges"
                  stroke={t === 0 ? "var(--axis)" : t === 1 ? "var(--ink-2)" : "var(--grid)"} strokeWidth="1" strokeDasharray={t === 1 ? "4 3" : undefined} />
                <text x={PAD.left - 8} y={y(t)} dy="0.32em" textAnchor="end" fontSize="11" fill={t === 1 ? "var(--ink-2)" : "var(--muted)"} className="tabular">
                  {t * 100}%
                </text>
              </g>
            ))}
            {shown.map((b, i) => {
              const effort = efforts[i];
              const h = Math.max(2, (effort / top) * plotH);
              return (
                <rect key={b.hash} x={PAD.left + slot * i + (slot - barW) / 2} y={PAD.top + plotH - h} width={barW} height={h} rx="4"
                  fill={effort <= 1 ? "var(--accent)" : "var(--gold)"} opacity={active === null || active === i ? 1 : 0.55}
                  className="chart-grow" style={/** @type {React.CSSProperties} */ ({ "--i": i })} />
              );
            })}
            <text x={PAD.left} y={HEIGHT - 4} fontSize="11" fill="var(--muted)">oldest</text>
            <text x={width - PAD.right} y={HEIGHT - 4} fontSize="11" fill="var(--muted)" textAnchor="end">newest</text>
            <rect x={PAD.left} y={PAD.top} width={plotW} height={plotH} fill="transparent"
              onPointerMove={onPointerMove} onPointerLeave={() => setActive(null)} />
          </svg>
        )}
        {block && (
          <div className="pointer-events-none absolute top-0 w-44 rounded-md border border-line bg-panel px-3 py-2 text-xs shadow-sm"
            style={{ left: tooltipLeft }}>
            <div className="mono text-sm font-semibold text-ink">{formatEffort(efforts[/** @type {number} */ (active)])}</div>
            <div className="mono mt-0.5 text-ink-2">Block {formatInteger(block.height)}</div>
            <div className="mt-1"><StatusBadge status={block.status} /></div>
            <div className="mt-1 text-muted">{formatTime(block.foundAt)}</div>
          </div>
        )}
      </div>
      <div className="label mt-3 flex flex-wrap items-center gap-x-4 gap-y-1">
        <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm bg-accent" aria-hidden="true" />100% or less: quicker than average</span>
        <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm bg-gold" aria-hidden="true" />Over 100%: took longer</span>
        <button type="button" onClick={() => setShowTable((v) => !v)} className="ml-auto text-xs text-ink-2 underline decoration-line underline-offset-2 hover:text-ink">
          {showTable ? "Hide table" : "Show as table"}
        </button>
      </div>
      {showTable && (
        <div className="mt-2 max-h-64 overflow-auto rounded-lg border border-line">
          <table className="tbl">
            <thead><tr><th>Height</th><th>Status</th><th className="r">Effort</th><th className="r">Found</th></tr></thead>
            <tbody>
              {[...shown].reverse().map((b) => (
                <tr key={b.hash}>
                  <td className="mono">{formatInteger(b.height)}</td>
                  <td><StatusBadge status={b.status} /></td>
                  <td className="mono r">{formatEffort(/** @type {number} */ (b.effort))}</td>
                  <td className="r text-ink-2">{formatTime(b.foundAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
