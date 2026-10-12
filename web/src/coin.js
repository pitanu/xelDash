import { coinSymbol } from "./format.js";
import { useServerMode } from "./server-mode.js";

/**
 * The coin's symbol on this server's network: "XEL" on mainnet, "XET" on testnet and devnet. Until the network is known, or if it
 * cannot be read, amounts say XEL.
 */
export function useCoin() {
  const { network } = useServerMode();
  return network ? coinSymbol(network) : "XEL";
}
