import { randomBytes, randomUUID } from "node:crypto";
import {
  DEFAULT_ALGORITHM,
  STRATUM_ERRORS,
  encodeMessage,
  errorResponse,
  negotiateAlgorithm,
  parseRequest,
  response,
} from "./protocol.js";

const MAX_WORKER_NAME = 128;

export class StratumSession {
  constructor({ socket, authorizeAddress, submitShare, onHashrate = () => {}, logger = console }) {
    this.socket = socket;
    this.authorizeAddress = authorizeAddress;
    this.submitShare = submitShare;
    this.onHashrate = onHashrate;
    this.logger = logger;
    this.algorithm = null;
    this.subscribed = false;
    this.authorizedWorkers = new Map();
    this.extranonce = randomBytes(32).toString("hex");
    this.publicKey = "00".repeat(32);
  }

  async handleLine(line) {
    let request;
    try {
      request = parseRequest(JSON.parse(line));
    } catch (error) {
      this.send(errorResponse(null, -32600, error.message));
      return;
    }

    try {
      switch (request.method) {
        case "mining.subscribe": return this.subscribe(request);
        case "mining.authorize": return await this.authorize(request);
        case "mining.submit": return await this.submit(request);
        case "mining.hashrate": return this.hashrate(request);
        case "mining.pong": return;
        default:
          if (request.id !== null) this.send(errorResponse(request.id, -32601, "Method not found"));
      }
    } catch (error) {
      this.logger.warn?.("Stratum request failed", { method: request.method, error: error.message });
      if (request.id !== null) this.send(errorResponse(request.id, STRATUM_ERRORS.UNKNOWN, "Request failed"));
    }
  }

  subscribe(request) {
    const [agent = "", supported = []] = request.params;
    if (typeof agent !== "string" || !Array.isArray(supported)
        || supported.some((algorithm) => typeof algorithm !== "string")) {
      this.send(errorResponse(request.id, -32602, "Invalid subscribe parameters"));
      return;
    }
    const algorithm = negotiateAlgorithm(supported);
    if (!algorithm) {
      this.send(errorResponse(request.id, STRATUM_ERRORS.UNKNOWN, "No supported XELIS algorithm"));
      return;
    }
    this.algorithm = algorithm;
    this.subscribed = true;
    this.agent = agent.slice(0, 128);
    this.send(response(request.id, [randomUUID(), this.extranonce, 32, this.publicKey]));
  }

  async authorize(request) {
    if (!this.subscribed) {
      this.send(errorResponse(request.id, STRATUM_ERRORS.UNAUTHORIZED, "Subscribe before authorizing"));
      return;
    }
    const [address, workerName = "default", password = ""] = request.params;
    if (typeof address !== "string" || typeof workerName !== "string"
        || workerName.length === 0 || workerName.length > MAX_WORKER_NAME
        || typeof password !== "string") {
      this.send(errorResponse(request.id, -32602, "Invalid authorize parameters"));
      return;
    }

    const identity = await this.authorizeAddress({ address, workerName, password, ip: this.socket.remoteAddress });
    if (!identity?.workerId || !identity?.publicKey) {
      this.send(errorResponse(request.id, STRATUM_ERRORS.UNAUTHORIZED, "Address is invalid or unauthorized"));
      return;
    }
    if (!/^[0-9a-f]{64}$/i.test(identity.publicKey)) {
      throw new Error("Address validator returned a malformed public key");
    }
    this.publicKey = identity.publicKey.toLowerCase();
    this.authorizedWorkers.set(workerName, identity);
    this.send(response(request.id, true));
    this.send({
      jsonrpc: "2.0",
      id: null,
      method: "mining.set_extranonce",
      params: [this.extranonce, 32, this.publicKey],
    });
  }

  async submit(request) {
    const [workerName, jobId, nonce] = request.params;
    const worker = this.authorizedWorkers.get(workerName);
    if (!worker) {
      this.send(errorResponse(request.id, STRATUM_ERRORS.UNAUTHORIZED, "Worker is not authorized"));
      return;
    }
    if (typeof jobId !== "string" || typeof nonce !== "string" || !/^[0-9a-f]{16}$/i.test(nonce)) {
      this.send(errorResponse(request.id, -32602, "Invalid submit parameters"));
      return;
    }
    if (!this.submitShare) {
      this.send(errorResponse(request.id, STRATUM_ERRORS.STALE_JOB, "No active mining job"));
      return;
    }
    const result = await this.submitShare({ worker, workerName, jobId, nonce: nonce.toLowerCase(), algorithm: this.algorithm });
    if (result?.error) {
      this.send(errorResponse(request.id, result.error.code, result.error.message, result.error.data ?? null));
      return;
    }
    this.send(response(request.id, result?.accepted === true));
  }

  hashrate(request) {
    const [reported] = request.params;
    if (typeof reported !== "number" || !Number.isFinite(reported) || reported < 0) {
      if (request.id !== null) this.send(errorResponse(request.id, -32602, "Hashrate must be a nonnegative number"));
      return;
    }
    for (const [workerName, worker] of this.authorizedWorkers) {
      this.onHashrate({ worker, workerName, hashrate: reported });
    }
    if (request.id !== null) this.send(response(request.id, true));
  }

  send(message) {
    if (!this.socket.destroyed) this.socket.write(encodeMessage(message));
  }
}
