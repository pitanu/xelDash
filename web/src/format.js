const HASH_UNITS = ["H/s", "KH/s", "MH/s", "GH/s", "TH/s"];
const COMPACT_UNITS = ["", "K", "M", "G", "T", "P"];
// XELIS amounts are integers in atomic units, 8 decimal places.
export const XEL_DECIMALS = 8;

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

/** The coin's symbol on a network: XEL on mainnet, XET on testnet and devnet. @param {string | null | undefined} network */
export function coinSymbol(network) {
  return network === "mainnet" ? "XEL" : "XET";
}

/** @param {string | null | undefined} atomic @param {string} [symbol] */
export function formatXel(atomic, symbol = "XEL") {
  if (atomic === null || atomic === undefined) return "—";
  const padded = atomic.padStart(XEL_DECIMALS + 1, "0");
  const whole = padded.slice(0, -XEL_DECIMALS);
  const fraction = padded.slice(-XEL_DECIMALS).replace(/0+$/, "");
  // The decimal mark of the viewer's language, like the whole part's grouping (1,5 in Finnish, 1.5 in English).
  const mark = (0.5).toLocaleString().charAt(1);
  return `${Number(whole).toLocaleString()}${fraction ? `${mark}${fraction}` : ""} ${symbol}`;
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
  const days = Math.floor(seconds / 86400);
  return `${days} ${days === 1 ? "day" : "days"} ago`;
}

/** @param {string} iso */
export function formatTime(iso) {
  return new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

/** @param {string} value @param {number} [keep] */
export function shorten(value, keep = 8) {
  return value.length <= keep * 2 + 1 ? value : `${value.slice(0, keep)}…${value.slice(-keep)}`;
}

export const RANGES = ["6h", "24h", "7d", "30d", "1y"];

/** Bucket size for chart subtitles: "5-minute", "1-hour", "1-day". @param {number} seconds */
export function formatBucket(seconds) {
  if (seconds % 86400 === 0) return `${seconds / 86400}-day`;
  if (seconds % 3600 === 0) return `${seconds / 3600}-hour`;
  return `${seconds / 60}-minute`;
}

/** Effort (1 = the work expected for one block) as a percentage. @param {number} effort */
export function formatEffort(effort) {
  const pct = effort * 100;
  return `${pct < 10 ? pct.toFixed(1) : Math.round(pct).toLocaleString()}%`;
}

/**
 * Disk space the way the operating system shows it (Windows Explorer, Finder and df count in 1024s and
 * call them GB), so the numbers can be compared with what the person sees there. @param {number | null | undefined} bytes
 */
export function formatDiskBytes(bytes) {
  if (bytes === null || bytes === undefined) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let n = bytes;
  let unit = 0;
  while (n >= 1024 && unit < units.length - 1) {
    n /= 1024;
    unit += 1;
  }
  return `${n.toLocaleString(undefined, { maximumFractionDigits: unit >= 3 ? 1 : 0 })} ${units[unit]}`;
}

/** File and disk sizes in decimal units: "9,2 GB". @param {number | null | undefined} bytes */
export function formatBytes(bytes) {
  if (bytes === null || bytes === undefined) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let n = bytes;
  let unit = 0;
  while (n >= 1000 && unit < units.length - 1) {
    n /= 1000;
    unit += 1;
  }
  return `${n.toLocaleString(undefined, { maximumFractionDigits: unit >= 3 ? 1 : 0 })} ${units[unit]}`;
}
