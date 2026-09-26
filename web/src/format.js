const HASH_UNITS = ["H/s", "KH/s", "MH/s", "GH/s", "TH/s"];
const COMPACT_UNITS = ["", "K", "M", "G", "T", "P"];
// XELIS amounts are integers in atomic units, 8 decimal places.
const XEL_DECIMALS = 8;

/** @param {string | number | null | undefined} value */
export function formatHashrate(value) {
  if (value === null || value === undefined) return "—";
  let n = Number(value);
  let unit = 0;
  while (n >= 1000 && unit < HASH_UNITS.length - 1) {
    n /= 1000;
    unit += 1;
  }
  return `${n.toLocaleString(undefined, { maximumFractionDigits: n >= 100 ? 0 : n >= 10 ? 1 : 2 })} ${HASH_UNITS[unit]}`;
}

/** @param {string | number | null | undefined} value */
export function formatCompact(value) {
  if (value === null || value === undefined) return "—";
  let n = Number(value);
  let unit = 0;
  while (n >= 1000 && unit < COMPACT_UNITS.length - 1) {
    n /= 1000;
    unit += 1;
  }
  return `${n.toLocaleString(undefined, { maximumFractionDigits: unit === 0 ? 0 : 1 })}${COMPACT_UNITS[unit]}`;
}

/** @param {string | number | null | undefined} value */
export function formatInteger(value) {
  if (value === null || value === undefined) return "—";
  return Number(value).toLocaleString();
}

/** @param {string | null | undefined} atomic */
export function formatXel(atomic) {
  if (atomic === null || atomic === undefined) return "—";
  const padded = atomic.padStart(XEL_DECIMALS + 1, "0");
  const whole = padded.slice(0, -XEL_DECIMALS);
  const fraction = padded.slice(-XEL_DECIMALS).replace(/0+$/, "");
  return `${Number(whole).toLocaleString()}${fraction ? `.${fraction}` : ""} XEL`;
}

/** @param {string | number | null | undefined} value */
export function formatDuration(value) {
  if (value === null || value === undefined) return "—";
  const seconds = Number(value);
  if (seconds < 90) return `${Math.round(seconds)} s`;
  if (seconds < 90 * 60) return `${Math.round(seconds / 60)} min`;
  if (seconds < 48 * 3600) return `${(seconds / 3600).toFixed(1)} h`;
  return `${(seconds / 86400).toFixed(1)} days`;
}

/** @param {string} iso */
export function formatAgo(iso) {
  const seconds = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} h ago`;
  return `${Math.floor(seconds / 86400)} days ago`;
}

/** @param {string} iso */
export function formatTime(iso) {
  return new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

/** @param {string} value @param {number} [keep] */
export function shorten(value, keep = 8) {
  return value.length <= keep * 2 + 1 ? value : `${value.slice(0, keep)}…${value.slice(-keep)}`;
}
