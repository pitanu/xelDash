// A main colour of the person's own: from one colour, a light-mode and a dark-mode accent that stay readable, with a soft tint and
// text that reads on top.
import test from "node:test";
import assert from "node:assert/strict";
import { BACKGROUNDS, accentFor, accentVariables, contrast, difference, parseHex } from "../src/accent.js";

test("colours are read as #rgb or #rrggbb, and anything else is refused", () => {
  assert.deepEqual(parseHex("#ff0000"), [1, 0, 0]);
  assert.deepEqual(parseHex("#f00"), [1, 0, 0]);
  assert.equal(parseHex("red"), null);
  assert.equal(parseHex("#12345"), null);
  assert.equal(parseHex("url(x)"), null);
});

test("any colour gives an accent with at least 3:1 contrast on its mode's background, in both modes", () => {
  for (const hex of ["#ffff00", "#000000", "#ffffff", "#c2410c", "#1d5fd1", "#00ff88", "#808080", "#ff00ff", "#0000ff"]) {
    for (const mode of /** @type {const} */ (["light", "dark"])) {
      const { accent, soft, ink } = accentFor(hex, mode);
      assert.ok(contrast(accent, BACKGROUNDS[mode]) >= 3, `${hex} ${mode}: ${accent} on ${BACKGROUNDS[mode]}`);
      assert.ok(contrast(accent, ink) >= 3, `${hex} ${mode}: text ${ink} on ${accent}`);
      assert.match(soft, /^#[0-9a-f]{6}$/);
    }
  }
});

test("the hue is kept: a blue stays blue and an orange stays orange", () => {
  const blue = accentFor("#2a78d6", "light").accent;
  const orange = accentFor("#ff7a00", "light").accent;
  assert.ok(difference(blue, "#2a78d6") < 15, `${blue} is close to the blue picked`);
  assert.ok(difference(orange, blue) > 30, "and clearly different from an orange");
});

test("the variables cover both modes", () => {
  assert.deepEqual(Object.keys(accentVariables("#6d3fd1")).sort(), [
    "--custom-accent", "--custom-accent-dark", "--custom-accent-ink", "--custom-accent-ink-dark", "--custom-accent-soft", "--custom-accent-soft-dark",
  ]);
});
