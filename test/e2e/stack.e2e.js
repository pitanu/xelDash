// End-to-end: the real images on a private devnet, real miners, the real database.
//
//   1. the stack starts and reports healthy
//   2. the first blocks are mined (the devnet needs the official miner for the early algorithm versions)
//   3. a miner through Stratum finds blocks the daemon accepts, and they show in the API
//   4. the official miner through getwork shows up as its own worker
//   5. with the database stopped, mining carries on and the records arrive when it is back
//   6. Stratum restarts and mines again
//   7. the front door (HAProxy): miners keep their own address, move to the standby when the main Stratum stops, and come back
//
// Runs in its own Docker Compose project (xeldash-e2e) on its own ports, so it does not touch a stack that is already running.
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const skip = process.env.XELDASH_E2E === "1" ? false : "set XELDASH_E2E=1 (npm run e2e) to run these";
const root = fileURLToPath(new URL("../..", import.meta.url));
const PROJECT = "xeldash-e2e";
const WEB = "http://127.0.0.1:28088";
const ADDRESS = "xet:vs3mfyywt0fjys0rgslue7mm4wr23xdgejsjk0ld7f2kxng4d4nqqt98v9u";
const SECRET = "e2e0123456789abcdef0123456789abc";
const MINER_IMAGE = "xelis/miner:1.21.3";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let envFile = "";

/** Run a command, return its output; throws with the output when it fails. */
function run(command, args, { input, timeout = 600_000, allowFail = false } = {}) {
  const r = spawnSync(command, args, { cwd: root, encoding: "utf8", input, timeout, maxBuffer: 64 * 1024 * 1024 });
  const text = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  if (r.status !== 0 && !allowFail) throw new Error(`${command} ${args.join(" ")} failed (${r.status}):\n${text.slice(-2000)}`);
  return { status: r.status, text };
}
const compose = (args, options) => run("docker", ["compose", "-p", PROJECT, "--env-file", envFile, ...args], options);
const docker = (args, options) => run("docker", args, options);

async function waitFor(what, check, { timeoutMs = 180_000, everyMs = 2_000 } = {}) {
  const end = Date.now() + timeoutMs;
  let last;
  while (Date.now() < end) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      last = error;
    }
    await sleep(everyMs);
  }
  throw new Error(`Timed out waiting for ${what}${last ? `: ${last.message}` : ""}`);
}

