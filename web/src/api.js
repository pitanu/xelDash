import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { getLiveState, subscribeLive } from "./live.js";

// Polling is the fallback; with live updates it only catches minute-bucket stats.
const POLL_MS = 15_000;
const LIVE_POLL_MS = 60_000;
// Coalesces a burst of live messages (new block, block submitted, block final) into one fetch.
const LIVE_DEBOUNCE_MS = 400;

/** @typedef {{ data: any, error: (Error & { code?: string }) | null, loading: boolean }} Polled */

/** @param {string} path */
async function getJson(path) {
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

export function useLive() {
  return useSyncExternalStore(subscribeLive, getLiveState);
}

/**
 * Fetch a JSON endpoint, refetch on live updates, and poll as a fallback. While a refetch is
 * in flight the previous data stays, so views hold their frame instead of flashing.
 * `intervalMs` polls faster than usual, for progress that should feel live.
 * @param {string | null} path @param {{ intervalMs?: number }} [options]
 */
export function usePolled(path, { intervalMs } = {}) {
  const [state, setState] = useState(/** @type {Polled} */ ({ data: null, error: null, loading: true }));
  const live = useLive();
  const current = useRef(path);
  const loadRef = useRef(() => {});

  useEffect(() => {
    current.current = path;
    if (!path) return undefined;
    let cancelled = false;
    const load = () => {
      setState((previous) => ({ ...previous, loading: true }));
      getJson(path)
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

  // Only the polling rate follows the live state; changing it must not restart a fetch.
  useEffect(() => {
    if (!path) return undefined;
    const timer = setInterval(() => loadRef.current(), intervalMs ?? (live.status === "live" ? LIVE_POLL_MS : POLL_MS));
    return () => clearInterval(timer);
  }, [path, live.status, intervalMs]);

  useEffect(() => {
    if (live.version === 0) return undefined;
    const timer = setTimeout(() => loadRef.current(), LIVE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [live.version]);

  // reload() refetches now, for example after a change made from the page.
  return { ...state, reload: () => loadRef.current() };
}
