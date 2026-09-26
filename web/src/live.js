// One shared WebSocket to /api/v1/live per tab. Messages are hints to refetch; the REST
// endpoints stay the source of truth, so a dropped socket only means slower updates.

const MAX_BACKOFF_MS = 30_000;

/** @typedef {{ status: "connecting" | "live" | "offline", version: number }} LiveState */

/** @type {LiveState} */
let state = { status: "connecting", version: 0 };
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
    if (message.type === "block" || message.type === "event") update({ version: state.version + 1 });
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

/** @param {() => void} listener */
export function subscribeLive(listener) {
  if (!started) {
    started = true;
    connect();
  }
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getLiveState() {
  return state;
}
