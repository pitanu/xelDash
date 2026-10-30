import { useState } from "react";
import { usePolled } from "../api.js";
import { formatDuration, onMinutesByHour } from "../activity.js";
import { formatEffort, formatHashrate, formatInteger } from "../format.js";
import { EarningsText } from "./Earnings.jsx";
import { Card, Segmented } from "./ui.jsx";

const RANGES = /** @type {const} */ ([["24h", "24 h"], ["7d", "7 d"], ["30d", "30 d"], ["90d", "90 d"]]);
// Days in the strip for each range: two for a day (yesterday and today), at most 30 (90 days of rows would not fit).
const STRIP_DAYS = /** @type {Record<string, number>} */ ({ "24h": 2, "7d": 7, "30d": 30, "90d": 30 });

/** "1.25", "0.0031": a count of blocks expected, which is usually a fraction. @param {number} value */
function formatBlocks(value) {
  return value.toLocaleString(undefined, value >= 1 ? { maximumFractionDigits: 2 } : { maximumSignificantDigits: 2 });
}

/** The hours with any time on, as ranges: "09–15, 22–23". @param {number[]} hours */
function hourRanges(hours) {
  /** @type {string[]} */
  const ranges = [];
  for (let h = 0; h < 24; h++) {
    if (!hours[h]) continue;
    let end = h;
    while (end + 1 < 24 && hours[end + 1]) end++;
    ranges.push(`${String(h).padStart(2, "0")}–${String(end + 1).padStart(2, "0")}`);
    h = end;
  }
  return ranges.join(", ") || "—";
}

/** One figure at the top of the card: a label, the value, and one short line under it. @param {{ label: string, value: string, note: React.ReactNode }} props */
function Figure({ label, value, note }) {
  return (
    <div className="min-w-0">
      <div className="label">{label}</div>
      <div className="mono mt-1 text-xl font-medium text-ink">{value}</div>
      <div className="label mt-0.5">{note}</div>
    </div>
  );
}

/** One row of the strip: a day's 24 hours, each shaded by the minutes on in it. @param {{ day: Date, hours: number[], total: number }} props */
function DayRow({ day, hours, total }) {
  const label = day.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "numeric" });
  return (
    <div className="contents">
      <div className="label whitespace-nowrap pr-3 text-right">{label}</div>
      <div className="grid grid-cols-24 gap-[2px]" title={`${label}: ${formatDuration(total)} on`}>
        {hours.map((minutes, h) => (
          <span key={h} className="h-3 rounded-[2px]" title={`${label} ${String(h).padStart(2, "0")}:00: ${formatDuration(minutes)}`}
            style={{ background: minutes > 0 ? `color-mix(in srgb, var(--accent) ${Math.max(15, Math.round((minutes / 60) * 100))}%, var(--panel-2))` : "var(--panel-2)" }} />
        ))}
      </div>
    </div>
  );
}

/**
 * When an address or one of its rigs was mining, and what that time produced: time on, hashrate while on (a workstation that mines a
 * few hours a day runs at full speed then, though its whole-day average looks slow), blocks its work was expected to find against
 * blocks found, and a strip of its days and hours, in this browser's time zone.
 * @param {{ address: string, worker?: string }} props
 */
