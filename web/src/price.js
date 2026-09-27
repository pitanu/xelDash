import { useEffect, useState, useSyncExternalStore } from "react";

// The XEL price is a per-browser display choice: off, or one currency. Off by default, so the
// server only contacts CoinGecko when someone asks for the price.
const KEY = "xeldash.priceCurrency";
const REFRESH_MS = 5 * 60_000;

/** Currency names for the picker, in the API's order. */
export const CURRENCY_NAMES = /** @type {Record<string, string>} */ ({
  usd: "US dollar", eur: "Euro", jpy: "Japanese yen", gbp: "British pound", cny: "Chinese yuan",
  aud: "Australian dollar", cad: "Canadian dollar", chf: "Swiss franc", krw: "South Korean won",
  inr: "Indian rupee", btc: "Bitcoin",
});

/** @type {Set<() => void>} */
const listeners = new Set();
// Used when storage is unavailable (private mode), for this page load only.
let memory = "";

function read() {
  try {
    return localStorage.getItem(KEY) ?? "";
  } catch {
    return memory;
  }
}

/** @param {string} currency "" for off */
export function setPriceCurrency(currency) {
  memory = currency;
  try {
    if (currency) localStorage.setItem(KEY, currency);
    else localStorage.removeItem(KEY);
  } catch {
    // Kept in memory instead.
  }
  for (const listener of listeners) listener();
}

/** @param {() => void} listener */
function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The chosen currency, or "" when the price is off. */
export function usePriceCurrency() {
  return useSyncExternalStore(subscribe, read);
}

/**
 * The XEL price in the chosen currency, refreshed every 5 minutes; null while off or
 * unavailable. `enabled` is false when the server has the price turned off.
 */
export function usePrice() {
  const currency = usePriceCurrency();
  const [state, setState] = useState(/** @type {{ enabled: boolean, reason?: string, network?: string, price: any }} */ ({ enabled: true, price: null }));
  useEffect(() => {
    if (!currency) {
      setState((s) => ({ ...s, price: null }));
      return undefined;
    }
    let cancelled = false;
    const load = () => {
      fetch(`/api/v1/price?currency=${encodeURIComponent(currency)}`)
        .then((response) => (response.ok ? response.json() : null))
        .then((body) => {
          if (!cancelled && body) setState({ enabled: body.enabled, reason: body.reason, network: body.network, price: body.price });
        })
        .catch(() => {});
    };
    load();
    const timer = setInterval(load, REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [currency]);
  return { currency, ...state };
}

/**
 * A money amount in a currency, with sensible precision for small prices.
 * @param {number} value @param {string} currency
 */
export function formatMoney(value, currency) {
  if (currency === "btc") return `₿${value.toLocaleString(undefined, { maximumSignificantDigits: 4 })}`;
  const digits = value !== 0 && Math.abs(value) < 1 ? { maximumSignificantDigits: 4 } : { minimumFractionDigits: 2, maximumFractionDigits: 2 };
  return new Intl.NumberFormat(undefined, { style: "currency", currency: currency.toUpperCase(), ...digits }).format(value);
}
