// Counting a tile's number up (see CountUp in components/ui.jsx). Tile values are text formatted in the browser's language
// ("8,242,347", "7.76 KH/s", "118%", in Finnish "8 242 347" and "7,76 KH/s"), so the number is found with that language's
// separators and written back the same way, with the same decimals and the text around it. Kept apart from React so it can be
// tested on its own.

/** @param {string} text */
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The first number in a formatted value, and how it is written; null when there is none ("—").
 * @param {string} text @param {string | undefined} [locale]
 * @returns {{ before: string, after: string, value: number, decimals: number, grouped: boolean } | null}
 */
export function numberIn(text, locale) {
  const parts = new Intl.NumberFormat(locale).formatToParts(12345.6);
  const group = parts.find((p) => p.type === "group")?.value ?? ",";
  const decimal = parts.find((p) => p.type === "decimal")?.value ?? ".";
  const match = new RegExp(`^(\\D*?)(\\d(?:[\\d${escape(group)}]*\\d)?(?:${escape(decimal)}\\d+)?)([\\s\\S]*)$`).exec(text);
  if (!match) return null;
  const [, before, number, after] = match;
  const [whole, fraction = ""] = number.split(decimal);
  const value = Number(`${whole.split(group).join("")}.${fraction || "0"}`);
  if (!Number.isFinite(value)) return null;
  return { before, after, value, decimals: fraction.length, grouped: whole.includes(group) };
}

/**
 * `value` written the way `shape`'s number was.
 * @param {number} value @param {NonNullable<ReturnType<typeof numberIn>>} shape @param {string | undefined} [locale]
 */
export function writeLike(value, shape, locale) {
  const number = new Intl.NumberFormat(locale, {
    minimumFractionDigits: shape.decimals, maximumFractionDigits: shape.decimals, useGrouping: shape.grouped,
  }).format(value);
  return `${shape.before}${number}${shape.after}`;
}

/** Fast at first, settling at the end. @param {number} t 0 to 1 */
export const easeOut = (t) => 1 - (1 - t) ** 3;
