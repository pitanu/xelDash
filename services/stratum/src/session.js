import { randomBytes, randomUUID } from "node:crypto";
import {
  STRATUM_ERRORS,
  encodeMessage,
  errorResponse,
  negotiateAlgorithm,
  parseRequest,
  response,
} from "./protocol.js";
import { DaemonRpcError } from "./daemon-client.js";
import { reissueJob } from "./job-provider.js";
import { DEFAULT_VARDIFF, Vardiff } from "./vardiff.js";

const MAX_WORKER_NAME = 128;
// Each new worker costs a daemon lookup and a database row; one rig needs only a few.
const MAX_WORKERS_PER_CONNECTION = 32;
// Control characters (terminal escapes, bells, newlines) could spoof log lines and alerts.
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/;
const MAX_TRACKED_JOBS = 5;
// Timestamp slack for getwork submissions: miners bump the work timestamp while hashing.
const MAX_FUTURE_TIMESTAMP_MS = 30_000;
/** A TCP socket, or the getwork WebSocket adapter. @typedef {{ remoteAddress?: string, destroyed: boolean, write: (data: string) => unknown }} StratumSocket */
/** @typedef {import("./protocol.js").StratumRequest} StratumRequest */
/** @typedef {{ minerId: string | bigint, workerId: string | bigint, address: string, publicKey: string }} MiningIdentity */
/** @typedef {{ error?: { code: number, message: string, data?: unknown }, accepted?: boolean, block?: { hash: string, accepted: boolean, error: string | null } | null, stale?: boolean }} ShareResult */
/** @typedef {import("./job-provider.js").MiningJob} MiningJob */

export class StratumSession {
  /**
   * @param {{ socket: StratumSocket,
   *   authorizeAddress: (input: { address: string, workerName: string, password: string, ip?: string }) => Promise<MiningIdentity | null>,
   *   createJob?: ((input: { address: string, publicKey: string, extraNonce: string, algorithm: string, shareDifficulty: number }) => Promise<MiningJob>) | null,
   *   submitShare?: ((input: { worker: MiningIdentity, workerName: string, job: MiningJob, nonce: string, minerWork?: Buffer | null, algorithm: string | null }) => Promise<ShareResult>) | null,
   *   onHashrate?: (input: { worker: MiningIdentity, workerName: string, hashrate: number }) => void,
   *   onAuthorized?: () => void,
   *   onSubmission?: (valid: boolean) => void,
   *   canMine?: () => string | null,
   *   jobRefreshIntervalMs?: number,
   *   vardiff?: import("./vardiff.js").VardiffConfig,
   *   defaultAddress?: string,
   *   logger?: Pick<Console, "warn"> }} options
   */
  constructor({ socket, authorizeAddress, createJob = null, submitShare = null, onHashrate = () => {}, onAuthorized = () => {}, onSubmission = () => {}, canMine = () => null, jobRefreshIntervalMs = 5000, vardiff = DEFAULT_VARDIFF, defaultAddress = "", logger = console }) {
    this.socket = socket;
    this.authorizeAddress = authorizeAddress;
    this.createJob = createJob;
    this.submitShare = submitShare;
    this.onHashrate = onHashrate;
    this.onAuthorized = onAuthorized;
    // Reports each submission as valid or invalid for abuse limits. Stale shares and requests
    // that fail on our side are not reported.
    this.onSubmission = onSubmission;
    // Returns why work cannot be issued right now (node syncing or down), or null.
    this.canMine = canMine;
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
    this.forceClean = false;
    this.vardiff = new Vardiff(vardiff);
  }

