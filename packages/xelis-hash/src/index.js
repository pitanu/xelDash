import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
/** @typedef {{ hashMinerWork: (minerWork: Buffer) => Buffer, hashMinerWorkAsync: (minerWork: Buffer) => Promise<Buffer> }} Binding */
/** @type {Binding | undefined} */
let binding;

/** @param {Buffer | Uint8Array} minerWork */
function checkMinerWork(minerWork) {
  if (!(minerWork instanceof Uint8Array) || minerWork.byteLength !== 112) {
    throw new TypeError("MinerWork must be a 112-byte Buffer or Uint8Array");
  }
}

/** @returns {Binding} */
function loadBinding() {
  if (binding) return binding;
  try {
    binding = /** @type {Binding} */ (require("../index.node"));
  } catch (cause) {
    throw new Error(
      "The XELIS Hash V3 native addon is not built for this platform; run `npm run build --workspace @xeldash/xelis-hash`",
      { cause },
    );
  }
  return binding;
}

/**
 * Hash on the calling thread. Blocks the event loop for the length of one V3 hash.
 * @param {Buffer | Uint8Array} minerWork
 */
export function hashMinerWork(minerWork) {
  checkMinerWork(minerWork);
  return loadBinding().hashMinerWork(Buffer.from(minerWork));
}

/**
 * Hash on the libuv thread pool, so share validation does not block other connections.
 * @param {Buffer | Uint8Array} minerWork @returns {Promise<Buffer>}
 */
export async function hashMinerWorkAsync(minerWork) {
  checkMinerWork(minerWork);
  return loadBinding().hashMinerWorkAsync(Buffer.from(minerWork));
}
