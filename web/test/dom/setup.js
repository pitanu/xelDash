// Loaded before every component test (node --import): the .jsx compiler, a browser-like page from happy-dom, and a stand-in
// for the live-updates WebSocket that never connects (pages then poll, as they do when live updates are down). Each test file
// runs in its own process, so module state (the server mode, the live socket) starts fresh in each.
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { transformSync } from "rolldown/experimental";

// The dashboard's .jsx is compiled with the compiler Vite's build uses; stylesheet imports become nothing.
registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith(".css")) return { format: "module", source: "", shortCircuit: true };
    if (!url.endsWith(".jsx")) return nextLoad(url, context);
    const path = fileURLToPath(url);
    const { code, errors } = transformSync(path, readFileSync(path, "utf8"), { lang: "jsx", jsx: { runtime: "automatic" } });
    if (errors.length > 0) throw new Error(`${path}: ${errors.map((e) => e.message).join("; ")}`);
    return { format: "module", source: code, shortCircuit: true };
  },
});
GlobalRegistrator.register({ url: "http://xeldash.test/" });
// Animations off, as with Settings turned off, so pages show their final numbers at once (count-up.test.js turns them on).
document.documentElement.dataset.motion = "off";
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

class QuietWebSocket extends EventTarget {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  readyState = 0;
  /** @type {((event: unknown) => void) | null} */ onopen = null;
  /** @type {((event: unknown) => void) | null} */ onmessage = null;
  /** @type {((event: unknown) => void) | null} */ onclose = null;
  /** @type {((event: unknown) => void) | null} */ onerror = null;
  send() {}
  close() {
    this.readyState = 3;
  }
}
globalThis.WebSocket = /** @type {any} */ (QuietWebSocket);
window.WebSocket = globalThis.WebSocket;
