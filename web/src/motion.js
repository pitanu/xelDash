import { useRef, useSyncExternalStore } from "react";
import { nextReplay } from "./replay.js";

// Chart animations: a line draws in, bars grow from the axis, dots appear. They are one-shot CSS animations (see index.css) that
// play when a chart first shows its data, when its range changes and for each new bar or dot, never on a refresh of the same
// data and never in a loop, so between them they cost nothing. They are skipped for people whose system asks for less motion,
// and can be turned off per browser; the choice is applied before first paint by public/theme-init.js.
const KEY = "xeldash.motion";
/** @type {Set<() => void>} */
const listeners = new Set();

function read() {
  return document.documentElement.dataset.motion !== "off";
}

/** @param {boolean} on */
export function setAnimations(on) {
  if (on) delete document.documentElement.dataset.motion;
  else document.documentElement.dataset.motion = "off";
  try {
    if (on) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, "off");
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

export function useAnimations() {
  return useSyncExternalStore(subscribe, read);
}

/**
 * A React key for marks that animate in once (a line): it changes when a new range's data arrives, which mounts them again.
 * @param {string} range @param {unknown} data
 */
export function useReplayKey(range, data) {
  const state = useRef({ range, data, key: 0, waiting: false });
  state.current = nextReplay(state.current, range, data);
  return state.current.key;
}
