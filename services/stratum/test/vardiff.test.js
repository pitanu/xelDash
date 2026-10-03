import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_VARDIFF, Vardiff, vardiffConfigFromEnv } from "../src/vardiff.js";

const config = { ...DEFAULT_VARDIFF, startDifficulty: 1000, minDifficulty: 100, targetShareSeconds: 10, retargetSeconds: 60, retargetShares: 20 };
const MAX = 1e12;

test("settings come from the environment and are checked", () => {
  assert.deepEqual(vardiffConfigFromEnv({}), DEFAULT_VARDIFF);
  assert.equal(vardiffConfigFromEnv({ STRATUM_START_DIFFICULTY: "5000" }).startDifficulty, 5000);
  assert.throws(() => vardiffConfigFromEnv({ STRATUM_MIN_DIFFICULTY: "0" }), /positive integer/);
  assert.throws(() => vardiffConfigFromEnv({ STRATUM_MIN_DIFFICULTY: "1.5" }), /positive integer/);
  assert.throws(() => vardiffConfigFromEnv({ STRATUM_START_DIFFICULTY: "10", STRATUM_MIN_DIFFICULTY: "100" }), /at least/);
});

test("a fast miner is raised, at most 2x at a time", () => {
  const v = new Vardiff(config, 0);
  // 20 shares of difficulty 1000, one per second: 1000 H/s, so the ideal is 10x the current
  let next = null;
  for (let i = 1; i <= 20; i++) next = v.recordShare(1000, MAX, i * 1000);
  assert.equal(next, 2000);
  assert.equal(v.difficulty, 2000);
});

test("a slow miner is lowered, never below the minimum", () => {
  const v = new Vardiff(config, 0);
  // one share worth 1000 in 60 s: ideal about 167, a factor of 0.17, limited to halving
  assert.equal(v.recordShare(1000, MAX, 60_000), 500);
  for (let i = 1; i <= 8; i++) v.retarget(MAX, 60_000 + i * 60_000);
  assert.equal(v.difficulty, config.minDifficulty);
});

test("a miner already on target is left alone (dead band)", () => {
  const v = new Vardiff(config, 0);
  // one share of the current difficulty every 10 s, for a full window
  let changed = null;
  for (let i = 1; i <= 6; i++) changed = v.recordShare(1000, MAX, i * 10_000) ?? changed;
  assert.equal(changed, null);
  assert.equal(v.difficulty, 1000);
});

test("the ceiling holds, and a fixed difficulty never retargets", () => {
  const v = new Vardiff(config, 0);
  let next = null;
  for (let i = 1; i <= 20; i++) next = v.recordShare(1000, 1200, i * 1000);
  assert.equal(next, 1200);
  const f = new Vardiff(config, 0);
  f.fix(50);
  assert.equal(f.difficulty, 100, "never below the minimum");
  f.fix(5000.9);
  assert.equal(f.difficulty, 5000);
  for (let i = 1; i <= 40; i++) assert.equal(f.recordShare(1000, MAX, i * 1000), null);
  assert.equal(f.difficulty, 5000);
});

test("retargetIfDue waits for the window", () => {
  const v = new Vardiff(config, 0);
  assert.equal(v.retargetIfDue(MAX, 30_000), null);
  assert.equal(v.windowStart, 0, "the window is untouched before it is due");
  v.retargetIfDue(MAX, 61_000);
  assert.equal(v.windowStart, 61_000);
});