  /** @param {string} line */
  async handleLine(line) {
    let request;
    /** @type {unknown} */
    let parsed = null;
    try {
      parsed = JSON.parse(line);
      request = parseRequest(parsed);
    } catch (error) {
      this.onSubmission(false);
      // Answer under the request's own id when it has a usable one, so the miner can match it.
      const rawId = parsed && typeof parsed === "object" ? /** @type {Record<string, unknown>} */ (parsed).id : null;
      const id = typeof rawId === "string" || Number.isSafeInteger(rawId) ? /** @type {string | number} */ (rawId) : null;
      this.send(errorResponse(id, -32600, error instanceof Error ? error.message : String(error)));
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
    const paused = this.canMine();
    if (paused) {
      this.send(errorResponse(request.id, STRATUM_ERRORS.UNKNOWN, paused));
      return;
    }
    const [requestedAddress, workerName = "default", password = ""] = request.params;
    if ((requestedAddress !== undefined && requestedAddress !== null
          && typeof requestedAddress !== "string") || typeof workerName !== "string"
        || workerName.length === 0 || workerName.length > MAX_WORKER_NAME
        || CONTROL_CHARACTERS.test(workerName) || typeof password !== "string") {
      this.onSubmission(false);
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
    // Failed logins count toward the abuse limits like invalid shares: each one costs the node
    // an address lookup.
    if (this.miningAddress !== null && this.miningAddress !== address) {
      this.onSubmission(false);
      this.send(errorResponse(
        request.id,
        STRATUM_ERRORS.UNAUTHORIZED,
        "A connection may authorize workers for only one mining address",
      ));
      return;
    }

    // Logging in again as a known worker changes nothing.
    if (this.authorizedWorkers.has(workerName) && this.miningAddress === address) {
      this.send(response(request.id, true));
      return;
    }
    if (this.authorizedWorkers.size >= MAX_WORKERS_PER_CONNECTION) {
      this.onSubmission(false);
      this.send(errorResponse(request.id, STRATUM_ERRORS.UNAUTHORIZED, `At most ${MAX_WORKERS_PER_CONNECTION} workers per connection`));
      return;
    }

    /** @type {MiningIdentity | null} */
    let identity;
    try {
      identity = await this.authorizeAddress({ address, workerName, password, ip: this.socket.remoteAddress });
    } catch (error) {
      // The node rejecting a malformed address counts like any failed login; the node being
      // unreachable is not the miner's fault and does not.
      if (!(error instanceof DaemonRpcError)) throw error;
      identity = null;
    }
    if (!identity?.workerId || !identity?.publicKey) {
      this.onSubmission(false);
      this.send(errorResponse(request.id, STRATUM_ERRORS.UNAUTHORIZED, "Address is invalid or unauthorized"));
      return;
    }
    // Further workers on a connection share its job; only the first login fetches a template.
    if (this.miningIdentity && this.jobs.size > 0) {
      this.authorizedWorkers.set(workerName, identity);
      this.send(response(request.id, true));
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
      shareDifficulty: this.vardiff.difficulty,
    });
    if (this.miningAddress === null) this.vardiff.reset(Date.now());
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
    this.jobRefreshTimer = setInterval(() => {
      this.applyDifficulty(this.vardiff.retargetIfDue(this.maxShareDifficulty()));
      void this.refreshJob();
    }, this.jobRefreshIntervalMs);
    this.jobRefreshTimer.unref();
  }

  /**
   * Fetch fresh work and notify the miner if it changed. Calls that arrive while a refresh is
   * in flight (for example a new_block event during a poll) are coalesced into one more pass,
   * so a tip change is never dropped.
   */
  /** @param {boolean} [clean] Drop earlier jobs even at the same height (the node changed). */
  async refreshJob(clean = false) {
    if (clean) this.forceClean = true;
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
    if (this.canMine()) return;
    try {
      let job = await this.createJob({
        address: this.miningAddress,
        publicKey: this.miningIdentity.publicKey,
        extraNonce: this.extranonce,
        algorithm: this.algorithm,
        shareDifficulty: this.vardiff.difficulty,
      });
      // Vardiff may have retargeted while the template was being fetched.
      if (job.shareDifficulty !== this.vardiff.difficulty) job = reissueJob(job, this.vardiff.difficulty);
      const latestJob = [...this.jobs.values()].at(-1);
      if (latestJob && !this.forceClean && latestJob.nodeId === job.nodeId
          && latestJob.headerWorkHash === job.headerWorkHash
          && latestJob.timestampHex === job.timestampHex
          && latestJob.shareDifficulty === job.shareDifficulty
          && latestJob.networkDifficulty === job.networkDifficulty) return;
      // Only a new chain tip (height) or difficulty change invalidates earlier work. A new
      // header hash at the same height usually means new mempool transactions; work on the
      // previous template is still a valid block, so miners need not restart.
      // After a node switch, earlier jobs are dropped too: their templates belong to a node
      // that may no longer be able to take a block.
      const cleanJobs = !latestJob || this.forceClean || latestJob.height !== job.height
        || latestJob.networkDifficulty !== job.networkDifficulty;
      this.forceClean = false;
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

  maxShareDifficulty() {
    const latestJob = [...this.jobs.values()].at(-1);
    return latestJob ? Number(latestJob.networkDifficulty) : Number.MAX_SAFE_INTEGER;
  }

  /**
   * Send the latest work again at a new share difficulty. Earlier jobs stay valid at the
   * difficulty they were issued with, so in-flight shares are not lost.
   * @param {number | null} difficulty
   */
  applyDifficulty(difficulty) {
    const latestJob = [...this.jobs.values()].at(-1);
    if (difficulty === null || !latestJob || latestJob.shareDifficulty === difficulty) return;
    const job = reissueJob(latestJob, difficulty);
    if (job.shareDifficulty === latestJob.shareDifficulty) return;
    this.trackJob(job, false);
    this.send({ jsonrpc: "2.0", id: null, method: "mining.set_difficulty", params: [job.shareDifficulty] });
    this.send({
      jsonrpc: "2.0",
      id: null,
      method: "mining.notify",
      params: [job.jobId, job.timestampHex, job.headerWorkHash, job.algorithm, false],
    });
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
      this.onSubmission(false);
      this.send(errorResponse(request.id, -32602, "Invalid submit parameters"));
      return;
    }
    const worker = this.authorizedWorkers.get(workerName);
    if (!worker) {
      this.onSubmission(false);
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
    const result = await this.processShare({ worker, workerName, job, nonce: nonce.toLowerCase(), minerWork: null });
    if (result.error) {
      this.send(errorResponse(request.id, result.error.code, result.error.message, result.error.data ?? null));
    } else {
      this.send(response(request.id, result.accepted === true));
    }
    this.afterShare(result, job);
  }

  /**
   * Validate and record one share, reporting it for abuse limits. The caller replies to the
   * miner, then calls afterShare so a retarget reaches the miner after the reply.
   * @param {{ worker: MiningIdentity, workerName: string, job: MiningJob, nonce: string, minerWork: Buffer | null }} input
   * @returns {Promise<ShareResult>}
   */
  async processShare({ worker, workerName, job, nonce, minerWork }) {
    if (!this.submitShare) return { error: { code: STRATUM_ERRORS.STALE_JOB, message: "No active mining job" } };
    const result = await this.submitShare({ worker, workerName, job, nonce, minerWork, algorithm: this.algorithm });
    if (result?.error) {
      if (result.error.code === STRATUM_ERRORS.LOW_DIFFICULTY || result.error.code === STRATUM_ERRORS.DUPLICATE_SHARE) {
        this.onSubmission(false);
      }
      return result;
    }
    if (result?.accepted === true) this.onSubmission(true);
    return result ?? {};
  }

  /** @param {ShareResult} result @param {MiningJob} job */
  afterShare(result, job) {
    if (result.accepted === true) {
      this.applyDifficulty(this.vardiff.recordShare(job.shareDifficulty, this.maxShareDifficulty()));
    }
  }

  /**
   * Getwork submission: the miner sends its full 112-byte MinerWork. It may change the nonce,
   * the timestamp and the last two extranonce bytes (thread id); everything else must match a
   * job issued to this session. Stale work is reported, not counted against the miner.
   * @param {string} workerName @param {string} minerWorkHex @returns {Promise<ShareResult>}
   */
  async submitWork(workerName, minerWorkHex) {
    const worker = this.authorizedWorkers.get(workerName);
    if (!worker) {
      this.onSubmission(false);
      return { error: { code: STRATUM_ERRORS.UNAUTHORIZED, message: "Worker is not authorized" } };
    }
    if (typeof minerWorkHex !== "string" || !/^[0-9a-f]{224}$/i.test(minerWorkHex)) {
      this.onSubmission(false);
      return { error: { code: -32602, message: "MinerWork must be 112 bytes of hexadecimal" } };
    }
    const work = Buffer.from(minerWorkHex, "hex");
    const headerWorkHash = work.subarray(0, 32).toString("hex");
    // A header can be reissued at a new difficulty; the latest issue is what the miner has.
    const job = [...this.jobs.values()].reverse().find((candidate) => candidate.headerWorkHash === headerWorkHash);
    if (!job) return { stale: true, error: { code: STRATUM_ERRORS.STALE_JOB, message: "Stale or unknown job" } };

    const timestamp = work.readBigUInt64BE(32);
    const issued = BigInt(`0x${job.timestampHex}`);
    const validWork = work.subarray(80, 112).equals(job.publicKey)
      && work.subarray(48, 78).equals(job.extraNonce.subarray(0, 30))
      && timestamp >= issued
      && timestamp <= BigInt(Date.now() + MAX_FUTURE_TIMESTAMP_MS);
    if (!validWork) {
      this.onSubmission(false);
      return { error: { code: -32602, message: "MinerWork does not match the issued job" } };
    }
    // Timestamp, nonce and thread id identify the work, for duplicate detection.
    const nonce = `${work.subarray(32, 48).toString("hex")}${work.subarray(78, 80).toString("hex")}`;
    const result = await this.processShare({ worker, workerName, job, nonce, minerWork: work });
    this.afterShare(result, job);
    return result;
  }

  /** @param {StratumRequest} request */
  hashrate(request) {
    // Most miners send a number; some send it as a decimal string.
    const [raw] = request.params;
    const reported = typeof raw === "string" && /^\d+(\.\d+)?$/.test(raw) ? Number(raw) : raw;
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
