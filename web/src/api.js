import { useEffect, useRef, useState } from "react";

const REFRESH_MS = 15_000;

/** @param {string} path */
async function getJson(path) {
  const response = await fetch(path, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`${path} returned HTTP ${response.status}`);
  return response.json();
}

/**
 * Fetch a JSON endpoint and refresh it every 15 seconds. While a refetch is in flight the
 * previous data stays, so views hold their frame instead of flashing.
 * @param {string | null} path
 */
export function usePolled(path) {
  const [state, setState] = useState({ data: null, error: null, loading: true });
  const current = useRef(path);

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
    load();
    const timer = setInterval(load, REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [path]);

  return state;
}
