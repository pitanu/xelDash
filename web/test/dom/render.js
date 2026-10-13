// Rendering helpers for the component tests: mount a component in the page, answer its API calls from a table, and wait
// for what it shows. Nothing here reaches a network.
import { act } from "react";
import { createRoot } from "react-dom/client";

/**
 * Answers for the dashboard's API calls, by path with its query string ("/api/v1/status") or by path alone. A value is the
 * JSON body; `{ status, body }` answers with that HTTP status; a function gets the request and returns either; `"offline"`
 * makes the request fail like an unreachable server. Unknown paths answer 404. Returns the paths asked, in order.
 * @param {Record<string, unknown>} routes
 */
export function fakeApi(routes) {
  /** @type {{ method: string, path: string, body: unknown }[]} */
  const calls = [];
  /** @param {RequestInfo | URL} input @param {RequestInit} [init] */
  const fetch = async (input, init = {}) => {
    const url = new URL(String(input), "http://xeldash.test/");
    const path = url.pathname + url.search;
    const body = typeof init.body === "string" ? JSON.parse(init.body) : null;
    const method = init.method ?? "GET";
    calls.push({ method, path, body });
    let answer = path in routes ? routes[path] : routes[`${method} ${url.pathname}`] ?? routes[url.pathname];
    if (typeof answer === "function") answer = await answer({ method, path, body });
    if (answer === "offline") throw new TypeError("Failed to fetch");
    if (answer === undefined) return json(404, { error: "not_found" });
    if (answer && typeof answer === "object" && "status" in answer && "body" in answer) return json(answer.status, answer.body);
    return json(200, answer);
  };
  globalThis.fetch = /** @type {typeof globalThis.fetch} */ (fetch);
  window.fetch = globalThis.fetch;
  return calls;
}

/** @param {number} status @param {unknown} body */
function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** @type {Set<() => Promise<void>>} */
const mounted = new Set();

/** Unmounts everything a test mounted, which also stops its polling timers. Call it from afterEach. */
export async function cleanup() {
  for (const unmount of [...mounted]) await unmount();
}

/**
 * Mount a React element and return the container. Effects and the first fetches run before it returns.
 * @param {import("react").ReactNode} element
 */
export async function render(element) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(element));
  await settle();
  const unmount = async () => {
    mounted.delete(unmount);
    await act(async () => root.unmount());
    container.remove();
  };
  mounted.add(unmount);
  return {
    container,
    /** Everything the component shows, as text with whitespace collapsed. */
    text: () => (container.textContent ?? "").replace(/\s+/g, " ").trim(),
    unmount,
  };
}

/** Lets pending fetches, state updates and effects finish. */
export async function settle() {
  for (let i = 0; i < 5; i++) await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
}

/** Runs an action that changes state (a click, a typed value) and lets the page catch up. @param {() => unknown} action */
export async function interact(action) {
  await act(async () => action());
  await settle();
}

/**
 * Types into an input the way a person does, so React sees the change.
 * @param {HTMLInputElement | HTMLTextAreaElement} input @param {string} value
 */
export async function type(input, value) {
  const proto = Object.getPrototypeOf(input);
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  await interact(() => {
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/**
 * The button, link or field whose text or accessible label matches.
 * @param {ParentNode} container @param {string | RegExp} name @param {string} [selector]
 * @returns {HTMLElement}
 */
export function getByText(container, name, selector = "button, a, input, textarea, select, label, [role]") {
  const matches = (/** @type {string} */ s) => (typeof name === "string" ? s.replace(/\s+/g, " ").trim() === name : name.test(s));
  for (const element of container.querySelectorAll(selector)) {
    const label = element.getAttribute("aria-label") ?? element.textContent ?? "";
    if (matches(label)) return /** @type {HTMLElement} */ (element);
  }
  throw new Error(`Nothing matching ${name} among ${selector}`);
}
