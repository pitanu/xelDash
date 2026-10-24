import { PALETTES, setPalette, setTheme, usePalette, useTheme } from "../theme.js";
import { Segmented } from "./ui.jsx";

const MODES = /** @type {const} */ ([["system", "System"], ["light", "Light"], ["dark", "Dark"]]);

// Each colour theme's name, its character, and the colours its preview shows: background, panel and accent, light then dark.
const THEMES = /** @type {Record<typeof PALETTES[number], [string, string, string, string, string, string, string, string]>} */ ({
  ember: ["Ember", "warm", "#f9f9f7", "#faf6f1", "#c2410c", "#0d0d0d", "#1c1815", "#ff8a4c"],
  glacier: ["Glacier", "cool", "#f9f9f7", "#f7f9fc", "#1d5fd1", "#0d0d0d", "#111a28", "#6ea8ff"],
  amethyst: ["Amethyst", "soft", "#f9f9f7", "#f9f7fc", "#6d3fd1", "#0d0d0d", "#18141f", "#b496ff"],
  terminal: ["Terminal", "neutral", "#f9f9f7", "#f8f8f8", "#157a3c", "#0d0d0d", "#0e0e0e", "#4ade80"],
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
 * Light, dark or the system's, and one of four colour themes, each with a light and a dark version. Per browser, so on a public
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
    </>
  );
}
