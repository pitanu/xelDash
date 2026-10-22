// A tile's number is found in its formatted text and written back the same way, in the browser's language, while it counts up.
import test from "node:test";
import assert from "node:assert/strict";
import { easeOut, numberIn, writeLike } from "../src/count-up.js";

test("the number in a value is found with its decimals, grouping and the text around it", () => {
  assert.deepEqual(numberIn("8,242,347", "en-US"), { before: "", after: "", value: 8242347, decimals: 0, grouped: true });
  assert.deepEqual(numberIn("7.76 KH/s", "en-US"), { before: "", after: " KH/s", value: 7.76, decimals: 2, grouped: false });
  assert.deepEqual(numberIn("118%", "en-US"), { before: "", after: "%", value: 118, decimals: 0, grouped: false });
  assert.deepEqual(numberIn("<0.01%", "en-US"), { before: "<", after: "%", value: 0.01, decimals: 2, grouped: false });
  assert.equal(numberIn("—", "en-US"), null, "no number: shown as it is");
  assert.equal(numberIn("", "en-US"), null);
});

test("other languages' separators are read and written back", () => {
  const fi = (1234567.5).toLocaleString("fi-FI", { minimumFractionDigits: 2 });
  const shape = numberIn(`${fi} XEL`, "fi-FI");
  assert.equal(shape?.value, 1234567.5);
  assert.equal(shape?.decimals, 2);
  assert.equal(writeLike(1234567.5, /** @type {any} */ (shape), "fi-FI"), `${fi} XEL`, "written back exactly");
  const de = numberIn("8.242.347", "de-DE");
  assert.equal(de?.value, 8242347, "a German point groups digits");
  assert.equal(numberIn("7,76 KH/s", "de-DE")?.value, 7.76, "and a comma is the decimal mark");
});

test("numbers on the way up are written like the final one", () => {
  const shape = /** @type {NonNullable<ReturnType<typeof numberIn>>} */ (numberIn("8,242,347", "en-US"));
  assert.equal(writeLike(0, shape, "en-US"), "0");
  assert.equal(writeLike(1234.4, shape, "en-US"), "1,234");
  const rate = /** @type {NonNullable<ReturnType<typeof numberIn>>} */ (numberIn("7.76 KH/s", "en-US"));
  assert.equal(writeLike(0, rate, "en-US"), "0.00 KH/s", "the same decimals all the way");
  assert.equal(writeLike(7.76, rate, "en-US"), "7.76 KH/s");
});

test("the count slows down as it arrives", () => {
  assert.equal(easeOut(0), 0);
  assert.equal(easeOut(1), 1);
  assert.ok(easeOut(0.5) > 0.5, "more than half way at half time");
});
