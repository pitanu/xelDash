import { useEffect, useRef, useState } from "react";
import {
  MAX_SOUND_SECONDS, clearCustomSound, loadCustomSound, playBlockSound, saveCustomSound, setBlockSound, useBlockSound, useCustomSoundName,
} from "../block-sound.js";
import { Card } from "./ui.jsx";

/** Per-browser choice of a sound when a block is found: the chime or the person's own (kept in this browser, never uploaded). */
export default function BlockSoundSetting() {
  const on = useBlockSound();
  const custom = useCustomSoundName();
  const [error, setError] = useState(/** @type {string | null} */ (null));
  const [busy, setBusy] = useState(false);
  const input = useRef(/** @type {HTMLInputElement | null} */ (null));
  useEffect(() => { void loadCustomSound(); }, []);

  /** @param {File | undefined} file */
  async function choose(file) {
    if (!file) return;
    setBusy(true);
    setError(await saveCustomSound(file));
    setBusy(false);
    if (input.current) input.current.value = "";
  }

  return (
    <Card title="Block found sound"
      subtitle="Play a sound when one of your miners finds a block while this page is open. Saved in this browser only.">
      <div className="flex flex-wrap items-center gap-4">
        <label className="flex items-center gap-2 text-sm text-ink">
          <input type="checkbox" checked={on} onChange={(e) => {
            setBlockSound(e.target.checked);
            if (e.target.checked) void playBlockSound();
          }} />
          Play a sound
        </label>
        <button type="button" onClick={() => void playBlockSound()}
          className="rounded-md border border-line px-3 py-1.5 text-sm text-ink hover:bg-wash">
          Play a test sound
        </button>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-3 text-sm">
        <span className="text-ink-2">Sound:</span>
        <span className="text-ink">{custom ? <>Your own: <span className="break-all">{custom}</span></> : "The built-in chime"}</span>
        <label className="cursor-pointer rounded-md border border-line px-3 py-1.5 text-ink hover:bg-wash">
          {custom ? "Choose another file" : "Use your own sound"}
          <input ref={input} type="file" accept="audio/*" className="sr-only" disabled={busy}
            onChange={(e) => void choose(e.target.files?.[0])} />
        </label>
        {custom && (
          <button type="button" onClick={() => { setError(null); void clearCustomSound(); }}
            className="rounded-md border border-line px-3 py-1.5 text-ink hover:bg-wash">
            Use the chime again
          </button>
        )}
      </div>
      {error && <p role="alert" className="mt-2 text-sm text-critical">{error}</p>}
      <p className="mt-2 text-xs text-ink-2">
        Your own sound: an audio file of at most 1 MB and {MAX_SOUND_SECONDS} seconds. It stays in this browser and is never sent to
        the server. Browsers only allow sound after you have clicked on the page once, so a tab left open without a click may stay
        silent. For when you are away, set up alerts below.
      </p>
    </Card>
  );
}
