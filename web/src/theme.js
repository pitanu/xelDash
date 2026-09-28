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
