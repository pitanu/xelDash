/**
 * The worker for a login. The node checks the address; the store finds or creates the worker (during a
 * database outage, from the workers seen before, or a provisional one that is created when the database
 * is back).
 * @param {{ daemon: import("./node-pool.js").NodePool, store: import("./store.js").DurableStore }} dependencies
 */
export function createWorkerAuthorizer({ daemon, store }) {
  /** @param {{ address: string, workerName: string, password?: string, ip?: string }} input */
  return async ({ address, workerName, ip }) => {
    const identity = await daemon.getMiningIdentity(address);
    if (!identity) return null;
    const ids = await store.ensureWorker({ address, name: workerName, ip });
    return { ...ids, address, publicKey: identity.publicKey, provisional: ids.workerId === null };
  };
}