/** fetch with a timeout that keeps the process alive (AbortSignal.timeout's timer does not, so a hanging request would end the run). */
async function get(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function api(path) {
  const response = await get(`${WEB}${path}`);
  assert.equal(response.status, 200, `${path} answered ${response.status}`);
  return response.json();
}

/** Mine blocks through Stratum with the project's own test miner, which also checks the daemon has each block. */
function mine(blocks, { host = "stratum", worker = "e2e", network = `${PROJECT}_node` } = {}) {
  const out = docker([
    "run", "--rm", "--network", `${PROJECT}_edge`, "--network", network,
    "-v", `${join(root, "services/stratum/scripts")}:/app/services/stratum/scripts:ro`, "-w", "/app/services/stratum",
    "-e", `MINER_STRATUM_HOST=${host}`, "-e", `MINER_WORKER=${worker}`, "-e", "XELIS_RPC_URL=http://daemon:8080/json_rpc",
    "ghcr.io/pitanu/xeldash/stratum:local", "node", "scripts/devnet-miner.js", ADDRESS, String(blocks),
  ], { timeout: 900_000 });
  assert.match(out.text, new RegExp(`${blocks} blocks verified, 0 failed`), out.text.slice(-800));
  return out.text;
}

const blockCount = async () => (await api("/api/v1/blocks?limit=500")).blocks.length;

before(() => {
  if (skip) return;
  envFile = join(mkdtempSync(join(tmpdir(), "xeldash-e2e-")), "env");
  writeFileSync(envFile, [
    "POSTGRES_PASSWORD=e2e-only-password", "XELIS_NETWORK=devnet", "XELIS_SNAPSHOT_AUTO=false", "XELDASH_VERSION=local",
    "XELDASH_ADMIN_TOKEN=e2eadmintoken0123456789abcdef", "XELDASH_WEB_PORT=28088", "XELDASH_API_PORT=28081",
    "XELDASH_STRATUM_PORT=23333", "XELDASH_STRATUM_TLS_PORT=23334", "XELDASH_GETWORK_PORT=28090", "XELIS_P2P_PORT=22125",
    "XELDASH_VERSION_CHECK=off", "XELDASH_PRICE=off", "STRATUM_START_DIFFICULTY=1000", "STRATUM_MIN_DIFFICULTY=100",
    `XELIS_DEFAULT_ADDRESS=${ADDRESS}`, "",
  ].join("\n"));
});

after(() => {
  if (skip) return;
  if (process.env.XELDASH_E2E_KEEP === "1") {
    console.log(`Left the e2e stack running (project ${PROJECT}). Remove it with: docker compose -p ${PROJECT} down -v`);
    return;
  }
  for (const name of ["e2e-boot", "e2e-getwork", "e2e-haproxy", "e2e-standby", "e2e-mainbox"]) docker(["rm", "-f", name], { allowFail: true });
  compose(["down", "-v", "--remove-orphans"], { allowFail: true });
  rmSync(join(envFile, ".."), { recursive: true, force: true });
});

test("the stack starts and says it is healthy", { skip }, async () => {
  compose(["down", "-v", "--remove-orphans"], { allowFail: true });
  compose(["up", "-d", "--build"], { timeout: 1_500_000 });
  const status = await waitFor("every service to report healthy", async () => {
    const s = await api("/api/v1/status");
    return s.services.database.ok && s.services.daemon.ok ? s : null;
  }, { timeoutMs: 300_000 });
  assert.equal(status.node.network, "devnet");
  const html = await (await get(`${WEB}/`)).text();
  assert.match(html, /<title>xelDash/i);
  const headers = (await get(`${WEB}/`)).headers;
  assert.ok(headers.get("content-security-policy"), "the dashboard sends a content security policy");
  assert.equal((await get(`${WEB}/api/v1/ingest/ping`)).status, 404, "the standby endpoint does not exist without a cluster secret");
  assert.equal((await get(`${WEB}/api/v1/node/settings`, { method: "PUT", body: "{}" })).status, 401, "changing settings needs the admin token");
});

test("the first blocks are mined with the official miner, until Stratum's algorithm is in use", { skip }, async () => {
  docker(["rm", "-f", "e2e-boot"], { allowFail: true });
  docker(["run", "-d", "--name", "e2e-boot", "--network", `${PROJECT}_node`, MINER_IMAGE,
    "--miner-address", ADDRESS, "--daemon-address", "ws://daemon:8080", "--num-threads", "4", "--disable-interactive-mode"], { timeout: 600_000 });
  try {
    await waitFor("the chain to reach height 15", async () => (await api("/api/v1/status")).node.height >= 15, { timeoutMs: 600_000, everyMs: 3_000 });
  } finally {
    docker(["rm", "-f", "e2e-boot"], { allowFail: true });
  }
  await waitFor("Stratum to accept miners", async () => (await api("/api/v1/status")).services.stratum.ok && !(await api("/api/v1/status")).services.stratum.paused);
});

test("a miner through Stratum finds blocks the daemon accepts, and the dashboard shows them", { skip }, async () => {
  const before = await blockCount();
  mine(3, { worker: "e2e-rig" });
  await waitFor("the blocks to be recorded", async () => (await blockCount()) >= before + 3);
  const miners = (await api("/api/v1/miners")).miners;
  assert.ok(miners.some((m) => m.address === ADDRESS), "the miner is listed");
  const miner = await api(`/api/v1/miners/${encodeURIComponent(ADDRESS)}`);
  assert.ok(miner.workers.some((w) => w.name === "e2e-rig"), "its worker is listed");
  const worker = await api(`/api/v1/miners/${encodeURIComponent(ADDRESS)}/workers/e2e-rig`);
  assert.match(worker.lastIp, /^\d+\.\d+\.\d+\.\d+$/);
  const overview = await api("/api/v1/overview");
  assert.ok(overview.blocks.length > 0);
  const csv = await (await get(`${WEB}/api/v1/blocks.csv`)).text();
  assert.match(csv, /^found_at_utc,height,/);
  assert.ok(csv.split("\r\n").length >= before + 4, "the CSV has a row per block");
});

test("the official miner through getwork shows up as its own worker", { skip }, async () => {
  docker(["rm", "-f", "e2e-getwork"], { allowFail: true });
  docker(["run", "-d", "--name", "e2e-getwork", "--network", `${PROJECT}_node`, MINER_IMAGE,
    "--miner-address", ADDRESS, "--daemon-address", "ws://stratum:8090", "--worker", "e2e-official", "--num-threads", "2", "--disable-interactive-mode"], { timeout: 600_000 });
  try {
    await waitFor("the getwork worker to appear", async () => {
      const miner = await api(`/api/v1/miners/${encodeURIComponent(ADDRESS)}`);
      return miner.workers.some((w) => w.name === "e2e-official");
    }, { timeoutMs: 120_000 });
  } finally {
    docker(["rm", "-f", "e2e-getwork"], { allowFail: true });
  }
});

test("with the database stopped mining carries on, and the records arrive when it is back", { skip }, async () => {
  const before = await blockCount();
  compose(["stop", "postgres"]);
  try {
    mine(1, { worker: "e2e-outage" });
  } finally {
    compose(["start", "postgres"]);
  }
  await waitFor("the database to answer again", async () => (await api("/api/v1/status")).services.database.ok, { timeoutMs: 120_000 });
  await waitFor("the block mined during the outage to be recorded", async () => (await blockCount()) >= before + 1, { timeoutMs: 180_000, everyMs: 3_000 });
  const miner = await api(`/api/v1/miners/${encodeURIComponent(ADDRESS)}`);
  assert.ok(miner.workers.some((w) => w.name === "e2e-outage"), "the worker first seen during the outage was created afterwards");
});

test("Stratum restarts and mines again", { skip }, async () => {
  const before = await blockCount();
  compose(["restart", "stratum"]);
  await waitFor("Stratum to be ready", async () => (await api("/api/v1/status")).services.stratum.ok, { timeoutMs: 120_000 });
  mine(1, { worker: "e2e-after-restart" });
  await waitFor("the block to be recorded", async () => (await blockCount()) >= before + 1);
});

test("the front door: real miner addresses, failover to the standby, and back", { skip }, async () => {
  // The main server's Stratum now expects the front door's PROXY line, and the cluster secret turns the standby endpoint on.
  writeFileSync(envFile, `${(await import("node:fs")).readFileSync(envFile, "utf8")}STRATUM_PROXY_FROM=private\nXELDASH_CLUSTER_SECRET=${SECRET}\n`);
  compose(["up", "-d", "stratum", "api"]);
  await waitFor("Stratum to be ready", async () => (await api("/api/v1/status")).services.stratum.ok, { timeoutMs: 180_000 });
  assert.equal((await api("/api/v1/front-door")).configured, true);
  assert.equal((await get(`${WEB}/api/v1/ingest/ping`)).status, 401, "the standby endpoint wants the secret");

  for (const name of ["e2e-haproxy", "e2e-standby", "e2e-mainbox"]) docker(["rm", "-f", name], { allowFail: true });
  docker(["build", "-q", "-t", "xeldash-e2e-frontdoor", "docker/frontdoor"]);
  // The main server as the front door sees it: its Stratum, its getwork port and its dashboard (the readiness check) on one name.
  docker(["create", "--name", "e2e-mainbox", "--network", `${PROJECT}_edge`, "--network-alias", "mainbox", "--entrypoint", "sh", "alpine/socat", "-c",
    "socat TCP-LISTEN:3333,fork,reuseaddr TCP:stratum:3333 & socat TCP-LISTEN:8090,fork,reuseaddr TCP:stratum:8090 & exec socat TCP-LISTEN:8080,fork,reuseaddr TCP:web:8080"]);
  docker(["network", "connect", `${PROJECT}_node`, "e2e-mainbox"]);
  docker(["start", "e2e-mainbox"]);
  // The standby: its own Stratum, no database, recording through the main server.
  docker(["run", "-d", "--name", "e2e-standby", "--network", `${PROJECT}_edge`, "--network", `${PROJECT}_node`,
    "-e", "XELIS_RPC_URLS=http://daemon:8080/json_rpc", "-e", "STRATUM_HOST=0.0.0.0", "-e", "STRATUM_PORT=3333", "-e", "XELDASH_ALLOWED_NETWORKS=private",
    "-e", "STRATUM_PROXY_FROM=private", "-e", "STRATUM_INGEST_URL=http://web:8080", "-e", `XELDASH_CLUSTER_SECRET=${SECRET}`, "-e", "STRATUM_INSTANCE=e2e-standby",
    "-e", "STRATUM_JOURNAL_DIR=/tmp/journal", "-e", "STRATUM_START_DIFFICULTY=1000", "-e", "STRATUM_MIN_DIFFICULTY=100", "-e", "STRATUM_TLS_ENABLED=false",
    "ghcr.io/pitanu/xeldash/stratum:local"]);
  docker(["run", "-d", "--name", "e2e-haproxy", "--network", `${PROJECT}_edge`, "--network-alias", "frontdoor",
    "-e", "FRONTDOOR_MAIN_HOST=mainbox", "-e", "FRONTDOOR_MAIN_HEALTH_PORT=8080", "-e", "FRONTDOOR_STANDBY_HOST=e2e-standby", "xeldash-e2e-frontdoor"]);
  await sleep(20_000);

  const haproxyIp = docker(["inspect", "e2e-haproxy", "--format", "{{(index .NetworkSettings.Networks \"" + PROJECT + "_edge\").IPAddress}}"]).text.trim();
  const before = await blockCount();
  mine(1, { host: "frontdoor", worker: "e2e-via-front" });
  await waitFor("the block to be recorded", async () => (await blockCount()) >= before + 1);
  const viaFront = await api(`/api/v1/miners/${encodeURIComponent(ADDRESS)}/workers/e2e-via-front`);
  assert.match(viaFront.lastIp, /^\d+\.\d+\.\d+\.\d+$/);
  assert.notEqual(viaFront.lastIp, haproxyIp, "the main server saw the miner's own address, not the front door's");

  // Straight to the main server, without the front door, is refused: it expects the PROXY line.
  const direct = docker([
    "run", "--rm", "--network", `${PROJECT}_node`, "--entrypoint", "node", "ghcr.io/pitanu/xeldash/stratum:local", "-e",
    "const s=require('net').connect(3333,'stratum');let got=false;s.on('data',()=>{got=true});s.on('connect',()=>s.write('{\"id\":1,\"method\":\"mining.subscribe\",\"params\":[\"x\",[\"xel/v3\"]]}\\n'));s.on('close',()=>{console.log(got?'ANSWERED':'REFUSED');process.exit()});setTimeout(()=>{console.log(got?'ANSWERED':'REFUSED');process.exit()},4000)",
  ]);
  assert.match(direct.text, /REFUSED/, "a miner that skips the front door is not served");

  // The main Stratum stops: the front door moves miners to the standby, and what it records still reaches the main server.
  compose(["stop", "stratum"]);
  await sleep(12_000);
  const afterStop = await blockCount();
  mine(1, { host: "frontdoor", worker: "e2e-on-standby" });
  await waitFor("the standby's block to reach the main database", async () => (await blockCount()) >= afterStop + 1, { timeoutMs: 120_000, everyMs: 3_000 });
  const standbyWorker = await api(`/api/v1/miners/${encodeURIComponent(ADDRESS)}/workers/e2e-on-standby`);
  assert.notEqual(standbyWorker.lastIp, haproxyIp);

  // The main Stratum is back: new connections go there again.
  compose(["start", "stratum"]);
  await waitFor("Stratum to be ready", async () => (await api("/api/v1/status")).services.stratum.ok, { timeoutMs: 180_000 });
  await sleep(15_000);
  const afterBack = await blockCount();
  mine(1, { host: "frontdoor", worker: "e2e-back-on-main" });
  await waitFor("the block to be recorded", async () => (await blockCount()) >= afterBack + 1);
});
