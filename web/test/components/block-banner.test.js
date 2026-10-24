// A block found while the dashboard is open: a "Block found!" card with its height, reward (once final) and effort, a way to the
// block, and a way to close it. The live message only says something happened; the block itself comes from the API.
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { createElement as h } from "react";
import { cleanup, fakeApi, interact, render, settle } from "../dom/render.js";

// The live connection, so the test can deliver a message through it (installed before the dashboard's modules load).
const sockets = /** @type {any[]} */ ([]);
const Base = globalThis.WebSocket;
globalThis.WebSocket = window.WebSocket = /** @type {any} */ (class extends Base {
  /** @param {...any} args */
  constructor(...args) {
    super(...args);
    sockets.push(this);
  }
});
const { default: BlockBanner } = await import("../../src/components/BlockBanner.jsx");

afterEach(cleanup);

fakeApi({
  "/api/v1/blocks?limit=1": { blocks: [{ hash: "ab".repeat(32), height: "8264500", worker: "rig1", reward: null, effort: 0.62 }] },
});

/** Sends a live "block found" message, as the API does when a block is submitted. */
function blockFound() {
  for (const socket of sockets) socket.onmessage?.({ data: JSON.stringify({ type: "event", eventType: "block_submitted" }) });
}

test("a found block shows as a card with its height, effort and a way to it, until it is closed", async () => {
  const view = await render(h(BlockBanner));
  assert.equal(view.text(), "", "nothing until a block is found");
  blockFound();
  await settle();
  const text = view.text();
  assert.match(text, /Block found!/);
  assert.match(text, /by rig1/);
  assert.match(text.replace(/\s/g, ""), /8[^0-9]?264[^0-9]?500/, "the height");
  assert.match(text, /Effort.*62%/);
  assert.match(text, /Reward.*when final/, "the reward is known once the block is final");
  const link = [...view.container.querySelectorAll("a")].find((a) => a.textContent === "View block");
  assert.ok(link, "a way to the block");
  await interact(() => /** @type {HTMLButtonElement} */ (view.container.querySelector("button[aria-label=Dismiss]")).click());
  assert.equal(view.text(), "", "closed");
});
