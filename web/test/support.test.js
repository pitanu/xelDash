import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { SUPPORT_ADDRESS, supportApplies } from "../src/support.js";

test("the support address is a mainnet address, and it matches the README", () => {
  assert.match(SUPPORT_ADDRESS, /^xel:[a-z0-9]{50,120}$/);
  const readme = readFileSync(new URL("../../README.md", import.meta.url), "utf8");
  assert.ok(readme.includes(SUPPORT_ADDRESS), "the README shows the same address as the dashboard");
});

test("support is offered on mainnet only", () => {
  assert.equal(supportApplies("mainnet"), true);
  for (const other of ["testnet", "devnet", "", null, undefined]) assert.equal(supportApplies(other), false, String(other));
});
