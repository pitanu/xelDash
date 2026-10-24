// Upgrade: the previous release, as a user has it, updated to this commit with its data kept.
//
//   1. the newest published release, or the one in XELDASH_UPGRADE_FROM (CI also starts from 0.1.0 and 0.3.0), starts from its own
//      archive and images, with two nodes
//   2. its database gets a miner, a worker, a minute of statistics and an event
//   3. the stack is updated to this commit in the same project, with the same volumes and settings, as an update does
//   4. the migrations finish, the stack is healthy, the data is still there, and daemon2 runs this commit's node container
//
// The end-to-end test (stack.e2e.js) always starts from nothing; this is the path every existing install takes. Runs in its own
// Compose project (xeldash-upgrade) on its own ports.
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const skip = process.env.XELDASH_E2E === "1" ? false : "set XELDASH_E2E=1 (npm run e2e:upgrade) to run these";
const root = fileURLToPath(new URL("../..", import.meta.url));
const PROJECT = "xeldash-upgrade";
const WEB = "http://127.0.0.1:48088";
const REPO = process.env.XELDASH_UPDATE_REPO || "pitanu/xelDash";
const MINER = "xet:upgradetestminer0000000000000000000000000000000000000000";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let work = "";
let envFile = "";
let previous = "";
let previousDir = "";

/** @param {string} command @param {string[]} args @param {{ cwd?: string, timeout?: number, allowFail?: boolean, input?: string }} [options] */
function run(command, args, { cwd = root, timeout = 900_000, allowFail = false, input } = {}) {
  const r = spawnSync(command, args, { cwd, encoding: "utf8", timeout, input, maxBuffer: 64 * 1024 * 1024 });
  const text = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  if (r.status !== 0 && !allowFail) throw new Error(`${command} ${args.join(" ")} failed (${r.status}):\n${text.slice(-2500)}`);
  return { status: r.status, text };
}
/** docker compose for this project, from the given release's folder. @param {string} cwd @param {string[]} args */
const compose = (cwd, args, options = {}) => run("docker", ["compose", "-p", PROJECT, "--env-file", envFile, ...args], { cwd, ...options });
/** @param {string} sql */
const psql = (sql) => compose(root, ["exec", "-T", "postgres", "psql", "-U", "xeldash", "-d", "xeldash", "-tAc", sql]).text.trim();

/** @param {string} what @param {() => Promise<unknown>} check */
async function waitFor(what, check, timeoutMs = 300_000) {
  const end = Date.now() + timeoutMs;
  let last;
  while (Date.now() < end) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      last = error;
    }
    await sleep(3_000);
  }
  throw new Error(`Timed out waiting for ${what}${last instanceof Error ? `: ${last.message}` : ""}`);
}

/** @param {string} path */
async function api(path) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(`${WEB}${path}`, { signal: controller.signal });
    assert.equal(response.status, 200, `${path} answered ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

/** The stack answers, with the database and the node up. */
const healthy = () => waitFor("the stack to report healthy", async () => {
  const s = await api("/api/v1/status");
  return s.services.database.ok && s.services.daemon.ok ? s : null;
});

/** The settings an install has in .env, for the given version. @param {string} version */
function writeEnv(version) {
  writeFileSync(envFile, [
    "POSTGRES_PASSWORD=upgrade-only-password", "XELIS_NETWORK=devnet", "XELIS_SNAPSHOT_AUTO=false", `XELDASH_VERSION=${version}`,
    "COMPOSE_PROFILES=redundant", "XELIS_RPC_URLS=http://daemon:8080/json_rpc,http://daemon2:8080/json_rpc",
    "XELDASH_ADMIN_TOKEN=upgradeadmintoken0123456789", "XELDASH_WEB_PORT=48088", "XELDASH_API_PORT=48081", "XELDASH_ADMIN_WEB_PORT=48089",
    "XELDASH_STRATUM_PORT=43333", "XELDASH_STRATUM_TLS_PORT=43334", "XELDASH_GETWORK_PORT=48090", "XELIS_P2P_PORT=42125",
    "XELDASH_VERSION_CHECK=off", "XELDASH_PRICE=off", "",
  ].join("\n"));
}

before(async () => {
  if (skip) return;
  work = mkdtempSync(join(tmpdir(), "xeldash-upgrade-"));
  envFile = join(work, "env");
  previous = (process.env.XELDASH_UPGRADE_FROM ?? "").replace(/^v/, "");
  if (!previous) {
    const releases = await (await fetch(`https://api.github.com/repos/${REPO}/releases?per_page=20`, { headers: { accept: "application/vnd.github+json" } })).json();
    previous = String(releases.find((r) => !r.draft && !r.prerelease)?.tag_name ?? "").replace(/^v/, "");
  }
  assert.match(previous, /^\d+\.\d+\.\d+$/, "a previous release to start from");
  const archive = join(work, "release.tar.gz");
  run("curl", ["-fsSL", "-m", "300", "-o", archive, `https://github.com/${REPO}/archive/refs/tags/v${previous}.tar.gz`]);
  const unpacked = join(work, "release");
  mkdirSync(unpacked);
  // Relative paths: GNU tar reads "C:\..." as a remote host on Windows.
  run("tar", ["-xzf", "release.tar.gz", "-C", "release"], { cwd: work });
  previousDir = join(unpacked, readdirSync(unpacked)[0]);
  console.log(`Upgrading from ${previous}`);
});

