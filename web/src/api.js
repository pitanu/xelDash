import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { getLiveState, subscribeLive } from "./live.js";

// Polling is the fallback; with live updates it only catches minute-bucket stats.
const POLL_MS = 15_000;
const LIVE_POLL_MS = 60_000;
// Coalesces a burst of live messages (new block, block submitted, block final) into one fetch.
const LIVE_DEBOUNCE_MS = 400;
// The network's blocks (side blocks too, in XELIS's DAG) can come every few seconds; the chain tip is refetched at most this often.
const TIP_MIN_MS = 10_000;

/** @typedef {{ data: any, error: (Error & { code?: string }) | null, loading: boolean }} Polled */

/** Requests under way, by path: panels that ask for the same thing at the same moment (a live update) share one. */
/** @type {Map<string, Promise<any>>} */
const inFlight = new Map();

/** @param {string} path */
async function fetchJson(path) {
  const response = await fetch(path, { headers: { accept: "application/json" } });
  if (!response.ok) {
    // Keep the API's reason ("node_unavailable", ...) so a page can say what is actually wrong.
    const body = await response.json().catch(() => null);
    const error = /** @type {Error & { code?: string }} */ (new Error(`${path} returned HTTP ${response.status}`));
    error.code = typeof body?.error === "string" ? body.error : undefined;
    throw error;
  }
  return response.json();
}

/** @param {string} path @param {{ fresh?: boolean }} [options] fresh: a new request even if one is under way */
function getJson(path, { fresh = false } = {}) {
  const shared = fresh ? undefined : inFlight.get(path);
  if (shared) return shared;
  const request = fetchJson(path).finally(() => {
    if (inFlight.get(path) === request) inFlight.delete(path);
  });
  inFlight.set(path, request);
  return request;
}

export function useLive() {
  return useSyncExternalStore(subscribeLive, getLiveState);
}

/**
 * Fetch a JSON endpoint, refetch on live updates, and poll as a fallback. While a refetch is
 * in flight the previous data stays, so views hold their frame instead of flashing.
 * `intervalMs` polls faster than usual, for progress that should feel live; as a function of the latest data, only while that data
 * calls for it (a download under way, a cluster to watch), and at the usual pace otherwise. `everyBlock` also
 * refetches on every new block of the network, for what follows the chain tip (status, overview);
 * everything else waits for an event (our blocks, node changes) or the next poll.
 * @param {string | null} path
 * @param {{ intervalMs?: number | ((data: any) => number | undefined), everyBlock?: boolean }} [options]
 */
export function usePolled(path, { intervalMs, everyBlock = false } = {}) {
  const [state, setState] = useState(/** @type {Polled} */ ({ data: null, error: null, loading: true }));
  const live = useLive();
  const current = useRef(path);
  const loadRef = useRef((/** @type {{ fresh?: boolean }} */ _options = {}) => {});

  useEffect(() => {
    current.current = path;
    if (!path) return undefined;
    let cancelled = false;
    const load = (/** @type {{ fresh?: boolean }} */ options = {}) => {
      setState((previous) => ({ ...previous, loading: true }));
      getJson(path, options)
        .then((data) => {
          if (!cancelled && current.current === path) setState({ data, error: null, loading: false });
        })
        .catch((error) => {
          if (!cancelled) setState((previous) => ({ ...previous, error, loading: false }));
        });
    };
    loadRef.current = load;
    load();
    return () => {
      cancelled = true;
    };
  }, [path]);

  // Only the polling rate follows the live state and the data; changing it must not restart a fetch.
  const every = (typeof intervalMs === "function" ? intervalMs(state.data) : intervalMs) ?? (live.status === "live" ? LIVE_POLL_MS : POLL_MS);
  useEffect(() => {
    if (!path) return undefined;
    const timer = setInterval(() => loadRef.current(), every);
    return () => clearInterval(timer);
  }, [path, every]);

  useEffect(() => {
    if (live.version === 0) return undefined;
    const timer = setTimeout(() => loadRef.current(), LIVE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [live.version]);

  // A new block refetches at most every TIP_MIN_MS, measured from the last time it did, so a fast run of blocks ends with the latest.
  const tipLoaded = useRef(0);
  const tip = everyBlock ? live.tip : 0;
  useEffect(() => {
    if (tip === 0) return undefined;
    const wait = Math.max(LIVE_DEBOUNCE_MS, tipLoaded.current + TIP_MIN_MS - Date.now());
    const timer = setTimeout(() => {
      tipLoaded.current = Date.now();
      loadRef.current();
    }, wait);
    return () => clearTimeout(timer);
  }, [tip]);

  // reload() refetches now, for example after a change made from the page: never an answer from before it.
  return { ...state, reload: () => loadRef.current({ fresh: true }) };
}
