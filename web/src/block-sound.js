import { useSyncExternalStore } from "react";

// A short chime when a block is found, off unless chosen. Per browser, like the theme. Browsers
// only let a page make sound after the person has clicked or pressed a key on it once, so a tab
// opened and left alone may stay quiet until then.
const KEY = "xeldash.blockSound";

/** @type {Set<() => void>} */
const listeners = new Set();
let memory = false;

function read() {
  try {
    return localStorage.getItem(KEY) === "on";
  } catch {
    return memory;
  }
}

/** @param {boolean} on */
export function setBlockSound(on) {
  memory = on;
  try {
    if (on) localStorage.setItem(KEY, "on");
    else localStorage.removeItem(KEY);
  } catch {
    // Kept in memory for this page load.
  }
  for (const listener of listeners) listener();
}

export function useBlockSound() {
  return useSyncExternalStore((listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }, read);
}

export function blockSoundEnabled() {
  return read();
}

/** @type {AudioContext | null} */
let context = null;

/** Two rising notes. Does nothing where the browser blocks sound. */
export async function playChime() {
  try {
    const AudioContextClass = window.AudioContext ?? /** @type {any} */ (window).webkitAudioContext;
    if (!AudioContextClass) return false;
    /** @type {AudioContext} */
    const audio = context ?? new AudioContextClass();
    context = audio;
    if (audio.state === "suspended") await audio.resume();
    if (audio.state !== "running") return false;
    const start = audio.currentTime;
    for (const [frequency, offset] of [[659.25, 0], [987.77, 0.16]]) {
      const oscillator = audio.createOscillator();
      const gain = audio.createGain();
      oscillator.type = "sine";
      oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(0.0001, start + offset);
      gain.gain.exponentialRampToValueAtTime(0.18, start + offset + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + offset + 0.7);
      oscillator.connect(gain).connect(audio.destination);
      oscillator.start(start + offset);
      oscillator.stop(start + offset + 0.75);
    }
    return true;
  } catch {
    return false;
  }
}
