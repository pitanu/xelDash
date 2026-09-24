import { ensureWorker } from "../../../packages/db/src/index.js";

export function createWorkerAuthorizer({ daemon, pool }) {
  return async ({ address, workerName, ip }) => {
    const identity = await daemon.getMiningIdentity(address);
    if (!identity) return null;
    const persisted = await ensureWorker(pool, { address, name: workerName, ip });
    return { ...persisted, address, publicKey: identity.publicKey };
  };
}
