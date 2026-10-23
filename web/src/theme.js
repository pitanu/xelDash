import { useSyncExternalStore } from "react";

// Light, dark, or "system" (follow the operating system). Kept per browser; the saved choice
// is applied before first paint by public/theme-init.js.
const KEY = "xeldash.theme";
/** @type {Set<() => void>} */
const listeners = new Set();

/** @returns {"system" | "light" | "dark"} */
function read() {
  const value = document.documentElement.dataset.theme;
  return value === "light" || value === "dark" ? value : "system";
}

/** @param {"system" | "light" | "dark"} theme */
export function setTheme(theme) {
  if (theme === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
  try {
    if (theme === "system") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, theme);
  } catch {
    // Applies to this page load only.
  }
  for (const listener of listeners) listener();
}

/** @param {() => void} listener */
function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useTheme() {
  return useSyncExternalStore(subscribe, read);
}

// The colour theme, per browser like the mode; ember when none is chosen. Applied before first paint by public/theme-init.js too.
const PALETTE_KEY = "xeldash.palette";
export const PALETTES = /** @type {const} */ (["ember", "glacier", "amethyst", "terminal"]);
/** @typedef {typeof PALETTES[number]} Palette */

/** @returns {Palette} */
function readPalette() {
  const value = document.documentElement.dataset.palette;
  return value === "glacier" || value === "amethyst" || value === "terminal" ? value : "ember";
}

/** @param {Palette} palette */
export function setPalette(palette) {
  if (palette === "ember") delete document.documentElement.dataset.palette;
  else document.documentElement.dataset.palette = palette;
  try {
    if (palette === "ember") localStorage.removeItem(PALETTE_KEY);
    else localStorage.setItem(PALETTE_KEY, palette);
  } catch {
    // Applies to this page load only.
  }
  for (const listener of listeners) listener();
}

export function usePalette() {
  return useSyncExternalStore(subscribe, readPalette);
}
