// Release installs: which release is newer, and updating a release install in place (against a local stand-in for GitHub).
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const LAUNCHER = fileURLToPath(new URL("../xeldash.sh", import.meta.url));
const hasBash = spawnSync("bash", ["-c", "true"]).status === 0;
const hasTar = spawnSync("tar", ["--version"]).status === 0;
const hasDocker = spawnSync("docker", ["info"], { timeout: 20_000 }).status === 0;
const toPosix = (p) => p.replace(/\\/g, "/").replace(/^([A-Za-z]):/, (_, d) => `/${d.toLowerCase()}`);
const skipBash = hasBash ? false : "no bash";

/** Run bash with the launcher's release functions loaded, in a scratch folder. */
function bash(script, { files = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "release-"));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  const prelude = `
    cd '${toPosix(dir)}'
    say() { printf '%s\\n' "$*"; }; warn() { printf 'WARN: %s\\n' "$*"; }; die() { printf 'DIE: %s\\n' "$*"; exit 1; }
    L='${toPosix(LAUNCHER)}'
    for fn in get_env set_env release_version use_release_version version_newer newest_tag; do
      eval "$(sed -n "/^$fn() {/,/^}/p" "$L")"
    done
  `;
  const r = spawnSync("bash", ["-c", prelude + script], { encoding: "utf8" });
  const dotenv = existsSync(join(dir, ".env")) ? readFileSync(join(dir, ".env"), "utf8") : "";
  rmSync(dir, { recursive: true, force: true });
  return { status: r.status, out: r.stdout.trim(), dotenv };
}

test("which version is newer", { skip: skipBash }, () => {
  const newer = [["0.1.1", "0.1.0"], ["0.10.0", "0.9.9"], ["1.0.0", "0.99.99"], ["0.1.0", "0.1.0-rc.5"], ["0.1.0-rc.10", "0.1.0-rc.9"], ["0.1.0-rc.2", "0.1.0-rc.1"],
    ["0.1.0-rc.1", "0.1.0-beta.7"], ["0.1.0-rc.1.1", "0.1.0-rc.1"], ["0.2.0-rc.1", "0.1.0"]];
  const notNewer = [["0.1.0", "0.1.0"], ["0.1.0-rc.5", "0.1.0"], ["0.1.0-rc.1", "0.1.0-rc.1"], ["0.9.9", "0.10.0"], ["0.1.0-rc.9", "0.1.0-rc.10"], ["0.1.0-beta.7", "0.1.0-rc.1"], ["0.1.0-rc.1", "0.1.0-rc.1.1"]];
  const script = [...newer.map(([a, b]) => `version_newer '${a}' '${b}' && echo ok || echo "WRONG: ${a} should be newer than ${b}"`),
    ...notNewer.map(([a, b]) => `version_newer '${a}' '${b}' && echo "WRONG: ${a} should not be newer than ${b}" || echo ok`)].join("\n");
  const r = bash(script);
  assert.deepEqual(r.out.split("\n").filter((l) => l !== "ok"), []);
});

test("the newest release is picked from the tag list; pre-releases only count for a pre-release install", { skip: skipBash }, () => {
  const json = JSON.stringify([{ name: "v0.1.0-rc.5" }, { name: "v0.1.0-rc.10" }, { name: "v0.0.9" }, { name: "latest" }, { name: "v0.1.0" }, { name: "v0.2.0-rc.1" }, { name: "vX" }]);
  const pick = (current) => bash(`printf '%s' '${json}' | newest_tag '${current}'`).out;
  assert.equal(pick("0.1.0-rc.4"), "v0.2.0-rc.1", "a pre-release install follows pre-releases, and moves on to the release");
  assert.equal(pick("0.0.5"), "v0.1.0", "a release install sees releases only");
  assert.equal(pick("0.1.0"), "v0.1.0");
  assert.equal(bash("printf '%s' '[]' | newest_tag 0.1.0").out, "");
});

test("a copy of a release installs with that release's images; the development branch builds from source", { skip: skipBash }, () => {
  const use = (versionFile) => bash("use_release_version", { files: { ".env": "XELDASH_VERSION=local\nKEEP=1\n", ...(versionFile === null ? {} : { VERSION: versionFile }) } }).dotenv;
  assert.match(use("0.1.0-rc.6\n"), /^XELDASH_VERSION=0\.1\.0-rc\.6$/m);
  assert.match(use("0.1.0"), /^XELDASH_VERSION=0\.1\.0$/m);
  for (const bad of ["local\n", "", "latest", "1.2", "0.1.0; rm -rf /", "../../x", null]) assert.match(use(bad), /^XELDASH_VERSION=local$/m, JSON.stringify(bad));
  assert.match(use("0.1.0"), /^KEEP=1$/m);
});

