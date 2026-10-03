import test from "node:test";
import assert from "node:assert/strict";
import { LineFramer } from "../src/line-framer.js";

test("complete lines come out, partial ones wait for the rest", () => {
  const f = new LineFramer();
  assert.deepEqual(f.push('{"a":1}\n{"b"'), ['{"a":1}']);
  assert.deepEqual(f.push(":2}\r\n"), ['{"b":2}']);
  assert.deepEqual(f.push("\n\n"), [], "empty lines are skipped");
});

test("multi-byte characters split across chunks are kept whole", () => {
  const f = new LineFramer();
  const bytes = Buffer.from("héllo €\n");
  assert.deepEqual([...f.push(bytes.subarray(0, 2)), ...f.push(bytes.subarray(2))], ["héllo €"]);
});

test("a line or a batch over the limits is an error", () => {
  assert.throws(() => new LineFramer(8).push("123456789\n"), RangeError);
  assert.throws(() => new LineFramer(8).push("123456789"), RangeError, "even without a newline yet");
  assert.throws(() => new LineFramer().push("a\nb\nc\n", 2), /Too many/);
  assert.deepEqual(new LineFramer().push("a\nb\n", 2), ["a", "b"]);
  assert.throws(() => new LineFramer(0), TypeError);
  assert.throws(() => new LineFramer().push("a", -1), RangeError);
});
