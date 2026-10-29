// Browser notifications (src/notifications.js and the Settings block): only the kinds this browser ticked, only once the browser
// allows them, only while the dashboard is in the background, one per alert however many tabs are open; a visitor of a public
// server can choose block news only.
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { createElement as h } from "react";
import { cleanup, interact, render } from "../dom/render.js";

// The live connection, so the test can deliver messages through it, and a Notification that records what it is asked to show.
const sockets = /** @type {any[]} */ ([]);
const Base = globalThis.WebSocket;
globalThis.WebSocket = window.WebSocket = /** @type {any} */ (class extends Base {
  /** @param {...any} args */
  constructor(...args) {
    super(...args);
    sockets.push(this);
  }
});
/** @type {{ title: string, options: any }[]} */
const shown = [];
class FakeNotification {
  static permission = "default";
  static async requestPermission() {
    FakeNotification.permission = "granted";
    return "granted";
  }
  /** @param {string} title @param {any} options */
  constructor(title, options) {
    shown.push({ title, options });
  }
  close() {}
}
globalThis.Notification = window.Notification = /** @type {any} */ (FakeNotification);
// The dashboard in a background tab.
Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });

const { setChosenNotifications, startNotifications } = await import("../../src/notifications.js");
const { default: NotificationSetting } = await import("../../src/components/NotificationSetting.jsx");

afterEach(async () => {
  await cleanup();
  shown.length = 0;
  setChosenNotifications([]);
});

/** @param {unknown} message */
const deliver = (message) => { for (const s of sockets) s.onmessage?.({ data: JSON.stringify(message) }); };
const alert = (/** @type {string} */ kind, /** @type {string} */ event, /** @type {string} */ text, data = {}) =>
  ({ type: "alert", kind, event, text, data, sentAt: "2026-10-29T10:00:00.000Z" });

test("the operator: only the ticked kinds, as the alert's own words, without the chat links", () => {
  FakeNotification.permission = "granted";
  const stop = startNotifications(false);
  setChosenNotifications(["worker_offline"]);
  deliver(alert("block_found", "block_found", "Block 100 found by rig1."));
  deliver(alert("worker_offline", "worker_offline", "Worker rig1 (xel:abc) has sent no accepted shares for 10 minutes.\nhttp://192.168.1.10:8088/#/miner/xel:abc/worker/rig1",
    { address: "xel:abc", worker: "rig1" }));
  deliver(alert("worker_offline", "worker_online", "Worker rig1 (xel:abc) is sending shares again.", { address: "xel:abc", worker: "rig1" }));
  stop();
  assert.deepEqual(shown.map((n) => n.title), [
    "Worker rig1 (xel:abc) has sent no accepted shares for 10 minutes.",
    "Worker rig1 (xel:abc) is sending shares again.",
  ], "not the block: it was not ticked");
  assert.equal(shown[0].options.body, "", "the link for chat apps is left out");
  assert.equal(shown[0].options.tag, "worker_offline:2026-10-29T10:00:00.000Z", "the same tag in every tab: the browser shows it once");
});

test("nothing is shown before the browser allows it, or while the dashboard is in front", () => {
  setChosenNotifications(["block_found"]);
  FakeNotification.permission = "default";
  const stop = startNotifications(false);
  deliver(alert("block_found", "block_found", "Block 100 found by rig1."));
  FakeNotification.permission = "granted";
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
  const focused = document.hasFocus;
  document.hasFocus = () => true;
  deliver(alert("block_found", "block_found", "Block 101 found by rig1."));
  document.hasFocus = focused;
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
  deliver(alert("block_found", "block_found", "Block 102 found by rig1."));
  stop();
  assert.deepEqual(shown.map((n) => n.title), ["Block 102 found by rig1."]);
});

test("a public server's visitor: block news only, from the live feed's block events; alerts never reach them anyway", () => {
  FakeNotification.permission = "granted";
  setChosenNotifications(["block_found", "worker_offline"]);
  const stop = startNotifications(true);
  deliver({ type: "event", id: "7", eventType: "block_submitted" });
  deliver(alert("worker_offline", "worker_offline", "Worker rig1 stopped."));
  stop();
  assert.deepEqual(shown.map((n) => n.title), ["A block was found on this server"]);
});

test("Settings: every kind for the operator, a block for a visitor; ticking one asks the browser first, then a test can be sent", async () => {
  FakeNotification.permission = "default";
  const operator = await render(h(NotificationSetting, {}));
  const boxes = () => /** @type {HTMLInputElement[]} */ ([...operator.container.querySelectorAll("input[type=checkbox]")]);
  assert.ok(boxes().length >= 12, "one per kind of alert");
  assert.match(operator.text(), /Allow notifications/);
  await interact(() => boxes()[0].click());
  assert.equal(FakeNotification.permission, "granted", "the browser was asked");
  assert.equal(boxes()[0].checked, true);
  const test = [...operator.container.querySelectorAll("button")].find((b) => b.textContent === "Send a test notification");
  assert.ok(test);
  await interact(() => test.click());
  assert.equal(shown.at(-1)?.title, "xelDash test notification");
  await cleanup();
  const visitor = await render(h(NotificationSetting, { visitor: true }));
  assert.equal(visitor.container.querySelectorAll("input[type=checkbox]").length, 1);
  assert.match(visitor.text(), /A block is found/);
});

test("blocked in the browser: Settings says how to allow it, and nothing can be ticked", async () => {
  FakeNotification.permission = "denied";
  const view = await render(h(NotificationSetting, {}));
  assert.match(view.text(), /blocked for this site/);
  assert.equal(/** @type {HTMLFieldSetElement} */ (view.container.querySelector("fieldset")).disabled, true);
});