export default function ActivityCard({ address, worker }) {
  const [range, setRange] = useState(/** @type {string} */ ("7d"));
  const [showTable, setShowTable] = useState(false);
  const query = `address=${encodeURIComponent(address)}${worker ? `&worker=${encodeURIComponent(worker)}` : ""}&range=${range}`;
  const activity = usePolled(`/api/v1/activity?${query}`, { intervalMs: 60_000 });
  const overview = usePolled("/api/v1/overview");
  const a = activity.data;
  const days = a ? onMinutesByHour(a.stretches, STRIP_DAYS[range]) : [];
  const who = worker ? "this rig" : "this address";

  return (
    <Card title="On-time" subtitle={`When ${who} was mining. A minute counts when a share came in; gaps of up to ${a?.bridgeMinutes ?? 3} minutes count too.`}
      action={<Segmented label="Range" value={range} options={RANGES} onChange={setRange} />}>
      {/* Each figure has one short line under it, so the four line up. */}
      <div className={`grid grid-cols-2 gap-x-4 gap-y-5 lg:grid-cols-4 ${activity.loading ? "opacity-60" : ""}`}>
        <Figure label="On" value={a ? formatDuration(a.onMinutes) : "—"}
          note={a?.dutyCycle != null ? `${formatEffort(a.dutyCycle)} of ${formatDuration(a.periodMinutes)}` : " "} />
        <Figure label="Average a day" value={a?.averageOnMinutesPerDay != null ? formatDuration(a.averageOnMinutesPerDay) : "—"}
          note={`over the last ${RANGES.find(([k]) => k === range)?.[1]}`} />
        <Figure label="Hashrate while on" value={a?.hashrateWhileOn != null ? formatHashrate(a.hashrateWhileOn) : "—"}
          note={a?.hashrateWhileOn != null
            ? <span title="At that speed around the clock, at today's difficulty and reward"><EarningsText hashrate={a.hashrateWhileOn}
              difficulty={overview.data?.network?.difficulty} minerReward={Number(overview.data?.node?.miner_reward) || undefined} /> if on all day</span>
            : " "} />
        <Figure label="Blocks from that work" value={a ? `${formatInteger(a.foundBlocks)} of ${formatBlocks(a.expectedBlocks)}` : "—"}
          note={a?.luck != null ? `found of expected · luck ${formatEffort(a.luck)}` : "found of expected"} />
      </div>
      {a && (
        <div className="mt-5 border-t border-line pt-4">
          <div className="grid grid-cols-[auto_1fr] items-center gap-y-1.5" role="img"
            aria-label={`${formatDuration(a.onMinutes)} on in the last ${RANGES.find(([k]) => k === range)?.[1]}; the table below lists each day.`}>
            <div />
            {/* Hour marks at the start of 00, 06, 12 and 18, and 24 at the end, over the cells they belong to. */}
            <div className="label relative h-4" aria-hidden="true">
              {[0, 6, 12, 18, 24].map((hour) => (
                <span key={hour} className={`absolute top-0 ${hour === 24 ? "-translate-x-full" : ""}`} style={{ left: `${(hour / 24) * 100}%` }}>
                  {String(hour).padStart(2, "0")}
                </span>
              ))}
            </div>
            {days.map((row) => <DayRow key={row.day.getTime()} {...row} />)}
          </div>
          <div className="label mt-3 flex flex-wrap items-center gap-x-4 gap-y-1">
            <span>Darker: more of that hour on. Your time zone.{range === "90d" ? " The last 30 days are shown; the figures above cover 90." : ""}</span>
            <button type="button" onClick={() => setShowTable((v) => !v)} className="ml-auto text-xs text-ink-2 underline decoration-line underline-offset-2 hover:text-ink">
              {showTable ? "Hide table" : "Show as table"}
            </button>
            <a href={`/api/v1/activity.csv?${query}`} download className="text-xs text-ink-2 underline decoration-line underline-offset-2 hover:text-ink">
              Download as CSV
            </a>
          </div>
          {showTable && (
            <div className="mt-2 max-h-64 overflow-auto rounded-lg border border-line">
              <table className="tbl">
                <thead><tr><th>Day</th><th className="r">On</th><th>Hours</th></tr></thead>
                <tbody>
                  {[...days].reverse().map((row) => (
                    <tr key={row.day.getTime()}>
                      <td>{row.day.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "numeric" })}</td>
                      <td className="mono r">{formatDuration(row.total)}</td>
                      <td className="mono text-ink-2">{hourRanges(row.hours)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
