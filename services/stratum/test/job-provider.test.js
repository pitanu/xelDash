// Rigs on the same address share one fetch of work from the node; each still gets work of its own.
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { MiningJobProvider } from "../src/job-provider.js";

const KEY = "11".repeat(32);
const A = "xet:aaaa";
const B = "xet:bbbb";

/** A node that answers like a daemon and counts the calls it gets. */
function fakeNode({ id = 1, failTemplate = false } = {}) {
  const calls = { template: 0, work: 0 };
  let height = 100;
  const client = {
    async getBlockTemplate(/** @type {string} */ address) {
      calls.template++;
      await new Promise((r) => setTimeout(r, 5)); // concurrent requests really overlap
      if (failTemplate) return { template: "", algorithm: "xel/v3" };
      return { template: `tpl-${address}-${height}`, algorithm: "xel/v3" };
    },
    async getMinerWork() {
      calls.work++;
      return { algorithm: "xel/v3", height, topoheight: height, difficulty: "1000000", miner_work: "ab".repeat(112) };
    },
  };
  return { node: { id, client }, calls, nextBlock: () => { height++; } };
}

/** @param {any} node @param {{ shareMs?: number, now?: () => number }} [options] */
function provider(node, options = {}) {
  return new MiningJobProvider({ nodes: /** @type {any} */ ({ active: node, reason: "no node" }), ...options });
}

const job = (/** @type {MiningJobProvider} */ p, address = A) =>
  p.create({ address, publicKey: KEY, extraNonce: randomBytes(32).toString("hex"), algorithm: "xel/v3", shareDifficulty: 1000 });

test("600 rigs on one address cost the node two calls, and every rig still gets its own work", async () => {
  const { node, calls } = fakeNode();
  const p = provider(node);
  const jobs = await Promise.all(Array.from({ length: 600 }, () => job(p)));
  assert.deepEqual(calls, { template: 1, work: 1 });
  assert.equal(new Set(jobs.map((j) => j.jobId)).size, 600, "a job id each");
  const works = new Set(jobs.map((j) => j.buildMinerWork("00".repeat(8)).toString("hex")));
  assert.equal(works.size, 600, "the same nonce gives different work for each rig (its own extra nonce)");
  assert.ok(jobs.every((j) => j.template === jobs[0].template), "the same template, as the node would have given each");
});

test("different addresses do not share work", async () => {
  const { node, calls } = fakeNode();
  const p = provider(node);
  const [a, b] = await Promise.all([job(p, A), job(p, B)]);
  assert.deepEqual(calls, { template: 2, work: 2 });
  assert.notEqual(a.template, b.template);
});

test("a new block, or work older than shareMs, is fetched again", async () => {
  let now = 0;
  const { node, calls, nextBlock } = fakeNode();
  const p = provider(node, { shareMs: 2_000, now: () => now });
  await job(p);
  now = 1_999;
  await job(p);
  assert.equal(calls.template, 1, "still fresh");
  now = 2_000;
  await job(p);
  assert.equal(calls.template, 2, "too old");
  nextBlock();
  p.invalidate();
  const after = await job(p);
  assert.equal(calls.template, 3, "a new block drops shared work at once");
  assert.match(after.template, /-101$/);
});

test("a failed fetch is not kept: the next rig asks the node again", async () => {
  const bad = fakeNode({ failTemplate: true });
  const p = provider(bad.node);
  await assert.rejects(job(p), /invalid block template/);
  await assert.rejects(job(p), /invalid block template/);
  assert.equal(bad.calls.template, 2);
});

test("every call to the node first passes the call budget's hook", async () => {
  const { node } = fakeNode();
  let passed = 0;
  const p = new MiningJobProvider({ nodes: /** @type {any} */ ({ active: node }), beforeNodeCall: () => { passed++; } });
  await Promise.all([job(p, A), job(p, A), job(p, B)]);
  assert.equal(passed, 4, "two calls for each of the two addresses");
});

/**
 * A node whose MinerWork header hash either ignores the miner (as XELIS does) or depends on it (as a future release might).
 * @param {{ dependsOnMiner?: boolean, txNoise?: () => string }} options
 */
function xelisLikeNode({ dependsOnMiner = false, txNoise = () => "" } = {}) {
  const calls = { template: 0, work: 0 };
  let height = 500;
  const headerHash = (/** @type {string} */ address) => {
    const base = `h${height}${txNoise()}${dependsOnMiner ? address : ""}`;
    return Buffer.from(base).toString("hex").padEnd(64, "0").slice(0, 64);
  };
  const client = {
    async getBlockTemplate(/** @type {string} */ address) { calls.template++; return { template: `tpl-${address}-${height}`, algorithm: "xel/v3" }; },
    async getMinerWork(/** @type {string} */ _template, /** @type {string} */ address) {
      calls.work++;
      return { algorithm: "xel/v3", height, topoheight: height, difficulty: "1000000", miner_work: headerHash(address) + "cd".repeat(80) };
    },
  };
  return { node: { id: 7, label: "daemon", client }, calls, nextBlock: () => { height++; } };
}
const quiet = { info() {}, warn() {} };
const addresses = (n) => Array.from({ length: n }, (_, i) => `xet:miner${i}`);