after(() => {
  if (skip || !envFile) return;
  if (process.env.XELDASH_E2E_KEEP === "1") {
    console.log(`Left the upgrade stack running (project ${PROJECT}). Remove it with: docker compose -p ${PROJECT} down -v`);
    return;
  }
  compose(root, ["down", "-v", "--remove-orphans"], { allowFail: true });
  run("docker", ["image", "rm", "xeldash-daemon2:local", `${PROJECT}-daemon2`], { allowFail: true });
  rmSync(work, { recursive: true, force: true });
});

test("the previous release starts as a user has it, and keeps some data", { skip }, async () => {
  writeEnv(previous);
  compose(previousDir, ["down", "-v", "--remove-orphans"], { allowFail: true });
  compose(previousDir, ["pull", "--ignore-buildable"], { allowFail: true, timeout: 1_200_000 });
  compose(previousDir, ["up", "-d"], { timeout: 1_500_000 });
  await healthy();
  psql(`WITH m AS (INSERT INTO miners (address) VALUES ('${MINER}') RETURNING id),
        w AS (INSERT INTO workers (miner_id, name) SELECT id, 'kept-rig' FROM m RETURNING id)
        INSERT INTO worker_stats_1m (bucket, worker_id, accepted, rejected, sum_difficulty)
        SELECT date_trunc('minute', now()) - interval '5 minutes', id, 7, 1, 7000 FROM w`);
  psql(`INSERT INTO service_events (type, payload) VALUES ('upgrade_test', '{"from":"${previous}"}')`);
  assert.equal(psql(`SELECT count(*) FROM miners WHERE address = '${MINER}'`), "1");
});

test("updated to this commit: migrations finish, the stack is healthy, and the data is kept", { skip }, async () => {
  writeEnv("local");
  compose(root, ["up", "-d", "--build", "--remove-orphans"], { timeout: 1_800_000 });
  const migrate = compose(root, ["ps", "-a", "--format", "{{.Name}} {{.State}} {{.ExitCode}}", "migrate"]).text;
  assert.match(migrate, /exited 0/, `the migration finished: ${migrate}`);
  await healthy();

  const files = readdirSync(join(root, "packages/db/migrations")).filter((f) => f.endsWith(".sql")).sort();
  assert.deepEqual(psql("SELECT version FROM schema_migrations ORDER BY version").split("\n"), files, "every migration applied");

  assert.equal(psql(`SELECT sum(s.accepted) FROM worker_stats_1m s JOIN workers w ON w.id = s.worker_id JOIN miners m ON m.id = w.miner_id
                     WHERE m.address = '${MINER}' AND w.name = 'kept-rig'`), "7", "the statistics survived the update");
  assert.equal(psql("SELECT payload->>'from' FROM service_events WHERE type = 'upgrade_test'"), previous);
  const miner = await waitFor("the miner to show in the API", async () => {
    const found = (await api("/api/v1/miners")).miners.find((/** @type {{ address: string }} */ m) => m.address === MINER);
    return found ?? null;
  }, 60_000);
  assert.equal(miner.workers, "1");
});

test("daemon2 runs this commit's node container, not the one it was first built with", { skip }, () => {
  const image = run("docker", ["inspect", "-f", "{{.Config.Image}}", `${PROJECT}-daemon2-1`]).text.trim();
  assert.equal(image, "xeldash-daemon2:local");
  const container = run("docker", ["inspect", "-f", "{{.Image}}", `${PROJECT}-daemon2-1`]).text.trim();
  const built = run("docker", ["image", "inspect", "-f", "{{.Id}}", "xeldash-daemon2:local"]).text.trim();
  assert.equal(container, built, "the running daemon2 is the image built from this commit");
});
