import { playChime, setBlockSound, useBlockSound } from "../block-sound.js";
import { Card } from "./ui.jsx";

/** Per-browser choice of a chime when a block is found. */
export default function BlockSoundSetting() {
  const on = useBlockSound();
  return (
    <Card title="Block found sound"
      subtitle="Play a short chime when one of your miners finds a block while this page is open. Saved in this browser only.">
      <div className="flex flex-wrap items-center gap-4">
        <label className="flex items-center gap-2 text-sm text-ink">
          <input type="checkbox" checked={on} onChange={(e) => {
            setBlockSound(e.target.checked);
            if (e.target.checked) void playChime();
          }} />
          Play a sound
        </label>
        <button type="button" onClick={() => void playChime()}
          className="rounded-md border border-line px-3 py-1.5 text-sm text-ink hover:bg-wash">
          Play a test sound
        </button>
      </div>
      <p className="mt-2 text-xs text-ink-2">
        Browsers only allow sound after you have clicked on the page once, so a tab left open without a click may stay silent.
        For when you are away, set up alerts below.
      </p>
    </Card>
  );
}