/** Serves a stand-in for GitHub's tag list and a release archive. */
async function fakeGithub({ archiveVersion }) {
  const root = mkdtempSync(join(tmpdir(), "fakerelease-"));
  const pack = join(root, "xelDash-9.9.9");
  mkdirSync(pack, { recursive: true });
  copyFileSync(LAUNCHER, join(pack, "xeldash.sh"));
  writeFileSync(join(pack, "docker-compose.yml"), "services: {}\n");
  writeFileSync(join(pack, "VERSION"), `${archiveVersion}\n`);
  writeFileSync(join(pack, "NEW.txt"), "from the new release\n");
  const tgz = join(root, "release.tar.gz");
  assert.equal(spawnSync("tar", ["-czf", toPosix(tgz), "-C", toPosix(root), "xelDash-9.9.9"]).status, 0);
  const archive = readFileSync(tgz);
  const server = createServer((request, response) => {
    if (request.url.startsWith("/tags")) response.end(JSON.stringify([{ name: "v9.9.9" }, { name: "v0.1.0" }, { name: "v10.0.0-rc.1" }]));
    else if (request.url === "/release.tar.gz") response.end(archive);
    else response.writeHead(404).end();
  });
  server.unref();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, close: () => { server.close(); rmSync(root, { recursive: true, force: true }); } };
}

/** Run the whole launcher's update in an install folder. */
function runUpdate(dir, github) {
  return new Promise((resolve) => {
    const child = spawn("bash", [join(dir, "xeldash.sh"), "update"], {
      cwd: dir, env: { ...process.env, TERM: "dumb", XELDASH_RELEASE_API: github.base, XELDASH_ARCHIVE_URL: `${github.base}/release.tar.gz`, XELDASH_UPDATE_NO_START: "1" },
    });
    let text = "";
    child.stdout.on("data", (d) => { text += d; });
    child.stderr.on("data", (d) => { text += d; });
    child.on("close", (status) => resolve({ status, text }));
  });
}

function installFolder(version) {
  const dir = mkdtempSync(join(tmpdir(), "install-"));
  copyFileSync(LAUNCHER, join(dir, "xeldash.sh"));
  writeFileSync(join(dir, ".env"), `XELDASH_VERSION=${version}\nPOSTGRES_PASSWORD=keepme\nXELIS_NETWORK=mainnet\n`);
  writeFileSync(join(dir, "docker-compose.yml"), "services: {old: true}\n");
  writeFileSync(join(dir, "VERSION"), `${version}\n`);
  mkdirSync(join(dir, "backups"));
  writeFileSync(join(dir, "backups", "mine.dump"), "my data");
  return dir;
}

// The whole update runs the bash launcher, which is for Linux and macOS; on Windows (Git Bash) writing the download can fail while the disk is busy
// (virus scanning), so there it is covered by update-ps1.test.js instead.
const why = process.platform === "win32" ? "the Windows launcher is tested in update-ps1.test.js" : hasBash && hasTar && hasDocker ? false : "needs bash, tar and Docker";

test("update: a release install is moved to the newest release, keeping .env and backups", { skip: why }, async () => {
  const github = await fakeGithub({ archiveVersion: "9.9.9" });
  const dir = installFolder("0.1.0");
  const r = await runUpdate(dir, github);
  assert.equal(r.status, 0, r.text);
  const env = readFileSync(join(dir, ".env"), "utf8");
  assert.match(env, /^XELDASH_VERSION=9\.9\.9$/m);
  assert.match(env, /^POSTGRES_PASSWORD=keepme$/m, "the password is kept");
  assert.equal(readFileSync(join(dir, "VERSION"), "utf8").trim(), "9.9.9");
  assert.equal(readFileSync(join(dir, "NEW.txt"), "utf8").trim(), "from the new release");
  assert.equal(readFileSync(join(dir, "docker-compose.yml"), "utf8").trim(), "services: {}", "the compose file is the new one");
  assert.equal(readFileSync(join(dir, "backups", "mine.dump"), "utf8"), "my data", "backups are left alone");
  assert.match(r.text, /updated to 9\.9\.9/i);
  const again = await runUpdate(dir, github);
  assert.match(again.text, /already have the newest/i, "a second update has nothing to do");
  github.close();
  rmSync(dir, { recursive: true, force: true });
});

test("update: an archive that is not the release it claims to be changes nothing", { skip: why }, async () => {
  const github = await fakeGithub({ archiveVersion: "1.2.3" });
  const dir = installFolder("0.1.0");
  const r = await runUpdate(dir, github);
  assert.notEqual(r.status, 0);
  assert.match(r.text, /not xelDash release 9\.9\.9/);
  assert.match(readFileSync(join(dir, ".env"), "utf8"), /^XELDASH_VERSION=0\.1\.0$/m);
  assert.ok(!existsSync(join(dir, "NEW.txt")));
  github.close();
  rmSync(dir, { recursive: true, force: true });
});

test("update: without a connection to GitHub it says so and changes nothing", { skip: why }, async () => {
  const dir = installFolder("0.1.0");
  const r = await runUpdate(dir, { base: "http://127.0.0.1:1" });
  assert.notEqual(r.status, 0);
  assert.match(r.text, /Could not find a release/);
  assert.match(readFileSync(join(dir, ".env"), "utf8"), /^XELDASH_VERSION=0\.1\.0$/m);
  rmSync(dir, { recursive: true, force: true });
});
