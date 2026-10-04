import { LIVE_CHANNEL } from "@xeldash/db";
import { WebSocketServer } from "ws";

const PATH = "/api/v1/live";
const MAX_CLIENTS = 100;
const HEARTBEAT_MS = 30_000;
const RELISTEN_MS = 5_000;

/** Request path, or null when the client sent something `new URL` cannot parse. @param {string | undefined} url */
function safePathname(url) {
  try {
    return new URL(url ?? "/", "http://localhost").pathname;
  } catch {
    return null;
  }
}

/**
 * Browsers send Origin with WebSocket requests. Only the dashboard's own origin may connect,
 * so another website cannot open the live feed through a visitor's browser.
 * @param {import("node:http").IncomingMessage} request
 */
function sameOrigin(request) {
  const origin = request.headers.origin;
  if (!origin) return true;
  try {
    // Hostnames only: a proxy in front (nginx here) may forward Host without the port.
    return new URL(origin).hostname === new URL(`http://${request.headers.host ?? ""}`).hostname;
  } catch {
    return false;
  }
}

/** @param {unknown} error */
function message(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Relays `xeldash_live` Postgres notifications to dashboards over WebSocket. Messages are
 * hints to refetch ({ type: "block" | "event", ... }); the REST endpoints stay the source of
 * truth. Clients fall back to polling whenever the socket is down.
 * @param {{ server: import("node:http").Server, pool: import("pg").Pool,
 *   onNotification?: (payload: string) => void, logger?: Pick<Console, "info" | "warn"> }} options
 */
export function startLiveUpdates({ server, pool, onNotification = () => {}, logger = console }) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 });
  /** @type {WeakSet<import("ws").WebSocket>} */
  const alive = new WeakSet();
  /** @type {import("pg").PoolClient | null} */
  let listener = null;
  let stopped = false;

  server.on("upgrade", (request, socket, head) => {
    // Node stops listening for a connection's errors once it is handed over as an upgrade, so an error on it (a client that resets) must be
    // absorbed here. (Refusals below destroy the socket at once, so this is a safeguard; getwork.js had a real case of it.)
    socket.on("error", () => {});
    const pathname = safePathname(request.url);
    if (pathname !== PATH || wss.clients.size >= MAX_CLIENTS || !sameOrigin(request)) {
      const status = pathname !== PATH ? "404 Not Found" : wss.clients.size >= MAX_CLIENTS ? "503 Service Unavailable" : "403 Forbidden";
      socket.write(`HTTP/1.1 ${status}\r\n\r\n`);
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => wss.emit("connection", ws));
  });

  wss.on("connection", (ws) => {
    alive.add(ws);
    ws.on("pong", () => alive.add(ws));
    // Dashboards only listen; anything they send is ignored.
    ws.on("message", () => {});
    ws.on("error", () => ws.terminate());
    ws.send(JSON.stringify({ type: "hello", listening: listener !== null }));
  });

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!alive.has(ws)) {
        ws.terminate();
        continue;
      }
      alive.delete(ws);
      ws.ping();
    }
  }, HEARTBEAT_MS);
  heartbeat.unref();

  /** @param {string} payload */
  function broadcast(payload) {
    for (const ws of wss.clients) {
      if (ws.readyState === ws.OPEN) ws.send(payload);
    }
  }

  async function listen() {
    if (stopped) return;
    /** @type {import("pg").PoolClient | null} */
    let client = null;
    try {
      client = await pool.connect();
      const connected = client;
      connected.on("notification", (notification) => {
        if (notification.channel !== LIVE_CHANNEL || !notification.payload) return;
        broadcast(notification.payload);
        onNotification(notification.payload);
      });
      connected.on("error", (error) => {
        logger.warn?.("Live update listener failed; reconnecting", { error: message(error) });
        connected.release(true);
        if (listener === connected) listener = null;
        setTimeout(listen, RELISTEN_MS).unref();
      });
      await connected.query(`LISTEN ${LIVE_CHANNEL}`);
      listener = connected;
      logger.info?.("Relaying live updates on /api/v1/live");
    } catch (error) {
      // A connection that was obtained but could not LISTEN must go back, or each retry would use up one of the pool's connections.
      try {
        client?.release(true);
      } catch {
        // Already given back by the error handler above.
      }
      logger.warn?.("Unable to listen for live updates; retrying", { error: message(error) });
      setTimeout(listen, RELISTEN_MS).unref();
    }
  }
  void listen();

  return {
    async stop() {
      stopped = true;
      clearInterval(heartbeat);
      for (const ws of wss.clients) ws.terminate();
      wss.close();
      if (listener) {
        const client = listener;
        listener = null;
        await client.query(`UNLISTEN ${LIVE_CHANNEL}`).catch(() => {});
        client.release();
      }
    },
  };
}
