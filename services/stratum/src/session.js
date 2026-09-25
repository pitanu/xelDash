import { randomBytes, randomUUID } from "node:crypto";
import {
  STRATUM_ERRORS,
  encodeMessage,
  errorResponse,
  negotiateAlgorithm,
  parseRequest,
  response,
} from "./protocol.js";

const MAX_WORKER_NAME = 128;
const MAX_TRACKED_JOBS = 5;
/** @typedef {import("node:net").Socket} StratumSocket */
/** @typedef {import("./protocol.js").StratumRequest} StratumRequest */
/** @typedef {{ minerId: string | bigint, workerId: string | bigint, address: string, publicKey: string }} MiningIdentity */
/** @typedef {{ error?: { code: number, message: string, data?: unknown }, accepted?: boolean }} ShareResult */
/** @typedef {import("./job-provider.js").MiningJob} MiningJob */

export class StratumSession {
  /**
   * @param {{ socket: StratumSocket,
   *   authorizeAddress: (input: { address: string, workerName: string, password: string, ip?: string }) => Promise<MiningIdentity | null>,
   *   createJob?: ((input: { address: string, publicKey: string, extraNonce: string, algorithm: string }) => Promise<MiningJob>) | null,
   *   submitShare?: ((input: { worker: MiningIdentity, workerName: string, job: MiningJob, nonce: string, algorithm: string | null }) => Promise<ShareResult>) | null,
   *   onHashrate?: (input: { worker: MiningIdentity, workerName: string, hashrate: number }) => void,
   *   onAuthorized?: () => void,
   *   jobRefreshIntervalMs?: number,
   *   defaultAddress?: string,
   *   logger?: Pick<Console, "warn"> }} options
   */
  constructor({ socket, authorizeAddress, createJob = null, submitShare = null, onHashrate = () => {}, onAuthorized = () => {}, jobRefreshIntervalMs = 5000, defaultAddress = "", logger = console }) {
    this.socket = socket;
    this.authorizeAddress = authorizeAddress;
    this.createJob = createJob;
    this.submitShare = submitShare;
    this.onHashrate = onHashrate;
    this.onAuthorized = onAuthorized;
    this.jobRefreshIntervalMs = jobRefreshIntervalMs;
    this.defaultAddress = defaultAddress;
    this.logger = logger;
    this.algorithm = null;
    this.subscribed = false;
    this.agent = "";
    /** @type {Map<string, MiningIdentity>} */
    this.authorizedWorkers = new Map();
    /** @type {Map<string, MiningJob>} */
    this.jobs = new Map();
    /** @type {string | null} */
    this.miningAddress = null;
    this.extranonce = randomBytes(32).toString("hex");
    this.publicKey = "00".repeat(32);
    this.miningIdentity = null;
    this.jobRefreshTimer = null;
    this.refreshingJob = false;
    this.refreshQueued = false;
  }

  /** @param {string} line */
  async handleLine(line) {
    let request;
    try {
      request = parseRequest(JSON.parse(line));
    } catch (error) {
      this.send(errorResponse(null, -32600, error instanceof Error ? error.message : String(error)));
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
      this.logger.warn?.("Stratum request failed", {
        method: request.method,
        error: error instanceof Error ? error.message : String(error),
      });
      if (request.id !== null) this.send(errorResponse(request.id, STRATUM_ERRORS.UNKNOWN, "Request failed"));
    }
  }

  /** @param {StratumRequest} request */
  subscribe(request) {
    const [agent = "", supported = []] = request.params;
    if (typeof agent !== "string" || !Array.isArray(supported)
        || supported.some((algorithm) => typeof algorithm !== "string")) {
      this.send(errorResponse(request.id, -32602, "Invalid subscribe parameters"));
      return;
    }
    const algorithm = negotiateAlgorithm(supported);
    if (algorithm !== "xel/v3") {
      this.send(errorResponse(request.id, STRATUM_ERRORS.UNKNOWN, "Only xel/v3 is currently supported"));
      return;
    }
    this.algorithm = algorithm;
    this.subscribed = true;
    this.agent = agent.slice(0, 128);
    this.send(response(request.id, [randomUUID(), this.extranonce, 32, this.publicKey]));
  }