test("once two addresses get the same header hash, work is shared between all addresses: 300 miners cost the node a few calls", async () => {
  const { node, calls } = xelisLikeNode();
  const p = new MiningJobProvider({ nodes: /** @type {any} */ ({ active: node }), logger: quiet });
  await Promise.all([job(p, "xet:first"), job(p, "xet:second")]);
  assert.equal(p.sharingFor(node).mode, "all", "proven by one match");
  const before = calls.template;
  const jobs = await Promise.all(addresses(300).map((a) => job(p, a)));
  assert.equal(calls.template - before, 1, "one template for all 300 addresses");
  const keys = new Set(jobs.map((j) => j.buildMinerWork("00".repeat(8)).subarray(80, 112).toString("hex")));
  assert.equal(keys.size, 1, "the key comes from each job's own identity (the same test key here), not from the template's address");
  assert.ok(jobs.every((j) => j.headerWorkHash === jobs[0].headerWorkHash));
});

test("each miner's own key is in its own work even when the template was fetched for another address", async () => {
  const { node } = xelisLikeNode();
  const p = new MiningJobProvider({ nodes: /** @type {any} */ ({ active: node }), logger: quiet });
  await Promise.all([job(p, "xet:a"), job(p, "xet:b")]);
  const keyA = "aa".repeat(32);
  const keyB = "bb".repeat(32);
  const [a, b] = await Promise.all([
    p.create({ address: "xet:a", publicKey: keyA, extraNonce: "01".repeat(32), algorithm: "xel/v3", shareDifficulty: 1000 }),
    p.create({ address: "xet:b", publicKey: keyB, extraNonce: "02".repeat(32), algorithm: "xel/v3", shareDifficulty: 1000 }),
  ]);
  assert.equal(a.template, b.template, "one template");
  assert.equal(a.buildMinerWork("00".repeat(8)).subarray(80, 112).toString("hex"), keyA);
  assert.equal(b.buildMinerWork("00".repeat(8)).subarray(80, 112).toString("hex"), keyB);
});

test("a node whose work depends on the miner is never shared between addresses, and says so", async () => {
  const { node, calls } = xelisLikeNode({ dependsOnMiner: true });
  const warnings = [];
  const p = new MiningJobProvider({ nodes: /** @type {any} */ ({ active: node }), shareMs: 0, logger: { info() {}, warn: (m) => warnings.push(m) } });
  for (let round = 0; round < 12; round++) await Promise.all([job(p, "xet:a"), job(p, "xet:b")]);
  assert.equal(p.sharingFor(node).mode, "address");
  assert.equal(warnings.length, 1);
  const before = calls.template;
  await Promise.all(addresses(10).map((a) => job(p, a)));
  assert.equal(calls.template - before, 10, "one template per address");
});

test("mismatches from new transactions do not stop sharing once a match is seen; different heights prove nothing", async () => {
  let noisy = true;
  let n = 0;
  const { node, nextBlock } = xelisLikeNode({ txNoise: () => (noisy ? String(n++) : "") });
  const p = new MiningJobProvider({ nodes: /** @type {any} */ ({ active: node }), shareMs: 0, logger: quiet });
  for (let i = 0; i < 3; i++) await Promise.all([job(p, "xet:a"), job(p, "xet:b")]);
  assert.equal(p.sharingFor(node).mode, "checking", "a few mismatches: still checking");
  await job(p, "xet:a");
  nextBlock();
  noisy = false;
  await job(p, "xet:c");
  assert.equal(p.sharingFor(node).mode, "checking", "a fetch at another height is not compared");
  await job(p, "xet:d");
  assert.equal(p.sharingFor(node).mode, "all");
});

test("the check starts again after recheckMs and after a node switch", async () => {
  let now = 0;
  const { node } = xelisLikeNode();
  const p = new MiningJobProvider({ nodes: /** @type {any} */ ({ active: node }), recheckMs: 600_000, now: () => now, logger: quiet });
  await Promise.all([job(p, "xet:a"), job(p, "xet:b")]);
  assert.equal(p.sharingFor(node).mode, "all");
  now = 600_000;
  assert.equal(p.sharingFor(node).mode, "checking", "rechecked after ten minutes");
  await Promise.all([job(p, "xet:a"), job(p, "xet:b")]);
  assert.equal(p.sharingFor(node).mode, "all");
  p.recheck();
  assert.equal(p.sharingFor(node).mode, "checking", "rechecked after a node switch");
});
