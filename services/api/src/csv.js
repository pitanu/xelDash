// CSV for the dashboard's "Download CSV" buttons. Worker names come from miners, so a name such as
// =HYPERLINK(...) would run as a formula when the file is opened in a spreadsheet; any cell that
// starts with a formula character gets a leading apostrophe, as OWASP advises.

const FORMULA_START = /^[=+\-@\t\r]/;

/** @param {unknown} value */
export function csvCell(value) {
  if (value === null || value === undefined) return "";
  let text = String(value);
  if (FORMULA_START.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** @param {unknown[][]} rows A header row, then data rows. */
export function toCsv(rows) {
  return `${rows.map((row) => row.map(csvCell).join(",")).join("\r\n")}\r\n`;
}

/** Atomic units (10^-8) as a decimal XEL string without floating point. @param {string | null} atomic */
export function atomicToXel(atomic) {
  if (atomic === null || atomic === undefined || atomic === "") return "";
  const padded = String(atomic).padStart(9, "0");
  return `${padded.slice(0, -8)}.${padded.slice(-8)}`;
}