  /** @param {StratumRequest} request */
  async authorize(request) {
    if (!this.subscribed) {
      this.send(errorResponse(request.id, STRATUM_ERRORS.UNAUTHORIZED, "Subscribe before authorizing"));
      return;
    }
    const [requestedAddress, workerName = "default", password = ""] = request.params;
    if ((requestedAddress !== undefined && requestedAddress !== null
          && typeof requestedAddress !== "string") || typeof workerName !== "string"
        || workerName.length === 0 || workerName.length > MAX_WORKER_NAME
        || typeof password !== "string") {
      this.send(errorResponse(request.id, -32602, "Invalid authorize parameters"));
      return;
    }
    const address = typeof requestedAddress === "string" && requestedAddress.length > 0
      ? requestedAddress
      : this.defaultAddress;
    if (!address) {
      this.send(errorResponse(
        request.id,
        STRATUM_ERRORS.UNAUTHORIZED,
        "Provide a miner address or configure XELIS_DEFAULT_ADDRESS",
      ));
      return;
    }
    if (this.miningAddress !== null && this.miningAddress !== address) {
      this.send(errorResponse(
        request.id,
        STRATUM_ERRORS.UNAUTHORIZED,
        "A connection may authorize workers for only one mining address",
      ));
      return;
    }

    const identity = await this.authorizeAddress({ address, workerName, password, ip: this.socket.remoteAddress });
    if (!identity?.workerId || !identity?.publicKey) {
      this.send(errorResponse(request.id, STRATUM_ERRORS.UNAUTHORIZED, "Address is invalid or unauthorized"));
      return;
    }
    const miningAddress = identity.address ?? address;
    if (!/^[0-9a-f]{64}$/i.test(identity.publicKey)) {
      throw new Error("Address validator returned a malformed public key");
    }
    if (!this.createJob || !this.submitShare || this.algorithm !== "xel/v3") {
      this.send(errorResponse(request.id, STRATUM_ERRORS.UNKNOWN, "No validated xel/v3 mining job provider is available"));
      return;
    }
    const job = await this.createJob({
      address: miningAddress,
      publicKey: identity.publicKey,
      extraNonce: this.extranonce,
      algorithm: this.algorithm,
    });
    this.miningAddress = miningAddress;
    this.miningIdentity = identity;
    this.publicKey = identity.publicKey.toLowerCase();
    this.authorizedWorkers.set(workerName, identity);
    this.trackJob(job, true);
    this.onAuthorized();
    this.send(response(request.id, true));
    this.send({
      jsonrpc: "2.0",
      id: null,
      method: "mining.set_extranonce",
      params: [this.extranonce, 32, this.publicKey],
    });
    this.send({ jsonrpc: "2.0", id: null, method: "mining.set_difficulty", params: [job.shareDifficulty] });
    this.send({
      jsonrpc: "2.0",
      id: null,
      method: "mining.notify",
      params: [job.jobId, job.timestampHex, job.headerWorkHash, job.algorithm, true],
    });
    this.startJobRefresh();
  }

  startJobRefresh() {
    if (this.jobRefreshTimer || !this.createJob) return;
    this.jobRefreshTimer = setInterval(() => void this.refreshJob(), this.jobRefreshIntervalMs);
    this.jobRefreshTimer.unref();
  }

  /**
   * Fetch fresh work and notify the miner if it changed. Calls that arrive while a refresh is
   * in flight (for example a new_block event during a poll) are coalesced into one more pass,
   * so a tip change is never dropped.
   */
  async refreshJob() {
    if (!this.miningIdentity || !this.miningAddress || !this.algorithm
        || this.socket.destroyed || !this.createJob) return;
    if (this.refreshingJob) {
      this.refreshQueued = true;
      return;
    }
    this.refreshingJob = true;
    try {
      do {
        this.refreshQueued = false;
        await this.refreshJobOnce();
      } while (this.refreshQueued && !this.socket.destroyed);
    } finally {
      this.refreshingJob = false;
    }
  }

