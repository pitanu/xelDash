import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { getLiveState, subscribeLive } from "./live.js";

// Polling is the fallback; with live updates it only catches minute-bucket stats.
const POLL_MS = 15_000;
const LIVE_POLL_MS = 60_000;
// Coalesces a burst of live messages (new block, block submitted, block final) into one fetch.
const LIVE_DEBOUNCE_MS = 400;

/** @param {string} path */
async function getJson(path) {
  const response = await fetch(path, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`${path} returned HTTP ${response.status}`);
  return response.json();
}

export function useLive() {
  return useSyncExternalStore(subscribeLive, getLiveState);
}

/**
 * Fetch a JSON endpoint, refetch on live updates, and poll as a fallback. While a refetch is
 * in flight the previous data stays, so views hold their frame instead of flashing.
 * @param {string | null} path
 */
export function usePolled(path) {
  const [state, setState] = useState({ data: null, error: null, loading: true });
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
    const timer = setInterval(() => loadRef.current(), live.status === "live" ? LIVE_POLL_MS : POLL_MS);
    return () => clearInterval(timer);
  }, [path, live.status]);

  useEffect(() => {
    if (live.version === 0) return undefined;
    const timer = setTimeout(() => loadRef.current(), LIVE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [live.version]);

  return state;
}
