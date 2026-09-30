import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { MessageRateLimiter, normalizeIp } from "./ip-guard.js";

// The daemon's getwork server limits worker names to 32 characters; so do we.
const MAX_WORKER_NAME = 32;
const HEARTBEAT_MS = 30_000;

/** @typedef {import("./session.js").StratumSession} StratumSession */

// Control characters (terminal escapes, bells, newlines) could spoof log lines and alerts.
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/;

/**
 * Address and worker from /getwork/<address>/<worker>, or null when the path is malformed.
 * Request paths come straight from the client: `new URL` and `decodeURIComponent` both throw
 * on some inputs, and an exception here would take the whole Stratum process down.
 * @param {string | undefined} url
 */
export function parseGetworkPath(url) {
  try {
    const parts = new URL(url ?? "/", "http://localhost").pathname.split("/");
    if (parts.length !== 4 || parts[1] !== "getwork") return null;
    const address = decodeURIComponent(parts[2] ?? "");
    const worker = decodeURIComponent(parts[3] ?? "");
    if (!address || !worker || worker.length > MAX_WORKER_NAME || CONTROL_CHARACTERS.test(worker)) return null;
    return { address, worker };
  } catch {
    return null;
  }
}

/**
 * Presents a getwork WebSocket to StratumSession as a socket. The session writes Stratum
 * messages; mining.notify becomes a getwork `new_job` carrying the full MinerWork and the
 * share difficulty, so miners submit shares, not only blocks.
 */
class GetworkSocket {
  /** @param {import("ws").WebSocket} ws @param {string} ip */
  constructor(ws, ip) {
    this.ws = ws;
    this.remoteAddress = ip;
    /** @type {StratumSession | null} */
    this.session = null;
    /** @type {Map<number, (message: any) => void>} */
    this.pending = new Map();
  }

  get destroyed() {
    return this.ws.readyState !== this.ws.OPEN;
  }

  destroy() {
    this.ws.terminate();
  }

  /** @param {unknown} message */
  sendJson(message) {
    if (!this.destroyed) this.ws.send(JSON.stringify(message));
  }

  /** Receives the session's newline-delimited JSON-RPC output. @param {string} data */
  write(data) {
    for (const line of data.split("\n")) {
      if (!line) continue;
      const message = JSON.parse(line);
      if (typeof message.id === "number" && this.pending.has(message.id)) {
        this.pending.get(message.id)?.(message);
        this.pending.delete(message.id);
      } else if (message.method === "mining.notify") {
        this.sendJob(message.params[0]);
      }
    }
    return true;
  }

  /** @param {string} jobId */
  sendJob(jobId) {
    const job = this.session?.jobs.get(jobId);
    if (!job) return;
    this.sendJson({
      new_job: {
        algorithm: job.algorithm,
        miner_work: job.buildMinerWork("0000000000000000").toString("hex"),
        height: job.height,
        topoheight: job.topoheight,
        difficulty: String(job.shareDifficulty),
      },
    });
  }

