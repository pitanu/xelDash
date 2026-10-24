// One shared WebSocket to /api/v1/live per tab. Messages are hints to refetch; the REST
// endpoints stay the source of truth, so a dropped socket only means slower updates.

const MAX_BACKOFF_MS = 30_000;

/**
 * `version` moves on anything that may change what a page shows (our blocks, node changes, a reconnect); `tip` moves on every new
 * block of the network, every few seconds on mainnet, which only changes the chain tip (height, difficulty, node status).
 * @typedef {{ status: "connecting" | "live" | "offline", version: number, tip: number }} LiveState
 */

/** @type {LiveState} */
let state = { status: "connecting", version: 0, tip: 0 };
/** @type {Set<() => void>} */
const listeners = new Set();
let backoff = 1_000;
let started = false;

/** @param {Partial<LiveState>} next */
function update(next) {
  state = { ...state, ...next };
  for (const listener of listeners) listener();
}

function connect() {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  let socket;
  try {
    socket = new WebSocket(`${protocol}//${window.location.host}/api/v1/live`);
  } catch {
    retry();
    return;
  }
  socket.onopen = () => {
    backoff = 1_000;
    // Anything may have changed while we were offline.
    update({ status: "live", version: state.version + 1 });
  };
  socket.onmessage = (event) => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    if (message.type === "block") update({ tip: state.tip + 1 });
    if (message.type === "event") update({ version: state.version + 1 });
    if (message.type === "event" && message.eventType === "block_submitted") for (const listener of blockListeners) listener();
  };
  socket.onclose = () => {
    update({ status: "offline" });
    retry();
  };
}

function retry() {
  setTimeout(connect, backoff);
  backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
}

/** The one live connection, opened by whichever subscriber comes first. */
function start() {
  if (started) return;
  started = true;
  connect();
}

/** @param {() => void} listener */
export function subscribeLive(listener) {
  start();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getLiveState() {
  return state;
}

/** @type {Set<() => void>} */
const blockListeners = new Set();

/** Called when one of our miners finds a block (not for every block on the network). @param {() => void} listener */
export function subscribeBlockFound(listener) {
  // Opens the connection too: the block notice must not depend on another part of the page having opened it.
  start();
  blockListeners.add(listener);
  return () => {
    blockListeners.delete(listener);
  };
}
