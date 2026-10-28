// When a rig was mining, placed in this browser's own hours and days (the API sends the stretches in UTC; see
// services/api/src/activity.js). Kept free of React so it can be tested on its own.

/**
 * Minutes on in each hour of each local day, for the `days` days up to and including the one `now` is in, newest last.
 * A stretch crossing an hour, a midnight or a daylight-saving change is split where it crosses.
 * @param {[string, string][]} stretches [start, end] ISO times
 * @param {number} days @param {Date} [now]
 * @returns {{ day: Date, hours: number[], total: number }[]} day: local midnight; hours: 24 values, 0 to 60 minutes
 */
export function onMinutesByHour(stretches, days, now = new Date()) {
  const first = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (days - 1));
  /** @type {{ day: Date, hours: number[], total: number }[]} */
  const rows = Array.from({ length: days }, (_, i) => ({ day: new Date(first.getFullYear(), first.getMonth(), first.getDate() + i), hours: Array(24).fill(0), total: 0 }));
  /** @param {Date} t */
  const rowOf = (t) => {
    const midnight = new Date(t.getFullYear(), t.getMonth(), t.getDate());
    return rows.find((r) => r.day.getTime() === midnight.getTime());
  };
  for (const [startText, endText] of stretches) {
    let t = new Date(Math.max(new Date(startText).getTime(), first.getTime()));
    const end = new Date(endText);
    while (t < end) {
      const nextHour = new Date(t.getFullYear(), t.getMonth(), t.getDate(), t.getHours() + 1);
      const stop = nextHour < end ? nextHour : end;
      const minutes = (stop.getTime() - t.getTime()) / 60_000;
      const row = rowOf(t);
      if (row) {
        row.hours[t.getHours()] = Math.min(60, row.hours[t.getHours()] + minutes);
        row.total += minutes;
      }
      t = stop;
    }
  }
  return rows;
}

/** Hours and minutes, short: "6 h 5 min", "45 min", "0 min". @param {number} minutes */
export function formatDuration(minutes) {
  const m = Math.round(minutes);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest ? `${h} h ${rest} min` : `${h} h`;
}
