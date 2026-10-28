import test from "node:test";
import assert from "node:assert/strict";
import { RefusalLog } from "../src/refusal-log.js";

test("a refusal is logged at once, then at most once a minute per address and reason, with how many there were in between", () => {
  /** @type {string[]} */
  const lines = [];
  const log = new RefusalLog({ warn: (m) => lines.push(m) }, 60_000);
  log.refused("Stratum", "203.0.113.5", "connecting too often", 0);
  for (let i = 1; i <= 2999; i++) log.refused("Stratum", "203.0.113.5", "connecting too often", i * 10);
  log.refused("Stratum", "203.0.113.5", "banned", 500);
  log.refused("getwork", "203.0.113.5", "connecting too often", 600);
  log.refused("Stratum", "198.51.100.1", "connecting too often", 700);
  assert.deepEqual(lines, [
    "Refusing Stratum connection from 203.0.113.5: connecting too often",
    "Refusing Stratum connection from 203.0.113.5: banned",
    "Refusing getwork connection from 203.0.113.5: connecting too often",
    "Refusing Stratum connection from 198.51.100.1: connecting too often",
  ], "each address, reason and listener on its own");
  log.refused("Stratum", "203.0.113.5", "connecting too often", 60_000);
  assert.equal(lines.at(-1), "Refusing Stratum connection from 203.0.113.5: connecting too often (and 2999 more in the last 60 s)");
  log.refused("Stratum", "203.0.113.5", "connecting too often", 130_000);
  assert.equal(lines.at(-1), "Refusing Stratum connection from 203.0.113.5: connecting too often", "nothing skipped in between: no count");
});
