import { useEffect, useSyncExternalStore } from "react";
import { accentVariables, parseHex } from "./accent.js";

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

// The colour theme, per browser like the mode; classic (the colours from before 1.0) when none is chosen. Applied before first paint by public/theme-init.js too.
const PALETTE_KEY = "xeldash.palette";
export const PALETTES = /** @type {const} */ (["classic", "ember", "glacier", "amethyst", "terminal"]);
/** @typedef {typeof PALETTES[number]} Palette */

/** @returns {Palette} */
function readPalette() {
  const value = document.documentElement.dataset.palette;
  return value === "ember" || value === "glacier" || value === "amethyst" || value === "terminal" ? value : "classic";
}

/** @param {Palette} palette */
export function setPalette(palette) {
  if (palette === "classic") delete document.documentElement.dataset.palette;
  else document.documentElement.dataset.palette = palette;
  try {
    if (palette === "classic") localStorage.removeItem(PALETTE_KEY);
    else localStorage.setItem(PALETTE_KEY, palette);
  } catch {
    // Applies to this page load only.
  }
  for (const listener of listeners) listener();
}

export function usePalette() {
  return useSyncExternalStore(subscribe, readPalette);
}

// A main colour of the person's own, on top of the colour theme (src/accent.js). Saved as the colour picked and the variables worked
// out from it, so public/theme-init.js can apply them before first paint without the colour maths.
const ACCENT_KEY = "xeldash.accent";
const ACCENT_VARS_KEY = "xeldash.accent-vars";

/** @returns {string | null} the colour picked, or null for the theme's own */
function readAccent() {
  return document.documentElement.dataset.accent === "custom" ? document.documentElement.dataset.accentColor ?? null : null;
}

/** @param {string | null} hex a colour, or null for the theme's own */
export function setAccent(hex) {
  if (hex !== null && !parseHex(hex)) return;
  const root = document.documentElement;
  const vars = hex ? accentVariables(hex) : null;
  for (const name of ["--custom-accent", "--custom-accent-soft", "--custom-accent-ink", "--custom-accent-dark", "--custom-accent-soft-dark", "--custom-accent-ink-dark"]) {
    if (vars) root.style.setProperty(name, vars[name]);
    else root.style.removeProperty(name);
  }
  if (hex) {
    root.dataset.accent = "custom";
    root.dataset.accentColor = hex;
  } else {
    delete root.dataset.accent;
    delete root.dataset.accentColor;
  }
  try {
    if (hex && vars) {
      localStorage.setItem(ACCENT_KEY, hex);
      localStorage.setItem(ACCENT_VARS_KEY, JSON.stringify(vars));
    } else {
      localStorage.removeItem(ACCENT_KEY);
      localStorage.removeItem(ACCENT_VARS_KEY);
    }
  } catch {
    // Applies to this page load only.
  }
  for (const listener of listeners) listener();
}

export function useAccent() {
  return useSyncExternalStore(subscribe, readAccent);
}

/**
 * Keeps the browser's theme colour (a phone's status bar, an installed app's title bar) the colour of the top bar: index.html's
 * light and dark defaults follow the system only, not a mode or colour theme chosen under Settings.
 */
export function useThemeColor() {
  const theme = useTheme();
  const palette = usePalette();
  useEffect(() => {
    const apply = () => {
      const panel = getComputedStyle(document.documentElement).getPropertyValue("--panel").trim();
      if (!panel) return;
      for (const meta of document.querySelectorAll("meta[name=theme-color]")) meta.setAttribute("content", panel);
    };
    apply();
    const system = window.matchMedia?.("(prefers-color-scheme: dark)");
    system?.addEventListener("change", apply);
    return () => system?.removeEventListener("change", apply);
  }, [theme, palette]);
}
