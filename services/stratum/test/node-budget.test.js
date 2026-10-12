// The node-call budget, and the public-server limits around it, against a flood: many IP addresses logging in with fresh made-up
// addresses as fast as they can. The node must never get more calls than the budget allows, while a farm (many rigs, one address,
// one IP address) still gets in.
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { LoginRefused, createWorkerAuthorizer } from "../src/authorize-worker.js";
import { MiningJobProvider } from "../src/job-provider.js";
import { NodeBudget, NodeBusy } from "../src/node-budget.js";

/** A node that records when each call arrives. */
function countingNode() {
  /** @type {number[]} */
  const calls = [];
  const client = {
    async getBlockTemplate(/** @type {string} */ address) {
      calls.push(Date.now());
      return { template: `tpl-${address}`, algorithm: "xel/v3" };
    },
    async getMinerWork() {
      calls.push(Date.now());
      return { algorithm: "xel/v3", height: 1, topoheight: 1, difficulty: "1000000", miner_work: "ab".repeat(112) };
    },
  };
  const daemon = {
    active: { id: 1, client },
    async getMiningIdentity(/** @type {string} */ address) {
      calls.push(Date.now());
      return { publicKey: "11".repeat(32), address };
    },
  };
  return { daemon, calls };
}

const store = { ensureWorker: async () => ({ minerId: 1, workerId: 1 }) };

/** The most calls in any one-second window. @param {number[]} times */
function peakPerSecond(times) {
  const sorted = [...times].sort((a, b) => a - b);
  let peak = 0;
  for (let i = 0, j = 0; i < sorted.length; i++) {
    while (sorted[i] - sorted[j] >= 1000) j++;
    peak = Math.max(peak, i - j + 1);
  }
  return peak;
}

test("the budget lets through at most perSecond calls a second, in order, and refuses when the wait would be too long", async () => {
  const budget = new NodeBudget({ perSecond: 50, maxWaitMs: 600 });
  const started = Date.now();
  const results = await Promise.allSettled(Array.from({ length: 120 }, () => budget.take().then(() => Date.now() - started)));
  const granted = results.filter((r) => r.status === "fulfilled").map((r) => /** @type {PromiseFulfilledResult<number>} */ (r).value);
  const refused = results.filter((r) => r.status === "rejected");
  // 10 at once (the burst, a fifth of a second's worth), then about 50 a second for the 600 ms the others may wait.
  assert.ok(granted.length >= 32 && granted.length <= 45, `granted ${granted.length}`);
  assert.ok(refused.every((r) => /** @type {PromiseRejectedResult} */ (r).reason instanceof NodeBusy));
  assert.equal(granted.length + refused.length, 120);
  assert.ok(new NodeBudget({ perSecond: 0 }).unlimited, "0 is no ceiling");
});

test("a flood of logins with fresh addresses from many IP addresses stays within the node's budget", { timeout: 30_000 }, async () => {
  const { daemon, calls } = countingNode();
  /** When the budget let each call through (told by the budget itself, at that moment). @type {number[]} */
  const grants = [];
  const budget = new NodeBudget({ perSecond: 100, maxWaitMs: 1_000, onGrant: (at) => grants.push(at) });
  const authorize = createWorkerAuthorizer({ daemon: /** @type {any} */ (daemon), store: /** @type {any} */ (store), budget, maxAddressesPerIp: 32 });
  const jobs = new MiningJobProvider({ nodes: /** @type {any} */ (daemon), beforeNodeCall: () => budget.take() });
  const outcome = { ok: 0, busy: 0, tooMany: 0 };
  const started = Date.now();
  // 200 IP addresses, each trying 50 fresh addresses as fast as it can: 10,000 logins in about 2 seconds of sending.
  const attempts = [];
  for (let ip = 0; ip < 200; ip++) {
    for (let n = 0; n < 50; n++) {
      attempts.push((async () => {
        const address = `xet:${randomBytes(20).toString("hex")}`;
        try {
          const identity = await authorize({ address, workerName: "w", ip: `203.0.113.${ip % 250}-${ip}` });
          await jobs.create({ address, publicKey: identity?.publicKey ?? "11".repeat(32), extraNonce: "22".repeat(32), algorithm: "xel/v3", shareDifficulty: 1000 });
          outcome.ok++;
        } catch (error) {
          if (error instanceof LoginRefused && error.reason === "too_many_addresses") outcome.tooMany++;
          else if (error instanceof LoginRefused || error instanceof NodeBusy) outcome.busy++;
          else throw error;
        }
      })());
    }
  }
  await Promise.all(attempts);
  // The budget itself: 100 a second plus its small burst (20), in any one second.
  assert.ok(peakPerSecond(grants) <= 121, `the budget let ${peakPerSecond(grants)} calls through in one second (budget 100)`);
  // At the node, calls let through at the end of one second can arrive in the next while this test floods the event loop.
  const peak = peakPerSecond(calls);
  assert.ok(peak <= 150, `the node got ${peak} calls in one second (budget 100)`);
  assert.equal(calls.length, grants.length, "every call to the node went through the budget");
  assert.equal(outcome.tooMany, 200 * 18, "each IP address got 32 addresses; the other 18 were refused without asking the node");
  assert.ok(calls.length < 400, `the node got ${calls.length} calls in all, not tens of thousands`);
  assert.ok(Date.now() - started < 20_000);
});

test("a farm of 600 rigs behind one IP address on one address gets in, and costs the node three calls", async () => {
  const { daemon, calls } = countingNode();
  const budget = new NodeBudget({ perSecond: 100 });
  const authorize = createWorkerAuthorizer({ daemon: /** @type {any} */ (daemon), store: /** @type {any} */ (store), budget, maxAddressesPerIp: 32 });
  const jobs = new MiningJobProvider({ nodes: /** @type {any} */ (daemon), beforeNodeCall: () => budget.take() });
  const address = "xet:farm";
  await Promise.all(Array.from({ length: 600 }, async (_, i) => {
    const identity = await authorize({ address, workerName: `rig${i}`, ip: "198.51.100.7" });
    assert.ok(identity);
    await jobs.create({ address, publicKey: identity.publicKey, extraNonce: randomBytes(32).toString("hex"), algorithm: "xel/v3", shareDifficulty: 1000 });
  }));
  assert.equal(calls.length, 3, "one address check, one template, one MinerWork");
});

test("an invalid address is remembered briefly; a valid one for longer", async () => {
  let checks = 0;
  const daemon = { async getMiningIdentity(/** @type {string} */ a) { checks++; return a === "good" ? { publicKey: "11".repeat(32) } : null; } };
  let now = 0;
  const authorize = createWorkerAuthorizer({ daemon: /** @type {any} */ (daemon), store: /** @type {any} */ (store), now: () => now });
  assert.equal(await authorize({ address: "bad", workerName: "w" }), null);
  assert.equal(await authorize({ address: "bad", workerName: "w" }), null);
  assert.ok(await authorize({ address: "good", workerName: "w" }));
  assert.ok(await authorize({ address: "good", workerName: "w2" }));
  assert.equal(checks, 2, "each address asked once");
});
