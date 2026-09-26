import { ensureWorker } from "@xeldash/db";

/** @param {{ daemon: import("./node-pool.js").NodePool, pool: import("pg").Pool }} dependencies */
export function createWorkerAuthorizer({ daemon, pool }) {
  /** @param {{ address: string, workerName: string, password?: string, ip?: string }} input */
  return async ({ address, workerName, ip }) => {
    const identity = await daemon.getMiningIdentity(address);
    if (!identity) return null;
    const persisted = await ensureWorker(pool, { address, name: workerName, ip });
    return { ...persisted, address, publicKey: identity.publicKey };
  };
}