  async refreshJobOnce() {
    if (!this.miningIdentity || !this.miningAddress || !this.algorithm || !this.createJob) return;
    try {
      const job = await this.createJob({
        address: this.miningAddress,
        publicKey: this.miningIdentity.publicKey,
        extraNonce: this.extranonce,
        algorithm: this.algorithm,
      });
      const latestJob = [...this.jobs.values()].at(-1);
      if (latestJob && latestJob.headerWorkHash === job.headerWorkHash
          && latestJob.timestampHex === job.timestampHex
          && latestJob.shareDifficulty === job.shareDifficulty
          && latestJob.networkDifficulty === job.networkDifficulty) return;
      // Only a new chain tip (height) or difficulty change invalidates earlier work. A new
      // header hash at the same height usually means new mempool transactions; work on the
      // previous template is still a valid block, so miners need not restart.
      const cleanJobs = !latestJob || latestJob.height !== job.height
        || latestJob.networkDifficulty !== job.networkDifficulty;
      this.trackJob(job, cleanJobs);
      if (!latestJob || latestJob.shareDifficulty !== job.shareDifficulty) {
        this.send({ jsonrpc: "2.0", id: null, method: "mining.set_difficulty", params: [job.shareDifficulty] });
      }
      this.send({
        jsonrpc: "2.0",
        id: null,
        method: "mining.notify",
        params: [job.jobId, job.timestampHex, job.headerWorkHash, job.algorithm, cleanJobs],
      });
    } catch (error) {
      this.logger.warn?.("Unable to refresh Stratum job", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Keep recent jobs for late submissions. On a clean job, earlier jobs build on a superseded
   * tip, so they are dropped and their shares are rejected as stale.
   * @param {MiningJob} job @param {boolean} clean
   */
  trackJob(job, clean) {
    if (clean) this.jobs.clear();
    this.jobs.set(job.jobId, job);
    while (this.jobs.size > MAX_TRACKED_JOBS) {
      const oldestJobId = this.jobs.keys().next().value;
      if (!oldestJobId) break;
      this.jobs.delete(oldestJobId);
    }
  }

  close() {
    if (this.jobRefreshTimer) clearInterval(this.jobRefreshTimer);
    this.jobRefreshTimer = null;
  }

  /** @param {StratumRequest} request */
  async submit(request) {
    const [workerName, jobId, nonce] = request.params;
    if (typeof workerName !== "string" || typeof jobId !== "string"
        || typeof nonce !== "string" || !/^[0-9a-f]{16}$/i.test(nonce)) {
      this.send(errorResponse(request.id, -32602, "Invalid submit parameters"));
      return;
    }
    const worker = this.authorizedWorkers.get(workerName);
    if (!worker) {
      this.send(errorResponse(request.id, STRATUM_ERRORS.UNAUTHORIZED, "Worker is not authorized"));
      return;
    }
    if (!this.submitShare) {
      this.send(errorResponse(request.id, STRATUM_ERRORS.STALE_JOB, "No active mining job"));
      return;
    }
    const job = this.jobs.get(jobId);
    if (!job) {
      this.send(errorResponse(request.id, STRATUM_ERRORS.STALE_JOB, "Stale or unknown job"));
      return;
    }
    const result = await this.submitShare({ worker, workerName, job, nonce: nonce.toLowerCase(), algorithm: this.algorithm });
    if (result?.error) {
      this.send(errorResponse(request.id, result.error.code, result.error.message, result.error.data ?? null));
      return;
    }
    this.send(response(request.id, result?.accepted === true));
  }

  /** @param {StratumRequest} request */
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

  /** @param {unknown} message */
  send(message) {
    if (!this.socket.destroyed) this.socket.write(encodeMessage(message));
  }
}
