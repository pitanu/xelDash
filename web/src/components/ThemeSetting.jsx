import { BACKGROUNDS, accentFor, difference } from "../accent.js";
import { PALETTES, setAccent, setPalette, setTheme, useAccent, usePalette, useTheme } from "../theme.js";
import { Segmented, Switch } from "./ui.jsx";

// The red for problems in light and dark (index.css), which an own colour should not be mistaken for.
const DANGER = { light: "#b3261e", dark: "#ff8a80" };
// Where the colour picker starts when one is first turned on: the accent of the theme in use.
const START = /** @type {Record<string, string>} */ ({ classic: "#2060b8", ember: "#c2410c", glacier: "#1d5fd1", amethyst: "#6d3fd1", terminal: "#157a3c" });

/**
 * A main colour of the person's own, on top of the colour theme: the picker, the light and dark versions worked out from it, and a
 * word when it comes close to the red used for problems or to the theme's highlight.
 */
function OwnColour() {
  const accent = useAccent();
  const palette = usePalette();
  const highlight = typeof window === "undefined" ? "" : getComputedStyle(document.documentElement).getPropertyValue("--gold").trim();
  const light = accent ? accentFor(accent, "light") : null;
  const dark = accent ? accentFor(accent, "dark") : null;
  const nearDanger = light && dark && (difference(light.accent, DANGER.light) < 15 || difference(dark.accent, DANGER.dark) < 15);
  const nearHighlight = light && /^#[0-9a-f]{6}$/i.test(highlight) && difference(light.accent, highlight) < 15;
  return (
    <div className="settings-row">
      <div className="txt">
        <b>Your own colour</b>
        <span>Replaces the theme's main colour (buttons, charts, the current tab) with one you pick. A light and a dark version are worked out from it, so it stays readable on both. Saved in this browser only.</span>
      </div>
      <Switch checked={Boolean(accent)} label="Use my own colour" onChange={(on) => setAccent(on ? START[palette] : null)} />
      {accent && light && dark && (
        <div className="flex min-w-0 basis-full flex-wrap items-center gap-4">
          <label className="flex items-center gap-2 text-[13px] text-ink-2">
            <input type="color" value={accent} onChange={(e) => setAccent(e.target.value)} aria-label="Main colour"
              className="h-10 w-14 cursor-pointer rounded-lg border border-line bg-bg p-1" />
            <span className="mono">{accent}</span>
          </label>
          <span className="flex items-center gap-2 text-[13px] text-ink-2" aria-label={`Light: ${light.accent}, dark: ${dark.accent}`}>
            <span className="grid h-8 w-12 place-items-center rounded-md border border-line" style={{ background: BACKGROUNDS.light }} title={`Light: ${light.accent}`}>
              <span className="h-3 w-8 rounded-full" style={{ background: light.accent }} />
            </span>
            <span className="grid h-8 w-12 place-items-center rounded-md border border-line" style={{ background: BACKGROUNDS.dark }} title={`Dark: ${dark.accent}`}>
              <span className="h-3 w-8 rounded-full" style={{ background: dark.accent }} />
            </span>
            light and dark
          </span>
          {(nearDanger || nearHighlight) && (
            <p className="label m-0 basis-full text-danger!">
              {nearDanger
                ? "This colour is close to the red used for problems and invalid shares, so the two may be hard to tell apart. A different colour will read better."
                : "This colour is close to the theme's highlight colour, which marks other things (blocks in the best share chart, stale shares), so the two may be hard to tell apart."}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

const MODES = /** @type {const} */ ([["system", "System"], ["light", "Light"], ["dark", "Dark"]]);

// Each colour theme's name, its character, and the colours its preview shows: background, panel and accent, light then dark.
const THEMES = /** @type {Record<typeof PALETTES[number], [string, string, string, string, string, string, string, string]>} */ ({
  classic: ["Classic", "original", "#eae9e4", "#ffffff", "#2060b8", "#0d0d0d", "#1a1a19", "#3987e5"],
  ember: ["Ember", "warm", "#ece7e1", "#ffffff", "#c2410c", "#0d0d0d", "#1c1815", "#ff8a4c"],
  glacier: ["Glacier", "cool", "#e6eaf1", "#ffffff", "#1d5fd1", "#0d0d0d", "#111a28", "#6ea8ff"],
  amethyst: ["Amethyst", "soft", "#e9e6ef", "#ffffff", "#6d3fd1", "#0d0d0d", "#18141f", "#b496ff"],
  terminal: ["Terminal", "neutral", "#e8e8e8", "#ffffff", "#157a3c", "#0d0d0d", "#0e0e0e", "#4ade80"],
});

/** One half of a theme card's preview: the page, a panel along the bottom and an accent bar. @param {{ bg: string, panel: string, accent: string }} props */
function Preview({ bg, panel, accent }) {
  return (
    <span className="flex items-end p-2.5" style={{ background: bg, boxShadow: `inset 0 -26px 0 ${panel}` }}>
      <span className="block h-2 w-3/5 rounded-full" style={{ background: accent }} />
    </span>
  );
}

/**
 * Light, dark or the system's, and one of five colour themes, each with a light and a dark version. Per browser, so on a public
 * server every visitor has their own.
 */
export default function ThemeSetting() {
  const theme = useTheme();
  const palette = usePalette();
  return (
    <>
      <div className="settings-row">
        <div className="txt"><b>Mode</b><span>System follows your device's light or dark setting.</span></div>
        <Segmented label="Mode" value={theme} options={MODES} onChange={setTheme} />
      </div>
      <div className="settings-row block!">
        <div className="txt mb-3"><b>Colour theme</b><span>Each theme has a light and a dark version.</span></div>
        <div className="theme-grid" role="group" aria-label="Colour theme">
          {PALETTES.map((id) => {
            const [label, note, lightBg, lightPanel, lightAccent, darkBg, darkPanel, darkAccent] = THEMES[id];
            return (
              <button key={id} type="button" className="theme-card" aria-pressed={palette === id} onClick={() => setPalette(id)}>
                <span aria-hidden="true" className="grid h-16 grid-cols-2 overflow-hidden rounded-[10px] border border-line">
                  <Preview bg={lightBg} panel={lightPanel} accent={lightAccent} />
                  <Preview bg={darkBg} panel={darkPanel} accent={darkAccent} />
                </span>
                <span className="flex w-full items-center justify-between">
                  <span className="font-semibold">{label}</span>
                  <span className="label">{note}</span>
                </span>
              </button>
            );
          })}
        </div>
      </div>
      <OwnColour />
    </>
  );
}
