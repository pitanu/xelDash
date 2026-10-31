import { useState } from "react";
import { usePolled } from "../api.js";
import { calendarWeeks } from "../block-days.js";
import { formatInteger } from "../format.js";
import { Card, Figure, Segmented } from "./ui.jsx";

const RANGES = /** @type {const} */ ([["90d", "90 d"], ["1y", "1 y"]]);
const DAYS = /** @type {Record<string, number>} */ ({ "90d": 90, "1y": 365 });
// Shades of the accent for 1, 2, 3 and 4 quarters of the busiest day.
const SHADES = [35, 60, 80, 100];

/** @param {Date} day */
const dayLabel = (day) => day.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "numeric" });
/** "1 block", "3 blocks". @param {number} n */
const blocksText = (n) => `${formatInteger(n)} ${n === 1 ? "block" : "blocks"}`;

/**
 * Blocks found each day, as a calendar of weeks (Monday on top), in this browser's time zone: for an address, one of its rigs,
 * or with neither, the whole pool. Darker days found more blocks; the table lists the days that found any.
 * @param {{ address?: string, worker?: string }} props
 */
export default function BlockCalendar({ address, worker }) {
  const [range, setRange] = useState(/** @type {string} */ ("1y"));
  const [showTable, setShowTable] = useState(false);
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC";
  const query = `${address ? `address=${encodeURIComponent(address)}&` : ""}${worker ? `worker=${encodeURIComponent(worker)}&` : ""}range=${range}&tz=${encodeURIComponent(timeZone)}`;
  const calendar = usePolled(`/api/v1/block-days?${query}`);
  const found = calendar.data?.days ?? [];
  const weeks = calendarWeeks(found, DAYS[range]);
  const total = found.reduce((/** @type {number} */ sum, /** @type {{ blocks: number }} */ d) => sum + d.blocks, 0);
  const best = found.reduce((/** @type {any} */ top, /** @type {{ blocks: number }} */ d) => (!top || d.blocks > top.blocks ? d : top), null);
  const bestCell = best && weeks.flat().find((c) => c?.key === best.day);
  const max = best?.blocks ?? 0;
  const who = worker ? "this rig" : address ? "this address" : "this pool";
  const rangeText = RANGES.find(([k]) => k === range)?.[1];
  // A month's name over the week its first day is in (and over the first week, for the month the range starts in).
  const months = weeks.map((week, w) => {
    const firstOfMonth = week.find((c) => c && c.day.getDate() === 1);
    const cell = firstOfMonth ?? (w === 0 ? week.find((c) => c) : null);
    return cell && (w > 0 || cell.day.getDate() <= 21) ? cell.day.toLocaleDateString(undefined, { month: "short" }) : null;
  });

  return (
    <Card title="Blocks by day" subtitle={`Blocks ${who} found each day, in your time zone. Darker: more blocks that day.`}
      action={<Segmented label="Range" value={range} options={RANGES} onChange={setRange} />}>
      <div className={`grid grid-cols-2 gap-x-4 gap-y-5 lg:grid-cols-4 ${calendar.loading ? "opacity-60" : ""}`}>
        <Figure label="Blocks found" value={calendar.data ? formatInteger(total) : "—"} note={`in the last ${rangeText}`} />
        <Figure label="Days with a block" value={calendar.data ? formatInteger(found.length) : "—"} note={`of ${formatInteger(DAYS[range])} days`} />
        <Figure label="Best day" value={best ? blocksText(best.blocks) : "—"} note={bestCell ? dayLabel(bestCell.day) : " "} />
        <Figure label="Average a day" value={calendar.data ? (total / DAYS[range]).toLocaleString(undefined, { maximumFractionDigits: 2 }) : "—"}
          note="blocks, over the whole range" />
      </div>
      {calendar.data && (
        <div className="mt-5 border-t border-line pt-4">
          <div className="grid items-center gap-[3px]" role="img"
            style={{ gridTemplateColumns: `auto repeat(${weeks.length}, minmax(0, 1fr))`, maxWidth: `${weeks.length * 17 + 40}px` }}
            aria-label={`${blocksText(total)} found in the last ${rangeText}, on ${formatInteger(found.length)} days; the table below lists them.`}>
            {months.map((month, w) => month && (
              <span key={`m${w}`} className="label whitespace-nowrap text-[10px] leading-none" aria-hidden="true" style={{ gridColumn: w + 2, gridRow: 1 }}>{month}</span>
            ))}
            {["Mon", "", "Wed", "", "Fri", "", ""].map((name, d) => name && (
              <span key={`d${d}`} className="label pr-2 text-[10px] leading-none" aria-hidden="true" style={{ gridColumn: 1, gridRow: d + 2 }}>
                {new Date(2024, 0, 1 + d).toLocaleDateString(undefined, { weekday: "short" })}
              </span>
            ))}
            {weeks.flatMap((week, w) => week.map((cell, d) => {
              if (!cell) return null;
              const level = cell.blocks > 0 ? Math.min(4, Math.ceil((cell.blocks / max) * 4)) : 0;
              return (
                <span key={cell.key} className="aspect-square rounded-[2px]" data-level={level} style={{ gridColumn: w + 2, gridRow: d + 2,
                  background: level ? `color-mix(in srgb, var(--accent) ${SHADES[level - 1]}%, var(--panel-2))` : "var(--panel-2)" }}
                  title={`${dayLabel(cell.day)}: ${blocksText(cell.blocks)}${cell.orphaned ? `, ${formatInteger(cell.orphaned)} orphaned` : ""}`} />
              );
            }))}
          </div>
          <div className="label mt-3 flex flex-wrap items-center gap-x-4 gap-y-1">
            <span>Orphaned blocks count as found; hover a day for how many were orphaned.</span>
            <button type="button" onClick={() => setShowTable((v) => !v)} className="ml-auto text-xs text-ink-2 underline decoration-line underline-offset-2 hover:text-ink">
              {showTable ? "Hide table" : "Show as table"}
            </button>
          </div>
          {showTable && (
            <div className="mt-2 max-h-64 overflow-auto rounded-lg border border-line">
              {found.length === 0
                ? <p className="p-3 text-sm text-muted">No blocks in the last {rangeText}.</p>
                : (
                  <table className="tbl">
                    <thead><tr><th>Day</th><th className="r">Blocks</th><th className="r">Orphaned</th></tr></thead>
                    <tbody>
                      {weeks.flat().filter((c) => c && c.blocks > 0).reverse().map((c) => c && (
                        <tr key={c.key}>
                          <td>{dayLabel(c.day)}</td>
                          <td className="mono r">{formatInteger(c.blocks)}</td>
                          <td className="mono r">{formatInteger(c.orphaned)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
