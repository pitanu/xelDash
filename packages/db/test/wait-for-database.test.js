// The migrate service waits for a database that is still starting, instead of failing the update on its first try.
import test from "node:test";
import assert from "node:assert/strict";
import { connectWhenReady, isNotReady } from "../src/wait-for-database.js";

const quiet = { info() {} };
const err = (/** @type {string} */ code, message = code) => Object.assign(new Error(message), { code });

/** Clients that fail with the given errors, in turn, and then connect. @param {(Error | null)[]} outcomes */
function clients(outcomes) {
  const made = { count: 0, ended: 0 };
  const make = () => {
    const outcome = outcomes[made.count++] ?? null;
    return {
      connect: async () => { if (outcome) throw outcome; },
      end: async () => { made.ended++; },
    };
  };
  return { make, made };
}

/** A clock that moves only when the code under test sleeps. */
function clock() {
  let t = 0;
  return { now: () => t, sleep: async (/** @type {number} */ ms) => { t += ms; } };
}

test("a database still starting is waited for, a fresh client each try", async () => {
  const { make, made } = clients([err("ECONNREFUSED"), err("57P03", "the database system is starting up"), null]);
  const logged = /** @type {string[]} */ ([]);
  const client = await connectWhenReady(make, { ...clock(), logger: { info: (m) => logged.push(m) } });
  assert.ok(client);
  assert.equal(made.count, 3);
  assert.equal(made.ended, 2, "each failed client is closed");
  assert.match(logged[0], /Waiting for the database/);
  assert.match(logged[1], /answers/);
});

test("a wrong password or a missing database fails at once", async () => {
  for (const code of ["28P01", "3D000"]) {
    const { make, made } = clients([err(code)]);
    await assert.rejects(connectWhenReady(make, { ...clock(), logger: quiet }), (e) => /** @type {any} */ (e).code === code);
    assert.equal(made.count, 1, code);
  }
});

test("it gives up after the time limit, with the last error", async () => {
  const { make, made } = clients(Array.from({ length: 100 }, () => err("ECONNREFUSED")));
  await assert.rejects(connectWhenReady(make, { ...clock(), timeoutMs: 10_000, intervalMs: 2_000, logger: quiet }), /ECONNREFUSED/);
  assert.equal(made.count, 6, "tries at 0, 2, 4, 6, 8 and 10 s");
});

test("what counts as not ready yet", () => {
  for (const e of [err("ECONNREFUSED"), err("ENOTFOUND"), err("EAI_AGAIN"), err("57P03"), err("08006"),
    new Error("Connection terminated unexpectedly"), new Error("the database system is starting up")]) assert.ok(isNotReady(e), e.message);
  for (const e of [err("28P01"), err("3D000"), err("42P01"), new TypeError("bad"), null]) assert.ok(!isNotReady(e), String(e?.message));
});