  /** Run a Stratum request through the session and wait for its reply. @param {number} id @param {string} method @param {unknown[]} params */
  request(id, method, params) {
    const reply = new Promise((resolve) => this.pending.set(id, resolve));
    void this.session?.handleLine(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    return /** @type {Promise<any>} */ (reply);
  }
}

/**
 * Getwork-compatible WebSocket endpoint at /getwork/{address}/{worker}, for miners such as
 * the official xelis_miner. Replies follow the daemon: `block_accepted` or
 * `{ block_rejected: reason }` for block candidates, `{ block_rejected }` for invalid work.
 * Ordinary accepted shares get no reply, since the miner counts every `block_accepted` as a
 * block found.
 * @param {{ host: string, port: number,
 *   ipGuard: import("./ip-guard.js").IpGuard,
 *   rateLimit: { messagesPerSecond: number, messageBurst: number },
 *   sessions: Map<any, StratumSession>,
 *   createSession: (socket: GetworkSocket, ip: string) => StratumSession,
 *   onRefused?: (ip: string, reason: string) => void,
 *   logger?: Pick<Console, "info" | "warn"> }} options
 */
export function startGetworkServer({ host, port, ipGuard, rateLimit, sessions, createSession, onRefused = () => {}, logger = console }) {
  const server = createServer((_, response) => {
    response.writeHead(426, { "content-type": "text/plain" }).end("Connect with a getwork WebSocket client");
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4096 });

  server.on("upgrade", (request, socket, head) => {
    const ip = normalizeIp(request.socket.remoteAddress);
    // Miners never send an Origin header; browsers always do. Refusing browsers stops other
    // websites from opening getwork connections through a visitor's browser.
    if (request.headers.origin) {
      socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
    // "" / "getwork" / address / worker, like the daemon.
    const target = parseGetworkPath(request.url);
    if (!target) {
      socket.end("HTTP/1.1 400 Bad Request\r\n\r\nUse /getwork/<address>/<worker> (worker up to 32 characters)");
      return;
    }
    const { address, worker } = target;
    const refused = ipGuard.connect(ip);
    if (refused) {
      logger.warn?.(`Refusing getwork connection from ${ip}: ${refused}`);
      onRefused(ip, refused);
      socket.end(`HTTP/1.1 ${refused === "too many connections" ? "429 Too Many Requests" : "403 Forbidden"}\r\n\r\n`);
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => void onConnection(ws, ip, address, worker));
  });

  /** @param {import("ws").WebSocket} ws @param {string} ip @param {string} address @param {string} worker */
  async function onConnection(ws, ip, address, worker) {
    const socket = new GetworkSocket(ws, ip);
    const session = createSession(socket, ip);
    socket.session = session;
    sessions.set(socket, session);
    const limiter = new MessageRateLimiter(rateLimit);
    let alive = true;
    const heartbeat = setInterval(() => {
      if (!alive) {
        ws.terminate();
        return;
      }
      alive = false;
      ws.ping();
    }, HEARTBEAT_MS);
    heartbeat.unref();
    ws.on("pong", () => { alive = true; });
    ws.once("close", () => {
      clearInterval(heartbeat);
      session.close();
      sessions.delete(socket);
      ipGuard.disconnect(ip);
    });
    ws.on("error", () => ws.terminate());

    // Submissions are handled one at a time, in order, like Stratum's request queue.
    let queue = Promise.resolve();
    ws.on("message", (data) => {
      if (!limiter.take(1)) {
        logger.warn?.(`Closing getwork connection from ${ip}: message rate limit exceeded`);
        ipGuard.record(ip, false);
        ws.terminate();
        return;
      }
      queue = queue.then(() => onSubmit(String(data))).catch((error) => {
        logger.warn?.("Closing getwork connection after request failure:", error instanceof Error ? error.message : String(error));
        ws.terminate();
      });
    });

    /** @param {string} text */
    async function onSubmit(text) {
      /** @type {{ miner_work?: unknown, block_template?: unknown }} */
      let body;
      try {
        body = JSON.parse(text);
      } catch {
        ipGuard.record(ip, false);
        socket.sendJson({ block_rejected: "Invalid JSON" });
        return;
      }
      const result = await session.submitWork(worker, /** @type {string} */ (body?.miner_work ?? body?.block_template));
      if (result.block) {
        socket.sendJson(result.block.accepted ? "block_accepted" : { block_rejected: result.block.error ?? "Rejected by the daemon" });
      } else if (result.error && !result.stale) {
        socket.sendJson({ block_rejected: result.error.message });
      }
    }

    // Same handshake as a Stratum miner; the session then pushes the first job.
    const subscribed = await socket.request(1, "mining.subscribe", ["getwork", ["xel/v3"]]);
    const authorized = subscribed.error ? subscribed : await socket.request(2, "mining.authorize", [address, worker, ""]);
    if (authorized.error || authorized.result !== true) {
      const reason = authorized.error?.message ?? "Authorization failed";
      logger.warn?.(`Rejecting getwork miner ${worker} from ${ip}: ${reason}`);
      ws.close(1008, reason.slice(0, 120));
    }
  }

  server.listen(port, host, () => logger.info?.(`xelDash getwork listening on ${host}:${port}`));
  return {
    close() {
      for (const ws of wss.clients) ws.terminate();
      wss.close();
      return new Promise((resolve) => server.close(() => resolve(undefined)));
    },
  };
}
