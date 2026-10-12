import { useSyncExternalStore } from "react";

// What kind of server this dashboard belongs to, read once from /api/v1/connect: its network (for the coin's name) and whether this
// visitor gets the public view of a public server (no node administration, no setup guide, no IP addresses).
// Until it is known, `known` is false: the operator-only parts of the page stay hidden rather than flash up for a public visitor.

/** @typedef {{ known: boolean, network: string | null, publicView: boolean }} ServerMode */

/** @type {ServerMode} */
let mode = { known: false, network: null, publicView: false };
let started = false;
/** @type {Set<() => void>} */
const listeners = new Set();

function load() {
  started = true;
  fetch("/api/v1/connect")
    .then((r) => (r.ok ? r.json() : null))
    .then((body) => {
      if (!body) return;
      mode = { known: true, network: typeof body.network === "string" ? body.network : null, publicView: body.view === "public" };
      for (const listener of listeners) listener();
    })
    .catch(() => {});
}

/** @param {() => void} listener */
function subscribe(listener) {
  listeners.add(listener);
  if (!started) load();
  return () => listeners.delete(listener);
}

/** @returns {ServerMode} */
export function useServerMode() {
  return useSyncExternalStore(subscribe, () => mode, () => mode);
}

/** True when the operator-only parts of the dashboard may be shown: the mode is known and this is not the public view. */
export function useOperatorView() {
  const { known, publicView } = useServerMode();
  return known && !publicView;
}
