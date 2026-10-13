import assert from "node:assert/strict";
import test from "node:test";
import { LoginRefused, createWorkerAuthorizer } from "../src/authorize-worker.js";

function setup(options) {
  let t = 0;
  const rows = [];
  const daemon = { getMiningIdentity: async (address) => ({ publicKey: "ab".repeat(32), address }) };
  const store = { ensureWorker: async ({ address, name }) => { rows.push(`${address}/${name}`); return { minerId: "1", workerId: String(rows.length) }; } };
  const authorize = createWorkerAuthorizer({ daemon: /** @type {any} */ (daemon), store: /** @type {any} */ (store), now: () => t, ...options });
  return { authorize, rows, advance: (ms) => { t += ms; } };
}

test("new worker names per IP address: a farm logs in the same names again; made-up names are refused past the limit", async () => {
  const { authorize, rows, advance } = setup({ maxWorkersPerIp: 3 });
  for (const name of ["rig1", "rig2", "rig3"]) await authorize({ address: "xet:a", workerName: name, ip: "10.0.0.1" });
  for (const name of ["rig1", "rig2", "rig3"]) await authorize({ address: "xet:a", workerName: name, ip: "10.0.0.1" });
  await assert.rejects(authorize({ address: "xet:a", workerName: "rig4", ip: "10.0.0.1" }), (error) => {
    assert.ok(error instanceof LoginRefused);
    assert.equal(error.reason, "too_many_new_workers");
    assert.equal(error.abusive, false, "a large farm is not an attack");
    return true;
  });
  assert.equal(rows.length, 6, "the refused login wrote nothing");
  await authorize({ address: "xet:a", workerName: "rig4", ip: "10.0.0.2" });
  advance(60 * 60_000 + 1);
  await authorize({ address: "xet:a", workerName: "rig5", ip: "10.0.0.1" });
});

test("no limit on new worker names unless set", async () => {
  const { authorize } = setup({});
  for (let i = 0; i < 2000; i++) await authorize({ address: "xet:a", workerName: `rig${i}`, ip: "10.0.0.1" });
});
