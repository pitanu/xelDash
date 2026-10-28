import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { BodyTooLarge, MAX_JSON_BYTES, readJson } from "../src/json-body.js";

/** A request body arriving in chunks. @param {(string | Buffer)[]} chunks */
const body = (chunks) => /** @type {import("node:http").IncomingMessage} */ (/** @type {unknown} */ (Readable.from(chunks.map((c) => Buffer.from(c)))));

test("a settings body is parsed; one that is not JSON gives null", async () => {
  assert.deepEqual(await readJson(body(['{"a":', '"é"}'])), { a: "é" });
  assert.equal(await readJson(body(["not json"])), null);
  assert.equal(await readJson(body([])), null);
});

test("the limit is in bytes, counted as the body arrives, and a larger body is refused as too large (413)", async () => {
  // Characters that take several bytes each: under the limit in characters, over it in bytes.
  const wide = "€".repeat(Math.ceil(MAX_JSON_BYTES / 3) + 10);
  assert.ok(wide.length < MAX_JSON_BYTES && Buffer.byteLength(wide) > MAX_JSON_BYTES);
  await assert.rejects(readJson(body([`"${wide}"`])), BodyTooLarge);
  // Stopped as soon as the limit is passed, without reading the rest.
  let read = 0;
  const endless = Readable.from((function* () { for (;;) { read += 1; yield Buffer.alloc(10_000, 0x20); } })());
  await assert.rejects(readJson(/** @type {any} */ (endless)), BodyTooLarge);
  assert.ok(read <= MAX_JSON_BYTES / 10_000 + 2, `read ${read} chunks`);
  assert.deepEqual(await readJson(body([" ".repeat(MAX_JSON_BYTES - 2), "{}"])), {}, "exactly the limit is fine");
});
