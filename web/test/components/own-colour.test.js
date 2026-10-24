// A main colour of the person's own: the switch turns it on (starting from the theme's own), the picker changes it on the page and in
// this browser, a red is warned about, and turning it off puts the theme's colour back.
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { createElement as h } from "react";
import { cleanup, interact, render } from "../dom/render.js";
import ThemeSetting from "../../src/components/ThemeSetting.jsx";
import { setAccent } from "../../src/theme.js";

afterEach(async () => {
  await cleanup();
  setAccent(null);
});

const root = document.documentElement;

/** @param {HTMLInputElement} input @param {string} value */
function pick(input, value) {
  const setter = /** @type {(v: string) => void} */ (Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set);
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

test("turning it on, picking a colour, and turning it off again", async () => {
  const view = await render(h(ThemeSetting));
  const toggle = /** @type {HTMLButtonElement} */ (view.container.querySelector("[role=switch][aria-label='Use my own colour']"));
  assert.equal(toggle.getAttribute("aria-checked"), "false");
  assert.equal(view.container.querySelector("input[type=color]"), null, "no picker until it is on");

  await interact(() => toggle.click());
  assert.equal(root.dataset.accent, "custom");
  assert.equal(root.dataset.accentColor, "#2060b8", "starts from the theme's own colour (Classic, the default)");

  await interact(() => pick(/** @type {HTMLInputElement} */ (view.container.querySelector("input[type=color]")), "#2a78d6"));
  assert.equal(root.dataset.accentColor, "#2a78d6");
  assert.match(root.style.getPropertyValue("--custom-accent"), /^#[0-9a-f]{6}$/);
  assert.match(root.style.getPropertyValue("--custom-accent-dark"), /^#[0-9a-f]{6}$/);
  assert.equal(localStorage.getItem("xeldash.accent"), "#2a78d6", "kept in this browser");
  assert.doesNotMatch(view.text(), /close to the red/);

  await interact(() => pick(/** @type {HTMLInputElement} */ (view.container.querySelector("input[type=color]")), "#c62828"));
  assert.match(view.text(), /close to the red used for problems/, "a red is warned about");

  await interact(() => toggle.click());
  assert.equal(root.dataset.accent, undefined);
  assert.equal(root.style.getPropertyValue("--custom-accent"), "");
  assert.equal(localStorage.getItem("xeldash.accent"), null);
});

test("anything but a colour is refused", () => {
  setAccent("url(javascript:alert(1))");
  assert.equal(root.dataset.accent, undefined);
  assert.equal(localStorage.getItem("xeldash.accent"), null);
});
