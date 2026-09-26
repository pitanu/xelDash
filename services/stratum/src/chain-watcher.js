const SUBSCRIPTION_ID = 1;
const MAX_RECONNECT_MS = 30_000;

/**
 * Converts the daemon's HTTP JSON-RPC URL to its WebSocket endpoint. The daemon serves
 * both on `/json_rpc`: POST for requests, GET upgrade for event subscriptions.
 * @param {string} rpcUrl
 */
export function toWebSocketUrl(rpcUrl) {
  const url = new URL(rpcUrl);
  if (url.protocol === "http:") url.protocol = "ws:";
  else if (url.protocol === "https:") url.protocol = "wss:";
  else if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    throw new Error(`Unsupported daemon RPC URL protocol: ${url.protocol}`);
  }
  return url.toString();
}

/**
 * Subscribes to the daemon's `new_block` event and calls `onNewBlock` for each block, so
 * sessions can push fresh work immediately instead of waiting for the next poll. Reconnects
 * with exponential backoff; per-session polling remains the fallback while disconnected.
 */
export class ChainWatcher {
  /**
   * @param {{ rpcUrl: string,
   *   onDisconnect?: () => void,
   *   onNewBlock: (block: { hash?: string, height?: number, topoheight?: number }) => void,
   *   logger?: Pick<Console, "info" | "warn">,
   *   WebSocketImpl?: typeof WebSocket }} options
   */
  constructor({ rpcUrl, onNewBlock, onDisconnect = () => {}, logger = console, WebSocketImpl = globalThis.WebSocket }) {
    if (typeof WebSocketImpl !== "function") {
      throw new Error("A WebSocket implementation is required (Node.js 22 provides one globally)");
    }
    this.url = toWebSocketUrl(rpcUrl);
    this.onNewBlock = onNewBlock;
    this.onDisconnect = onDisconnect;
    this.logger = logger;
    this.WebSocketImpl = WebSocketImpl;
    /** @type {WebSocket | null} */
    this.socket = null;
    /** @type {ReturnType<typeof setTimeout> | null} */
    this.reconnectTimer = null;
    this.reconnectDelayMs = 1_000;
    this.stopped = true;
    this.subscribed = false;
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.#connect();
  }

  stop() {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.socket?.close();
    this.socket = null;
    this.subscribed = false;
  }

  #connect() {
    if (this.stopped) return;
    let socket;
    try {
      socket = new this.WebSocketImpl(this.url);
    } catch (error) {
      this.logger.warn?.("Unable to open daemon event connection", { error: error instanceof Error ? error.message : String(error) });
      this.#scheduleReconnect();
      return;
    }
    this.socket = socket;

    socket.addEventListener("open", () => {
      socket.send(JSON.stringify({
        jsonrpc: "2.0",
        id: SUBSCRIPTION_ID,
        method: "subscribe",
        params: { notify: "new_block" },
      }));
    });

    socket.addEventListener("message", (event) => {
      /** @type {{ id?: unknown, result?: unknown, error?: { message?: string } }} */
      let message;
      try {
        message = JSON.parse(typeof event.data === "string" ? event.data : String(event.data));
      } catch {
        return;
      }
      if (message.id !== SUBSCRIPTION_ID) return;
      if (message.error) {
        this.logger.warn?.("Daemon rejected the new_block subscription", { error: message.error.message });
        socket.close();
        return;
      }
      if (typeof message.result === "boolean") {
        // `false` means this connection is already subscribed, which is still usable.
        this.subscribed = true;
        this.reconnectDelayMs = 1_000;
        this.logger.info?.("Subscribed to daemon new_block events");
        return;
      }
      const result = /** @type {{ event?: string, hash?: string, height?: number, topoheight?: number } | null} */ (message.result);
      if (result?.event !== "new_block") return;
      try {
        this.onNewBlock({ hash: result.hash, height: result.height, topoheight: result.topoheight });
      } catch (error) {
        this.logger.warn?.("new_block handler failed", { error: error instanceof Error ? error.message : String(error) });
      }
    });

    socket.addEventListener("close", () => {
      if (this.socket !== socket) return;
      this.socket = null;
      if (this.subscribed) {
        this.logger.warn?.(`Daemon event connection to ${this.url} closed; falling back to polling until it reconnects`);
        this.onDisconnect();
      }
      this.subscribed = false;
      this.#scheduleReconnect();
    });

    // A failed connection also emits "close", which schedules the reconnect.
    socket.addEventListener("error", () => {});
  }

  #scheduleReconnect() {
    if (this.stopped || this.reconnectTimer) return;
    const delay = this.reconnectDelayMs;
    this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, MAX_RECONNECT_MS);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.#connect();
    }, delay);
    this.reconnectTimer.unref?.();
  }
}
