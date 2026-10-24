import { useEffect, useRef, useState } from "react";
import {
  MAX_SOUND_SECONDS, clearCustomSound, loadCustomSound, playBlockSound, saveCustomSound, setBlockSound, useBlockSound, useCustomSoundName,
} from "../block-sound.js";
import { SettingBlock, Switch } from "./ui.jsx";

/**
 * Per-browser choice of a sound when a block is found: the chime or the person's own (kept in this browser, never uploaded).
 * `visitor`: a public server's visitor, who hears of every block found here and has no alerts to set up.
 * @param {{ visitor?: boolean, row?: boolean }} props
 */
export default function BlockSoundSetting({ visitor = false, row = false }) {
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
    <SettingBlock row={row} title="Sound when a block is found"
      subtitle={`Plays when ${visitor ? "a block is found on this server" : "one of your miners finds a block"} while this page is open. Saved in this browser only.`}
      aside={<Switch checked={on} label="Play a sound when a block is found" onChange={(next) => {
        setBlockSound(next);
        if (next) void playBlockSound();
      }} />}>
      <div className="flex flex-wrap items-center gap-4">
        <button type="button" onClick={() => void playBlockSound()}
          className="btn btn-sm">
          Play a test sound
        </button>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-3 text-sm">
        <span className="text-ink-2">Sound:</span>
        <span className="text-ink">{custom ? <>Your own: <span className="break-all">{custom}</span></> : "The built-in chime"}</span>
        <label className="btn btn-sm">
          {custom ? "Choose another file" : "Use your own sound"}
          <input ref={input} type="file" accept="audio/*" className="sr-only" disabled={busy}
            onChange={(e) => void choose(e.target.files?.[0])} />
        </label>
        {custom && (
          <button type="button" onClick={() => { setError(null); void clearCustomSound(); }}
            className="btn btn-sm">
            Use the chime again
          </button>
        )}
      </div>
      {error && <p role="alert" className="mt-2 text-sm text-danger">{error}</p>}
      <p className="mt-2 text-xs text-ink-2">
        Your own sound: an audio file of at most 1 MB and {MAX_SOUND_SECONDS} seconds. It stays in this browser and is never sent to
        the server. Browsers only allow sound after you have clicked on the page once, so a tab left open without a click may stay
        silent.{visitor ? "" : " For when you are away, set up alerts below."}
      </p>
    </SettingBlock>
  );
}
