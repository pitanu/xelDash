import test from "node:test";
import assert from "node:assert/strict";
import { encodeMessage, errorResponse, negotiateAlgorithm, notification, parseRequest, response } from "../src/protocol.js";

test("requests: classic Stratum without jsonrpc is accepted, other versions and shapes are not", () => {
  assert.deepEqual(parseRequest({ id: 1, method: "mining.subscribe", params: ["x"] }), { id: 1, method: "mining.subscribe", params: ["x"] });
  assert.deepEqual(parseRequest({ jsonrpc: "2.0", id: "a", method: "m" }), { id: "a", method: "m", params: [] });
  assert.deepEqual(parseRequest({ method: "m" }), { id: null, method: "m", params: [] });
  for (const bad of [null, [], "x", 5, { jsonrpc: "1.0", method: "m" }, { method: 5 }, { method: "m", params: "no" }, { method: "m", id: 1.5 }, { method: "m", id: {} }, { method: "m", id: 2 ** 60 }]) {
    assert.throws(() => parseRequest(bad), TypeError, JSON.stringify(bad));
  }
});

test("algorithm negotiation prefers the newest supported one", () => {
  assert.equal(negotiateAlgorithm(), "xel/v3");
  assert.equal(negotiateAlgorithm([]), "xel/v3");
  assert.equal(negotiateAlgorithm(["xel/v1", "xel/v3"]), "xel/v3");
  assert.equal(negotiateAlgorithm(["xel/1"]), "xel/v2");
  assert.equal(negotiateAlgorithm(["xel/0"]), "xel/v1");
  assert.equal(negotiateAlgorithm(["sha256"]), null);
});

test("messages are one JSON line", () => {
  assert.equal(encodeMessage(response(1, true)), '{"jsonrpc":"2.0","id":1,"result":true}\n');
  assert.deepEqual(errorResponse(2, 24, "no").error, { code: 24, message: "no", data: null });
  assert.deepEqual(notification("mining.notify", [1]), { jsonrpc: "2.0", id: null, method: "mining.notify", params: [1] });
});
