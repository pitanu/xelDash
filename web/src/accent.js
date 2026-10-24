// A main (accent) colour of the person's own, on top of the chosen colour theme. From the one colour they pick, a light-mode and a
// dark-mode version are worked out in OKLCH (same hue, lightness moved into a band that reads well on that mode's background), with a
// soft tint for backgrounds and a text colour for on top of it. Kept apart from React so it can be tested on its own; theme.js
// applies it, and public/theme-init.js applies the saved one before first paint.

/** @param {number} c 0-1 sRGB channel */
const toLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
/** @param {number} c linear channel */
const toSrgb = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

/** "#rrggbb" (or "#rgb") to 0-1 sRGB, or null. @param {string} hex */
export function parseHex(hex) {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(hex).trim());
  if (!m) return null;
  const h = m[1].length === 3 ? m[1].split("").map((c) => c + c).join("") : m[1];
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
}

/** @param {number[]} rgb 0-1 sRGB */
function toHex(rgb) {
  return `#${rgb.map((c) => Math.round(Math.min(1, Math.max(0, c)) * 255).toString(16).padStart(2, "0")).join("")}`;
}

/** sRGB to OKLab. @param {number[]} rgb */
function oklab([r, g, b]) {
  const [lr, lg, lb] = [r, g, b].map(toLinear);
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}

/** OKLab to sRGB (may be out of gamut). @param {number[]} lab */
function fromOklab([L, a, b]) {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s].map(toSrgb);
}

/** OKLCH (lightness 0-1, chroma, hue in degrees) to "#rrggbb", lowering chroma until it fits sRGB. @param {number} L @param {number} C @param {number} h */
function fromOklch(L, C, h) {
  const rad = (h * Math.PI) / 180;
  for (let c = C; c >= 0; c -= 0.005) {
    const rgb = fromOklab([L, c * Math.cos(rad), c * Math.sin(rad)]);
    if (rgb.every((v) => v >= -0.001 && v <= 1.001)) return toHex(rgb);
  }
  return toHex(fromOklab([L, 0, 0]));
}

/** @param {string} hex */
function oklch(hex) {
  const rgb = /** @type {number[]} */ (parseHex(hex));
  const [L, a, b] = oklab(rgb);
  return { L, C: Math.hypot(a, b), h: ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360 };
}

/** WCAG relative luminance. @param {string} hex */
function luminance(hex) {
  const [r, g, b] = /** @type {number[]} */ (parseHex(hex)).map(toLinear);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio of two colours (1 to 21). @param {string} a @param {string} b */
export function contrast(a, b) {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

/** How different two colours look, as OKLab ΔE ×100 (under about 15 they are hard to tell apart). @param {string} a @param {string} b */
export function difference(a, b) {
  const p = oklab(/** @type {number[]} */ (parseHex(a)));
  const q = oklab(/** @type {number[]} */ (parseHex(b)));
  return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) * 100;
}

// The page backgrounds the accent sits on (light: the Classic page, about as dark as any theme's; dark: the same in every theme), and the
// lightness bands that read well on them.
export const BACKGROUNDS = { light: "#eae9e4", dark: "#0d0d0d" };
const BANDS = { light: [0.42, 0.6], dark: [0.68, 0.82] };

/**
 * The accent for one mode from the colour picked: same hue, lightness moved into the mode's band (and further, until the accent has
 * at least 3:1 contrast with the background), a soft tint of it for backgrounds, and white or near-black text for on top of it.
 * @param {string} hex @param {"light" | "dark"} mode
 * @returns {{ accent: string, soft: string, ink: string }}
 */
export function accentFor(hex, mode) {
  const { L, C, h } = oklch(hex);
  const [low, high] = BANDS[mode];
  let lightness = Math.min(high, Math.max(low, L));
  let accent = fromOklch(lightness, C, h);
  for (let i = 0; i < 40 && contrast(accent, BACKGROUNDS[mode]) < 3; i++) {
    lightness += mode === "light" ? -0.01 : 0.01;
    accent = fromOklch(lightness, C, h);
  }
  const soft = mode === "light" ? fromOklch(0.94, Math.min(C, 0.12) * 0.35, h) : fromOklch(0.27, Math.min(C, 0.12) * 0.55, h);
  const ink = contrast(accent, "#ffffff") >= contrast(accent, "#111111") ? "#ffffff" : "#111111";
  return { accent, soft, ink };
}

/**
 * The colours the theme sets when the person picked their own accent: --custom-* for light and dark, which index.css uses.
 * @param {string} hex @returns {Record<string, string>}
 */
export function accentVariables(hex) {
  const light = accentFor(hex, "light");
  const dark = accentFor(hex, "dark");
  return {
    "--custom-accent": light.accent, "--custom-accent-soft": light.soft, "--custom-accent-ink": light.ink,
    "--custom-accent-dark": dark.accent, "--custom-accent-soft-dark": dark.soft, "--custom-accent-ink-dark": dark.ink,
  };
}
