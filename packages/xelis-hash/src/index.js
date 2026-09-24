import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
/** @type {{ hashMinerWork: (minerWork: Buffer) => Buffer } | undefined} */
let binding;

/** @param {Buffer | Uint8Array} minerWork */
export function hashMinerWork(minerWork) {
  if (!(minerWork instanceof Uint8Array) || minerWork.byteLength !== 112) {
    throw new TypeError("MinerWork must be a 112-byte Buffer or Uint8Array");
  }
  let nativeBinding = binding;
  if (!nativeBinding) {
    try {
      nativeBinding = require("../index.node");
      binding = nativeBinding;
    } catch (cause) {
      throw new Error(
        "The XELIS Hash V3 native addon is not built for this platform; run `npm run build --workspace @xeldash/xelis-hash`",
        { cause },
      );
    }
  }
  if (!nativeBinding) throw new Error("XELIS Hash V3 native binding could not be loaded");
  return nativeBinding.hashMinerWork(Buffer.from(minerWork));
}
