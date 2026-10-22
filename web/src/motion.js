import { useRef, useSyncExternalStore } from "react";

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
 * The next replay state: after the range changes, the key moves on once the new range's data arrives (the old data stays
 * on screen, dimmed, until then). Refreshes of the same range keep the key, so a line is not drawn again on every poll.
 * @template T
 * @param {{ range: string, data: T, key: number, waiting: boolean }} state
 * @param {string} range
 * @param {T} data
 */
export function nextReplay(state, range, data) {
  if (range !== state.range) return { range, data, key: state.key, waiting: true };
  if (state.waiting && data !== state.data) return { range, data, key: state.key + 1, waiting: false };
  return state.data === data ? state : { ...state, data };
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
