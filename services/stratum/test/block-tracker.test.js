// The block status check: while the database is still starting it fails on every new block, which is many a second when a node
// catches up after a restart. The same failure is logged once, and once more when the check works again.
import test from "node:test";
import assert from "node:assert/strict";
import { BlockTracker } from "../src/block-tracker.js";

test("a run of the same failure is logged once, and its end once", async () => {
  /** @type {string[]} */
  const logged = [];
  const logger = { info: (/** @type {string} */ m) => logged.push(`info ${m}`), warn: (/** @type {string} */ m) => logged.push(`warn ${m}`) };
  let error = /** @type {Error | null} */ (new Error("the database system is starting up"));
  const pool = { query: async () => { if (error) throw error; return { rows: [] }; } };
  const tracker = new BlockTracker({ daemon: /** @type {any} */ ({}), pool: /** @type {any} */ (pool), logger });
  const pass = async () => { tracker.check(); await tracker.running; };
  for (let i = 0; i < 20; i++) await pass();
  assert.deepEqual(logged, ["warn Block status check failed"]);
  error = new Error("the database system is not yet accepting connections");
  await pass();
  await pass();
  assert.equal(logged.length, 2, "a different failure is logged");
  error = null;
  await pass();
  await pass();
  assert.deepEqual(logged.slice(2), ["info Block status check works again"]);
});
