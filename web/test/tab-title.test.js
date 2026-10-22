// The tab title counts blocks found while the tab is out of view, and goes back to plain once it is looked at.
import test from "node:test";
import assert from "node:assert/strict";
import { watchUnseenBlocks } from "../src/tab-title.js";

/** A stand-in page: a document and window whose visibility and focus the test sets. */
function page() {
  const doc = Object.assign(new EventTarget(), { title: "xelDash", hidden: false, focused: true, hasFocus() { return this.focused; } });
  const win = new EventTarget();
  /** @param {{ hidden: boolean, focused: boolean }} state */
  const set = (state) => {
    Object.assign(doc, state);
    doc.dispatchEvent(new Event("visibilitychange"));
    if (state.focused) win.dispatchEvent(new Event("focus"));
  };
  return { doc, win, set, title: watchUnseenBlocks(/** @type {any} */ (doc), /** @type {any} */ (win)) };
}

test("a block found while the tab is in view leaves the title alone", () => {
  const { doc, title } = page();
  title.blockFound();
  assert.equal(doc.title, "xelDash");
});

test("blocks found on a hidden tab are counted in its title until it is looked at", () => {
  const { doc, set, title } = page();
  set({ hidden: true, focused: false });
  title.blockFound();
  assert.equal(doc.title, "(1) Block found · xelDash");
  title.blockFound();
  assert.equal(doc.title, "(2) Block found · xelDash");
  set({ hidden: false, focused: true });
  assert.equal(doc.title, "xelDash");
  title.blockFound();
  assert.equal(doc.title, "xelDash");
});

test("a visible tab without focus is marked too, and cleared when it gets focus", () => {
  const { doc, set, title } = page();
  set({ hidden: false, focused: false });
  title.blockFound();
  assert.equal(doc.title, "(1) Block found · xelDash");
  set({ hidden: false, focused: true });
  assert.equal(doc.title, "xelDash");
});

test("stopping puts the plain title back", () => {
  const { doc, set, title } = page();
  set({ hidden: true, focused: false });
  title.blockFound();
  title.stop();
  assert.equal(doc.title, "xelDash");
});
