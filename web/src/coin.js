import { useSyncExternalStore } from "react";
import { coinSymbol } from "./format.js";

// The coin's name depends on the network: XEL on mainnet, XET on testnet and devnet. The dashboard learns the network once
// (from /api/v1/connect) and every amount follows it; until it is known, or if it cannot be read, amounts say XEL.
let symbol = "XEL";
let started = false;
/** @type {Set<() => void>} */
const listeners = new Set();

function load() {
  started = true;
  fetch("/api/v1/connect")
    .then((r) => (r.ok ? r.json() : null))
    .then((body) => {
      if (typeof body?.network !== "string") return;
      symbol = coinSymbol(body.network);
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

/** The coin's symbol on this server's network: "XEL" or "XET". */
export function useCoin() {
  return useSyncExternalStore(subscribe, () => symbol, () => "XEL");
}
