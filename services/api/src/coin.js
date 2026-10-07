/** The coin's symbol on a network: XEL on mainnet, XET on testnet and devnet. @param {string | null | undefined} network */
export function coinSymbol(network) {
  return (network ?? "devnet").toLowerCase() === "mainnet" ? "XEL" : "XET";
}
