import { setTheme, useTheme } from "../theme.js";
import { Card, Segmented } from "./ui.jsx";

const THEMES = /** @type {const} */ ([["system", "System"], ["light", "Light"], ["dark", "Dark"]]);

/** Per-browser choice of light or dark, or following the operating system. */
export default function ThemeSetting() {
  const theme = useTheme();
  return (
    <Card title="Theme" subtitle="Light or dark, or follow your system's setting. Saved in this browser only.">
      <Segmented label="Theme" value={theme} options={THEMES} onChange={setTheme} />
    </Card>
  );
}

const NEXT = /** @type {const} */ ({ system: "light", light: "dark", dark: "system" });
const ICONS = {
  system: "M3 4.5h10v6.5H3zM6 13.5h4M8 11v2.5",
  light: "M8 5a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM8 1.5v1.5M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1 1M11.6 11.6l1 1M3.4 12.6l1-1M11.6 4.4l1-1",
  dark: "M13 9.5A5.5 5.5 0 0 1 6.5 3 5.5 5.5 0 1 0 13 9.5z",
};
const NAMES = { system: "System", light: "Light", dark: "Dark" };

/** Header button that steps through system, light and dark. */
export function ThemeButton() {
  const theme = useTheme();
  const next = NEXT[theme];
  return (
    <button type="button" onClick={() => setTheme(next)} aria-label={`Theme: ${NAMES[theme]}. Switch to ${NAMES[next]}`}
      title={`Theme: ${NAMES[theme]} (click for ${NAMES[next]})`}
      className="rounded-md p-1.5 text-ink-2 hover:bg-wash hover:text-ink">
      <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
        <path d={ICONS[theme]} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </button>
  );
}
