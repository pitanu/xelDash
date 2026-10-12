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
