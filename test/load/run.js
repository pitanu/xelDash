// Capacity test (npm run load): how many rigs one xelDash server can carry, and what it costs. Starts the real stack in Docker on a
// private devnet (its own project and ports), mines the first blocks, then adds simulated rigs in stages (test/load/rigs.js) while
// sampling the containers' CPU and memory, the dashboard's response time, the node's block rate and the database's write rate.
//
//   npm run load                      stages 100, 500, 1000, 2000 for 60 s each, with a miner producing blocks in the background
//   LOAD_STAGES=50,200 LOAD_HOLD=30 npm run load
//   LOAD_CHAIN=0 npm run load          no blocks while it runs (jobs change only with the periodic refresh)
//   LOAD_KEEP=1 npm run load           leave the stack running afterwards
//
// Needs Docker and about 15 minutes. Results are printed as a table; they depend on the computer it runs on, so read them as an
// order of magnitude and say what hardware they came from.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, cpus, totalmem } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const PROJECT = "xeldash-load";
const WEB = "http://127.0.0.1:38088";
const ADDRESS = "xet:vs3mfyywt0fjys0rgslue7mm4wr23xdgejsjk0ld7f2kxng4d4nqqt98v9u";
const MINER_IMAGE = "xelis/miner:1.21.3";
const STAGES = process.env.LOAD_STAGES ?? "100,500,1000,2000";
const HOLD = process.env.LOAD_HOLD ?? "60";
const SHARE_SECONDS = process.env.LOAD_SHARE_SECONDS ?? "10";
const CHAIN = (process.env.LOAD_CHAIN ?? "1") === "1";
const SERVICES = ["stratum", "daemon", "postgres", "api", "web"];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let envFile = "";

function run(command, args, { timeout = 600_000, allowFail = false } = {}) {
  const r = spawnSync(command, args, { cwd: root, encoding: "utf8", timeout, maxBuffer: 256 * 1024 * 1024 });
  const text = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  if (r.status !== 0 && !allowFail) throw new Error(`${command} ${args.join(" ")} failed (${r.status}):\n${text.slice(-1500)}`);
  return { status: r.status, text };
}
const compose = (args, options) => run("docker", ["compose", "-p", PROJECT, "--env-file", envFile, ...args], options);
const docker = (args, options) => run("docker", args, options);

async function get(path) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  const began = performance.now();
  try {
    const response = await fetch(`${WEB}${path}`, { signal: controller.signal });
    const body = await response.json();
    return { ms: performance.now() - began, body };
  } finally {
    clearTimeout(timer);
  }
}

async function waitFor(what, check, timeoutMs = 300_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try { const v = await check(); if (v) return v; } catch { /* not yet */ }
    await sleep(2_000);
  }
  throw new Error(`Timed out waiting for ${what}`);
}

const number = (text) => Number.parseFloat(String(text).replace(",", "."));
function megabytes(text) {
  const [used] = String(text).split("/");
  const n = number(used);
  if (/GiB/i.test(used)) return n * 1024;
  if (/KiB/i.test(used)) return n / 1024;
  if (/MiB/i.test(used)) return n;
  if (/GB/i.test(used)) return n * 953.7;
  if (/MB/i.test(used)) return n * 0.9537;
  return n;
}

// ------------------------------------------------------------ sampling

const samples = [];
let sampling = true;
async function sampler() {
  let lastShares = null;
  while (sampling) {
    const at = Date.now();
    const row = { at, containers: {}, overviewMs: null, statusMs: null, height: null, shares: null };
    const stats = docker(["stats", "--no-stream", "--format", "{{json .}}", ...SERVICES.map((s) => `${PROJECT}-${s}-1`)], { allowFail: true, timeout: 60_000 });
    for (const line of stats.text.split("\n").filter((l) => l.startsWith("{"))) {
      try {
        const s = JSON.parse(line);
        row.containers[s.Name.replace(`${PROJECT}-`, "").replace("-1", "")] = { cpu: number(s.CPUPerc), mb: megabytes(s.MemUsage) };
      } catch { /* a partial line */ }
    }
    try { const o = await get("/api/v1/overview"); row.overviewMs = o.ms; row.height = o.body.node?.height ?? null; } catch { row.overviewMs = null; }
    try { row.statusMs = (await get("/api/v1/status")).ms; } catch { row.statusMs = null; }
    const shares = compose(["exec", "-T", "postgres", "psql", "-U", "xeldash", "-d", "xeldash", "-tAc", "select count(*) from shares"], { allowFail: true, timeout: 30_000 });
    row.shares = Number.parseInt(shares.text.trim(), 10);
    if (Number.isNaN(row.shares)) row.shares = lastShares;
    lastShares = row.shares;
    samples.push(row);
    await sleep(Math.max(500, 5_000 - (Date.now() - at)));
  }
}

