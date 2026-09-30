import { useEffect, useState } from "react";

// The official XELIS block explorer, for the network this server runs on. Devnet has none.
const EXPLORERS = /** @type {Record<string, string>} */ ({
  mainnet: "https://explorer.xelis.io",
  testnet: "https://testnet-explorer.xelis.io",
});

/** The network never changes while the server runs, so it is asked for once. @type {Promise<string | null> | null} */
let network = null;

function loadNetwork() {
  network ??= fetch("/api/v1/status")
    .then((response) => (response.ok ? response.json() : null))
    .then((status) => status?.node?.network ?? null)
    .catch(() => null);
  return network;
}

/** A function giving the explorer page of a block, or null where no explorer exists. */
export function useBlockUrl() {
  const [name, setName] = useState(/** @type {string | null} */ (null));
  useEffect(() => {
    let active = true;
    void loadNetwork().then((n) => active && setName(n));
    return () => { active = false; };
  }, []);
  const base = name ? EXPLORERS[name] : undefined;
  return (/** @type {string | undefined} */ hash) => (base && hash ? `${base}/block/${hash}` : null);
}
