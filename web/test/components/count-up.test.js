// A tile's number counts up from zero when animations are on; screen readers get the final value at once, and it ends exactly on it.
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { act, createElement as h } from "react";
import { cleanup, render } from "../dom/render.js";
import { StatTile } from "../../src/components/ui.jsx";

// The page text has its spaces collapsed, and some languages group digits with a no-break space (Finnish: "8 242 347").
const plain = (/** @type {string} */ text) => text.replace(/\s+/g, " ");

afterEach(async () => {
  await cleanup();
  document.documentElement.dataset.motion = "off";
});

test("with animations on, a tile counts up to its value", async () => {
  delete document.documentElement.dataset.motion;
  // Frames run when the test says, not on a clock, so a busy machine cannot finish the count before the test looks.
  const frames = /** @type {FrameRequestCallback[]} */ ([]);
  const { requestAnimationFrame, cancelAnimationFrame } = globalThis;
  globalThis.requestAnimationFrame = (callback) => frames.push(callback);
  globalThis.cancelAnimationFrame = () => {};
  try {
    const value = `${(8242347).toLocaleString()} H`;
    const view = await render(h(StatTile, { label: "Node height", value }));
    assert.equal(view.container.querySelector("[aria-hidden='true']")?.textContent, "0 H", "it starts from zero");
    assert.equal(view.container.querySelector(".sr-only")?.textContent, value, "screen readers get the final value at once");
    await act(async () => {
      const halfway = performance.now() + 300;
      for (const frame of frames.splice(0)) frame(halfway);
    });
    const middle = Number(view.container.querySelector("[aria-hidden='true']")?.textContent?.replace(/\D/g, ""));
    assert.ok(middle > 0 && middle < 8242347, `on its way up: ${middle}`);
    await act(async () => {
      const done = performance.now() + 2000;
      for (const frame of frames.splice(0)) frame(done);
    });
    assert.equal(view.text(), plain(`Node height${value}`), "it ends exactly on the value, as plain text");
  } finally {
    globalThis.requestAnimationFrame = requestAnimationFrame;
    globalThis.cancelAnimationFrame = cancelAnimationFrame;
  }
});

test("with animations off, the value is shown at once", async () => {
  const value = (8242347).toLocaleString();
  const view = await render(h(StatTile, { label: "Node height", value }));
  assert.equal(view.text(), plain(`Node height${value}`));
  assert.equal(view.container.querySelector("[aria-hidden='true']"), null);
});
