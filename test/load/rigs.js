// Simulated rigs for the capacity test (test/load/run.js). Runs inside Docker on the stack's network.
//
// Each rig behaves like a real one that has settled on a fixed share difficulty of 1 (password "d=1", so every submission is valid and the
// server only pays for what a real rig would cost it: the connection, the job updates, hashing and recording each share):
//   subscribe, authorize, keep the newest job from mining.notify, and submit one share every SHARE_SECONDS (with jitter) under it.
// Stages add rigs and hold; after each stage one JSON line with the results goes to stdout.
//
//   node rigs.js ADDRESS HOST PORT STAGES HOLD_SECONDS SHARE_SECONDS      e.g. node rigs.js xet:... stratum 3333 100,500,1000 60 10
import net from "node:net";

const [address, host, portText, stagesText, holdText = "60", shareText = "10"] = process.argv.slice(2);
const PORT = Number(portText);
const STAGES = stagesText.split(",").map(Number);
const HOLD_MS = Number(holdText) * 1000;
const SHARE_MS = Number(shareText) * 1000;

/** @type {Rig[]} */
const rigs = [];
let created = 0;

/** Counters since the stage began. */
let stage = fresh();
function fresh() {
  return { connectFailed: 0, closedByServer: 0, authorized: 0, jobsReceived: 0, submitted: 0, accepted: 0, rejected: {}, errors: 0, latencies: [] };
}

class Rig {
  constructor(index) {
    this.name = `load-${index}`;
    this.jobId = null;
    this.buffer = "";
    this.pending = new Map();
    this.nextId = 10;
    this.open = false;
    this.timer = null;
    this.socket = net.connect(PORT, host);
    this.socket.setNoDelay(true);
    this.socket.on("connect", () => {
      this.open = true;
      this.send(1, "mining.subscribe", [`rig-sim/${index}`, ["xel/v3"]]);
      this.send(2, "mining.authorize", [address, this.name, "d=1"]);
    });
    this.socket.on("data", (chunk) => this.onData(chunk));
    this.socket.on("error", () => { if (!this.open) stage.connectFailed += 1; });
    this.socket.on("close", () => {
      if (this.open && !this.stopping) stage.closedByServer += 1;
      this.open = false;
      clearTimeout(this.timer);
    });
  }

  send(id, method, params) {
    if (this.socket.writable) this.socket.write(`${JSON.stringify({ id, method, params })}\n`);
  }

  onData(chunk) {
    this.buffer += chunk.toString("latin1");
    let nl;
    while ((nl = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      if (line) this.onLine(line);
    }
  }

  onLine(line) {
    let m;
    try { m = JSON.parse(line); } catch { stage.errors += 1; return; }
    if (m.method === "mining.notify") {
      this.jobId = m.params[0];
      stage.jobsReceived += 1;
      return;
    }
    if (m.id === 2) {
      if (m.result === true) { stage.authorized += 1; this.scheduleShare(true); } else stage.errors += 1;
      return;
    }
    const sent = this.pending.get(m.id);
    if (sent === undefined) return;
    this.pending.delete(m.id);
    stage.latencies.push(performance.now() - sent);
    if (m.result === true) stage.accepted += 1;
    else {
      const key = m.error ? `${m.error.code}:${m.error.message}` : "refused";
      stage.rejected[key] = (stage.rejected[key] ?? 0) + 1;
    }
  }

  scheduleShare(first) {
    // The first share is spread over a whole interval, so a stage's rigs do not all fire together.
    const wait = first ? Math.random() * SHARE_MS : SHARE_MS * (0.8 + Math.random() * 0.4);
    this.timer = setTimeout(() => {
      if (!this.open) return;
      if (this.jobId) {
        const id = this.nextId++;
        this.pending.set(id, performance.now());
        stage.submitted += 1;
        const nonce = Math.floor(Math.random() * 2 ** 48).toString(16).padStart(12, "0") + Math.floor(Math.random() * 65536).toString(16).padStart(4, "0");
        this.send(id, "mining.submit", [this.name, this.jobId, nonce]);
      }
      this.scheduleShare(false);
    }, wait);
  }

  stop() {
    this.stopping = true;
    clearTimeout(this.timer);
    this.socket.destroy();
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const percentile = (sorted, p) => (sorted.length === 0 ? null : Math.round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] * 10) / 10);

async function runStage(target) {
  stage = fresh();
  const began = Date.now();
  // Connect gradually (200 a second), like a farm starting up, not all in one instant.
  while (rigs.length < target) {
    for (let i = 0; i < 20 && rigs.length < target; i++) rigs.push(new Rig(created++));
    await sleep(100);
  }
  const rampMs = Date.now() - began;
  await sleep(5_000);
  // Only what happens while all of them are connected counts.
  stage = fresh();
  const heldFrom = Date.now();
  await sleep(HOLD_MS);
  const seconds = (Date.now() - heldFrom) / 1000;
  const lat = [...stage.latencies].sort((a, b) => a - b);
  const alive = rigs.filter((r) => r.open).length;
  console.log(JSON.stringify({
    stage: target, rampSeconds: Math.round(rampMs / 100) / 10, holdSeconds: Math.round(seconds), connected: alive, connectFailed: stage.connectFailed,
    closedByServer: stage.closedByServer, sharesSentPerSecond: Math.round((stage.submitted / seconds) * 10) / 10,
    accepted: stage.accepted, rejected: stage.rejected, errors: stage.errors, jobsPerSecond: Math.round((stage.jobsReceived / seconds) * 10) / 10,
    latencyMs: { p50: percentile(lat, 0.5), p95: percentile(lat, 0.95), p99: percentile(lat, 0.99), max: lat.at(-1) ?? null },
    from: heldFrom, to: Date.now(),
  }));
}

for (const target of STAGES) await runStage(target);
for (const rig of rigs) rig.stop();
console.log(JSON.stringify({ done: true }));
process.exit(0);
