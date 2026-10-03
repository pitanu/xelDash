// Where optional support for xelDash goes: the maintainer's own mainnet wallet address. It is only text to copy: xelDash
// never sends or asks for anything, and nothing in it depends on a donation. The same address is in the README (docs and
// dashboard should agree: if they ever differ, trust the README on GitHub). A fork changes this one line.
export const SUPPORT_ADDRESS = "xel:060exlhsp28xzkxf8zpa04kw33dgs7tcqu8sq8zntddf9h7wmvusqy82lgk";

const KEY = "xeldash.supportDismissed";

/** Donations are mainnet only: a testnet or devnet server has nothing to give. @param {string | null | undefined} network */
export function supportApplies(network) {
  return network === "mainnet";
}

/** @returns {boolean} */
export function supportDismissed() {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

export function dismissSupport() {
  try {
    localStorage.setItem(KEY, "1");
  } catch {
    // Private mode: it comes back on the next visit.
  }
}
