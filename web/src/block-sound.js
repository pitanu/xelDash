import { useSyncExternalStore } from "react";

// A short sound when a block is found, off unless chosen. Per browser, like the theme. Browsers
// only let a page make sound after the person has clicked or pressed a key on it once, so a tab
// opened and left alone may stay quiet until then.
//
// The sound is the built-in chime or one of the person's own: an audio file chosen in Settings and kept in this browser
// (IndexedDB), never sent to the server, so it is the same on a public server: one visitor's sound is theirs alone. It is played with
// the Web Audio API from the file's bytes, so the page's content security policy needs no opening for it.
const KEY = "xeldash.blockSound";
/** The largest sound file taken, and the longest sound: a chime, not a song. */
export const MAX_SOUND_BYTES = 1_048_576;
export const MAX_SOUND_SECONDS = 10;
const DB = "xeldash";
const STORE = "sounds";
const SOUND_KEY = "blockSound";

/** @type {Set<() => void>} */
const listeners = new Set();
let memory = false;
/** The chosen sound, also kept here when the browser stores nothing (a private window). @type {{ name: string, bytes: ArrayBuffer } | null} */
let custom = null;
let customLoaded = false;
/** @type {AudioBuffer | null} */
let customBuffer = null;
let version = 0;

function read() {
  try {
    return localStorage.getItem(KEY) === "on";
  } catch {
    return memory;
  }
}

function changed() {
  version++;
  for (const listener of listeners) listener();
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
  changed();
}

/** @param {() => void} listener */
function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useBlockSound() {
  return useSyncExternalStore(subscribe, read);
}

/** The own sound's file name, or null for the chime. */
export function useCustomSoundName() {
  useSyncExternalStore(subscribe, () => version);
  return custom?.name ?? null;
}

export function blockSoundEnabled() {
  return read();
}

/** @returns {Promise<IDBDatabase | null>} */
function openDb() {
  return new Promise((resolve) => {
    try {
      const request = indexedDB.open(DB, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(STORE);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

/** @param {"readonly" | "readwrite"} mode @param {(store: IDBObjectStore) => IDBRequest} action @returns {Promise<any>} */
async function withStore(mode, action) {
  const db = await openDb();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const request = action(db.transaction(STORE, mode).objectStore(STORE));
      request.onsuccess = () => resolve(request.result ?? null);
      request.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

/** Loads the own sound kept in this browser, once. */
export async function loadCustomSound() {
  if (customLoaded) return;
  customLoaded = true;
  const saved = await withStore("readonly", (store) => store.get(SOUND_KEY));
  if (saved && typeof saved.name === "string" && saved.bytes instanceof ArrayBuffer && saved.bytes.byteLength <= MAX_SOUND_BYTES) {
    custom = { name: saved.name.slice(0, 120), bytes: saved.bytes };
    changed();
  }
}

/**
 * Why a file cannot be the block sound, or null. `decode` turns its bytes into audio (the Web Audio API), and fails for anything that
 * is not audio, whatever its name or type says.
 * @param {{ name: string, size: number, type: string, arrayBuffer: () => Promise<ArrayBuffer> }} file
 * @param {(bytes: ArrayBuffer) => Promise<{ duration: number }>} decode
 * @returns {Promise<{ error: string } | { bytes: ArrayBuffer, duration: number }>}
 */
export async function checkSoundFile(file, decode) {
  if (file.size > MAX_SOUND_BYTES) return { error: `That file is ${(file.size / 1_048_576).toFixed(1)} MB; a sound may be at most 1 MB.` };
  if (file.type && !file.type.startsWith("audio/")) return { error: "That is not an audio file. Choose an MP3, WAV, OGG or similar." };
  const bytes = await file.arrayBuffer();
  let audio;
  try {
    // Decoding detaches the buffer it gets, so it gets a copy.
    audio = await decode(bytes.slice(0));
  } catch {
    return { error: "That file could not be played as audio." };
  }
  if (!(audio.duration > 0)) return { error: "That file could not be played as audio." };
  if (audio.duration > MAX_SOUND_SECONDS) {
    return { error: `That sound is ${Math.round(audio.duration)} seconds long; a block sound may be at most ${MAX_SOUND_SECONDS}.` };
  }
  return { bytes, duration: audio.duration };
}

/** @type {AudioContext | null} */
let context = null;

/** The page's audio, resumed; null where the browser has none or blocks sound for now. */
async function audioContext() {
  const AudioContextClass = window.AudioContext ?? /** @type {any} */ (window).webkitAudioContext;
  if (!AudioContextClass) return null;
  /** @type {AudioContext} */
  const audio = context ?? new AudioContextClass();
  context = audio;
  if (audio.state === "suspended") await audio.resume();
  return audio.state === "running" ? audio : null;
}

/**
 * Checks a file and keeps it as this browser's block sound. Returns the error to show, or null when it is saved.
 * @param {File} file
 */
export async function saveCustomSound(file) {
  const AudioContextClass = window.AudioContext ?? /** @type {any} */ (window).webkitAudioContext;
  if (!AudioContextClass) return "This browser cannot play sounds.";
  /** @type {AudioContext} */
  const audio = context ?? new AudioContextClass();
  context = audio;
  const checked = await checkSoundFile(file, (bytes) => audio.decodeAudioData(bytes));
  if ("error" in checked) return checked.error;
  custom = { name: file.name.slice(0, 120), bytes: checked.bytes };
  customBuffer = null;
  customLoaded = true;
  await withStore("readwrite", (store) => store.put({ name: custom?.name, bytes: checked.bytes }, SOUND_KEY));
  changed();
  return null;
}

/** Back to the chime. */
export async function clearCustomSound() {
  custom = null;
  customBuffer = null;
  await withStore("readwrite", (store) => store.delete(SOUND_KEY));
  changed();
}

/** Two rising notes. */
function chime(/** @type {AudioContext} */ audio) {
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
}

/** The block sound: this browser's own sound if one is chosen, the chime otherwise. Does nothing where the browser blocks sound. */
export async function playBlockSound() {
  try {
    await loadCustomSound();
    const audio = await audioContext();
    if (!audio) return false;
    if (custom) {
      customBuffer ??= await audio.decodeAudioData(custom.bytes.slice(0));
      const source = audio.createBufferSource();
      source.buffer = customBuffer;
      source.connect(audio.destination);
      source.start();
      // Never longer than a block sound may be, whatever the file turns out to hold.
      source.stop(audio.currentTime + MAX_SOUND_SECONDS);
      return true;
    }
    chime(audio);
    return true;
  } catch {
    return false;
  }
}

