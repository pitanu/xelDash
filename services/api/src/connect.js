import { readFile } from "node:fs/promises";

// What a miner needs to know to connect: where, on which ports, and to which address. The ports
// are the ones published on the host (Compose maps them), so they are passed in as settings.

const ADDRESS_FILE = process.env.XELDASH_MINING_ADDRESS_FILE ?? "/config/mining-address.json";

/** @param {string | undefined} value @param {number} fallback */
function port(value, fallback) {
  const n = Number.parseInt(value ?? "", 10);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : fallback;
}

/** The address chosen on the setup page, else the one from .env, else none. @param {Partial<Record<string, string | undefined>>} env */
async function savedAddress(env) {
  try {
    const saved = JSON.parse(await readFile(ADDRESS_FILE, "utf8"));
    if (typeof saved.address === "string" && saved.address) return saved.address;
  } catch {
    // Nothing saved yet.
  }
  return env.XELIS_DEFAULT_ADDRESS?.trim() || null;
}

/**
 * @param {Partial<Record<string, string | undefined>>} env
 * @param {{ publicMode?: boolean, publicView?: boolean }} [mode] public mode, and whether this request gets the public view
 */
export async function getConnectInfo(env = process.env, { publicMode = false, publicView = false } = {}) {
  const bind = env.CONNECT_BIND_IP ?? "127.0.0.1";
  return {
    network: (env.XELIS_NETWORK ?? "devnet").toLowerCase(),
    // The machine's address on your network, when the installer found it.
    host: env.CONNECT_HOST?.trim() || null,
    stratumPort: port(env.CONNECT_STRATUM_PORT, 3333),
    tlsPort: (env.STRATUM_TLS_ENABLED ?? "false").toLowerCase() === "true" ? port(env.CONNECT_TLS_PORT, 3334) : null,
    getworkPort: (env.GETWORK_ENABLED ?? "true").toLowerCase() === "false" ? null : port(env.CONNECT_GETWORK_PORT, 8090),
    // False while Stratum only listens on this machine: rigs elsewhere cannot connect yet.
    reachableFromNetwork: bind !== "127.0.0.1" && bind !== "localhost" && bind !== "::1",
    // On a public server every miner mines to its own address: the operator's default is never offered to visitors.
    address: publicView ? null : await savedAddress(env),
    publicMode,
    // "public": a visitor of a public server (no administration, no IP addresses); "operator": everyone else.
    view: publicView ? "public" : "operator",
  };
}
