// The block calendar's weeks, in this browser's own days (the API counts blocks by the time zone the browser sends; see
// services/api/src/block-days.js). Kept free of React so it can be tested on its own.

/** "2026-10-31" for a local date. @param {Date} d */
export function localDayKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * The `days` local days up to and including today, as weeks of seven from Monday, oldest first. Days before the range (in the
 * first week) and after today (in the last) are null, so every week is one column of the calendar.
 * @param {{ day: string, blocks: number, orphaned: number }[]} found the days with blocks, by local date
 * @param {number} days @param {Date} [now]
 * @returns {({ day: Date, key: string, blocks: number, orphaned: number } | null)[][]}
 */
export function calendarWeeks(found, days, now = new Date()) {
  const byKey = new Map(found.map((f) => [f.day, f]));
  const first = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (days - 1));
  const lead = (first.getDay() + 6) % 7; // Monday is 0
  /** @type {({ day: Date, key: string, blocks: number, orphaned: number } | null)[]} */
  const cells = Array(lead).fill(null);
  for (let i = 0; i < days; i++) {
    const day = new Date(first.getFullYear(), first.getMonth(), first.getDate() + i);
    const key = localDayKey(day);
    cells.push({ day, key, blocks: byKey.get(key)?.blocks ?? 0, orphaned: byKey.get(key)?.orphaned ?? 0 });
  }
  while (cells.length % 7) cells.push(null);
  return Array.from({ length: cells.length / 7 }, (_, w) => cells.slice(w * 7, w * 7 + 7));
}
