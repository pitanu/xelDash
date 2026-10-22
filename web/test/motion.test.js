// Chart lines draw in again when a new range's data arrives, not on every refresh of the same range.
import test from "node:test";
import assert from "node:assert/strict";
import { nextReplay } from "../src/replay.js";

const first = { points: 1 };
const refreshed = { points: 2 };
const otherRange = { points: 3 };

test("refreshes of the same range keep the key", () => {
  let state = { range: "24h", data: /** @type {object | null} */ (null), key: 0, waiting: false };
  state = nextReplay(state, "24h", first);
  state = nextReplay(state, "24h", refreshed);
  assert.equal(state.key, 0);
});

test("a range change moves the key once its data arrives, not before", () => {
  let state = { range: "24h", data: first, key: 0, waiting: false };
  state = nextReplay(state, "7d", first);
  assert.equal(state.key, 0, "the old range's data is still on screen");
  state = nextReplay(state, "7d", first);
  assert.equal(state.key, 0);
  state = nextReplay(state, "7d", otherRange);
  assert.equal(state.key, 1);
  state = nextReplay(state, "7d", refreshed);
  assert.equal(state.key, 1, "later refreshes draw nothing again");
});

test("the same state comes back when nothing changed", () => {
  const state = { range: "24h", data: first, key: 0, waiting: false };
  assert.equal(nextReplay(state, "24h", first), state);
});