const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const max = (xs) => (xs.length ? Math.max(...xs) : null);
const pct = (xs, p) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };
const fmt = (n, d = 0) => (n === null || n === undefined || Number.isNaN(n) ? "-" : n.toFixed(d));

// ------------------------------------------------------------ the run

async function main() {
  envFile = join(mkdtempSync(join(tmpdir(), "xeldash-load-")), "env");
  writeFileSync(envFile, [
    "POSTGRES_PASSWORD=load-only-password", "XELIS_NETWORK=devnet", "XELIS_SNAPSHOT_AUTO=false", "XELDASH_VERSION=local",
    "XELDASH_ADMIN_TOKEN=loadadmintoken0123456789abcdef", "XELDASH_WEB_PORT=38088", "XELDASH_API_PORT=38081",
    "XELDASH_STRATUM_PORT=33333", "XELDASH_STRATUM_TLS_PORT=33334", "XELDASH_GETWORK_PORT=38090", "XELIS_P2P_PORT=32125",
    "XELDASH_VERSION_CHECK=off", "XELDASH_PRICE=off",
    // Every simulated rig comes from one address, and mines at share difficulty 1 so that a share costs the server what a real one does.
    "STRATUM_START_DIFFICULTY=1", "STRATUM_MIN_DIFFICULTY=1", "STRATUM_MAX_CONNECTIONS_PER_IP=100000",
    `XELIS_DEFAULT_ADDRESS=${ADDRESS}`, "",
  ].join("\n"));
  console.log(`Computer: ${cpus().length} threads (${cpus()[0].model.trim()}), ${(totalmem() / 2 ** 30).toFixed(1)} GiB memory, ${process.platform}`);
  console.log(`Stages: ${STAGES} rigs, ${HOLD} s each, one share per rig every ${SHARE_SECONDS} s${CHAIN ? ", with a miner producing blocks in the background" : ""}`);

  compose(["down", "-v", "--remove-orphans"], { allowFail: true });
  console.log("Starting the stack (builds the images the first time)...");
  compose(["up", "-d", "--build"], { timeout: 1_800_000 });
  await waitFor("the stack", async () => { const s = (await get("/api/v1/status")).body; return s.services.database.ok && s.services.daemon.ok; });

  console.log("Mining the first blocks...");
  docker(["rm", "-f", "load-boot"], { allowFail: true });
  docker(["run", "-d", "--name", "load-boot", "--network", `${PROJECT}_node`, MINER_IMAGE, "--miner-address", ADDRESS, "--daemon-address", "ws://daemon:8080", "--num-threads", "4", "--disable-interactive-mode"]);
  await waitFor("height 15", async () => (await get("/api/v1/status")).body.node.height >= 15, 600_000);
  docker(["rm", "-f", "load-boot"], { allowFail: true });
  await waitFor("Stratum", async () => { const s = (await get("/api/v1/status")).body.services.stratum; return s.ok && !s.paused; });

  if (CHAIN) {
    // Other miners on the network keep finding blocks, and every block makes the server refresh every rig's work: keep that going.
    docker(["rm", "-f", "load-chain"], { allowFail: true });
    docker(["run", "-d", "--name", "load-chain", "--network", `${PROJECT}_node`, MINER_IMAGE, "--miner-address", ADDRESS, "--daemon-address", "ws://daemon:8080", "--num-threads", "1", "--disable-interactive-mode"]);
  }
  await sleep(5_000);

  const sampling_ = sampler();
  const idle = samples.length;
  await sleep(15_000);
  const baseline = samples.slice(idle);

  console.log("Starting the rigs...");
  docker(["rm", "-f", "load-rigs"], { allowFail: true });
  docker(["run", "-d", "--name", "load-rigs", "--network", `${PROJECT}_node`, "-v", `${join(root, "test/load")}:/load:ro`, "ghcr.io/pitanu/xeldash/stratum:local",
    "node", "/load/rigs.js", ADDRESS, "stratum", "3333", STAGES, HOLD, SHARE_SECONDS]);
  const results = [];
  const stagesCount = STAGES.split(",").length;
  const deadline = Date.now() + (Number(HOLD) + 240) * 1000 * stagesCount;
  while (Date.now() < deadline) {
    const logs = docker(["logs", "load-rigs"], { allowFail: true }).text;
    const lines = logs.split("\n").filter((l) => l.startsWith("{")).map((l) => JSON.parse(l));
    results.length = 0;
    results.push(...lines.filter((l) => l.stage));
    if (lines.some((l) => l.done)) break;
    await sleep(5_000);
  }
  sampling = false;
  await sampling_;
  const heightsFrom = samples.find((s) => s.height !== null);

  // ------------------------------------------------------------ report
  const rows = [];
  const slice = (from, to) => samples.filter((s) => s.at >= from && s.at <= to);
  const describe = (label, rigs, from, to, extra = {}) => {
    const s = slice(from, to);
    const cpu = (name) => s.map((x) => x.containers[name]?.cpu).filter((v) => typeof v === "number");
    const mem = (name) => s.map((x) => x.containers[name]?.mb).filter((v) => typeof v === "number");
    const withShares = s.filter((x) => typeof x.shares === "number");
    const sharesPerSecond = withShares.length >= 2 ? (withShares.at(-1).shares - withShares[0].shares) / ((withShares.at(-1).at - withShares[0].at) / 1000) : null;
    const heights = s.map((x) => x.height).filter((h) => typeof h === "number");
    const blocksPerMinute = heights.length >= 2 ? ((heights.at(-1) - heights[0]) / ((s.at(-1).at - s[0].at) / 60000)) : null;
    rows.push({ label, rigs, stratumCpuAvg: avg(cpu("stratum")), stratumCpuMax: max(cpu("stratum")), stratumMb: max(mem("stratum")), daemonCpuAvg: avg(cpu("daemon")),
      postgresCpuAvg: avg(cpu("postgres")), apiCpuAvg: avg(cpu("api")), overviewAvg: avg(s.map((x) => x.overviewMs).filter((v) => v !== null)),
      overviewP95: pct(s.map((x) => x.overviewMs).filter((v) => v !== null), 0.95), sharesPerSecond, blocksPerMinute, ...extra });
  };
  if (baseline.length) describe("idle", 0, baseline[0].at, baseline.at(-1).at);
  for (const r of results) describe(String(r.stage), r.stage, r.from, r.to, { connected: r.connected, failed: r.connectFailed, dropped: r.closedByServer, sent: r.sharesSentPerSecond,
    accepted: r.accepted, rejected: Object.values(r.rejected).reduce((a, b) => a + b, 0), reasons: r.rejected, p50: r.latencyMs.p50, p95: r.latencyMs.p95, p99: r.latencyMs.p99, jobs: r.jobsPerSecond });

  console.log("\n| rigs | connected | shares/s sent | accepted | stale/rejected | submit latency p50 / p95 / p99 (ms) | jobs/s to rigs | blocks/min |");
  console.log("|---:|---:|---:|---:|---:|---|---:|---:|");
  for (const r of rows.filter((x) => x.label !== "idle")) {
    console.log(`| ${r.rigs} | ${r.connected} (${r.failed} failed, ${r.dropped} dropped) | ${fmt(r.sent, 1)} | ${r.accepted} | ${r.rejected} | ${fmt(r.p50, 1)} / ${fmt(r.p95, 1)} / ${fmt(r.p99, 1)} | ${fmt(r.jobs, 1)} | ${fmt(r.blocksPerMinute, 1)} |`);
  }
  console.log("\n| rigs | Stratum CPU avg / max (% of one core) | Stratum memory (MB) | node CPU avg | database CPU avg | API CPU avg | dashboard /overview avg / p95 (ms) | rows written/s |");
  console.log("|---:|---|---:|---:|---:|---:|---|---:|");
  for (const r of rows) {
    console.log(`| ${r.label === "idle" ? "0 (idle)" : r.rigs} | ${fmt(r.stratumCpuAvg)} / ${fmt(r.stratumCpuMax)} | ${fmt(r.stratumMb)} | ${fmt(r.daemonCpuAvg)} | ${fmt(r.postgresCpuAvg)} | ${fmt(r.apiCpuAvg)} | ${fmt(r.overviewAvg)} / ${fmt(r.overviewP95)} | ${fmt(r.sharesPerSecond, 1)} |`);
  }
  for (const r of rows) if (r.reasons && Object.keys(r.reasons).length) console.log(`\nRefused at ${r.rigs} rigs: ${JSON.stringify(r.reasons)}`);
  const stratumLogs = compose(["logs", "stratum", "--tail", "400"], { allowFail: true }).text;
  const warnings = [...new Set(stratumLogs.split("\n").filter((l) => /warn|error|fail|Banning|Closing|limit/i.test(l)).map((l) => l.replace(/^.*?\| /, "").slice(0, 160)))].slice(0, 8);
  if (warnings.length) console.log(`\nStratum warnings during the run:\n  ${warnings.join("\n  ")}`);
  void heightsFrom;
}

try {
  await main();
} finally {
  sampling = false;
  if (process.env.LOAD_KEEP === "1") {
    console.log(`\nLeft the stack running (project ${PROJECT}). Remove it with: docker compose -p ${PROJECT} down -v`);
  } else {
    for (const name of ["load-rigs", "load-chain", "load-boot"]) docker(["rm", "-f", name], { allowFail: true });
    compose(["down", "-v", "--remove-orphans"], { allowFail: true });
    rmSync(join(envFile, ".."), { recursive: true, force: true });
  }
}
