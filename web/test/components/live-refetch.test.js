// What a live update refetches: panels that ask for the same thing at once share a request, a new block of the network refetches
// only what follows the chain tip, and an event (our block, a node change) refetches everything.
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { act, createElement as h } from "react";
import { cleanup, fakeApi, render, settle } from "../dom/render.js";

/** A live socket the test opens and sends messages on. */
class LiveSocket extends EventTarget {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  /** @type {LiveSocket | null} */
  static last = null;
  readyState = 0;
  /** @type {((event: unknown) => void) | null} */ onopen = null;
  /** @type {((event: { data: string }) => void) | null} */ onmessage = null;
  /** @type {((event: unknown) => void) | null} */ onclose = null;
  /** @type {((event: unknown) => void) | null} */ onerror = null;
  constructor() {
    super();
    LiveSocket.last = this;
  }
  send() {}
  close() {
    this.readyState = 3;
  }
}
globalThis.WebSocket = /** @type {any} */ (LiveSocket);
window.WebSocket = globalThis.WebSocket;
const { usePolled } = await import("../../src/api.js");

/** @param {{ path: string, everyBlock?: boolean }} props */
function Probe({ path, everyBlock = false }) {
  const { data } = usePolled(path, { everyBlock });
  return h("span", null, data ? JSON.stringify(data) : "…");
}

const routes = { "/api/v1/status": { height: 1 }, "/api/v1/miners": { miners: [] }, "/api/v1/events": { events: [] } };
/** @param {{ path: string }[]} calls @param {string} path */
const count = (calls, path) => calls.filter((c) => c.path === path).length;
/** Past the live debounce, so the refetches it starts have run. */
const afterDebounce = async () => {
  await act(async () => new Promise((resolve) => setTimeout(resolve, 500)));
  await settle();
};
/** @param {unknown} message */
const send = async (message) => act(async () => LiveSocket.last?.onmessage?.({ data: JSON.stringify(message) }));

afterEach(cleanup);

test("panels that ask for the same thing at the same moment share one request", async () => {
  const calls = fakeApi(routes);
  await render(h("div", null, h(Probe, { path: "/api/v1/status" }), h(Probe, { path: "/api/v1/status" }), h(Probe, { path: "/api/v1/miners" })));
  assert.equal(count(calls, "/api/v1/status"), 1);
  assert.equal(count(calls, "/api/v1/miners"), 1);
});

test("a new network block refetches only what follows the chain tip; an event refetches everything", async () => {
  const calls = fakeApi(routes);
  await render(h("div", null,
    h(Probe, { path: "/api/v1/status", everyBlock: true }),
    h(Probe, { path: "/api/v1/miners" }),
    h(Probe, { path: "/api/v1/events" })));
  await act(async () => LiveSocket.last?.onopen?.({}));
  await afterDebounce();
  const before = { status: count(calls, "/api/v1/status"), miners: count(calls, "/api/v1/miners"), events: count(calls, "/api/v1/events") };

  await send({ type: "block", height: 2, hash: "ab" });
  await afterDebounce();
  assert.equal(count(calls, "/api/v1/status"), before.status + 1, "the chain tip panel follows the block");
  assert.equal(count(calls, "/api/v1/miners"), before.miners, "the miners list waits");
  assert.equal(count(calls, "/api/v1/events"), before.events, "the events list waits");

  await send({ type: "event", eventType: "block_submitted" });
  await afterDebounce();
  assert.equal(count(calls, "/api/v1/miners"), before.miners + 1, "an event refetches everything");
  assert.equal(count(calls, "/api/v1/events"), before.events + 1);
});
