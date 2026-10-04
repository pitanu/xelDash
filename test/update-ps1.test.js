// The Windows launcher's release update, against a local stand-in for GitHub. Only where PowerShell and Docker are available (Windows).
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const LAUNCHER = fileURLToPath(new URL("../xeldash.ps1", import.meta.url));
const ps = (args, options = {}) => spawnSync("powershell", ["-NoProfile", ...args], { encoding: "utf8", ...options });
const hasPowerShell = process.platform === "win32" && ps(["-Command", "exit 0"]).status === 0;
const hasDocker = hasPowerShell && spawnSync("docker", ["info"], { timeout: 20_000 }).status === 0;
const skip = hasDocker ? false : "needs Windows PowerShell and Docker";

async function fakeGithub(archiveVersion) {
  const root = mkdtempSync(join(tmpdir(), "fakerelease-"));
  const pack = join(root, "xelDash-9.9.9");
  mkdirSync(pack, { recursive: true });
  copyFileSync(LAUNCHER, join(pack, "xeldash.ps1"));
  writeFileSync(join(pack, "docker-compose.yml"), "services: {}\n");
  writeFileSync(join(pack, "VERSION"), `${archiveVersion}\n`);
  writeFileSync(join(pack, "NEW.txt"), "from the new release\n");
  const zip = join(root, "release.zip");
  assert.equal(ps(["-Command", `Compress-Archive -LiteralPath '${pack}' -DestinationPath '${zip}'`]).status, 0);
  const archive = readFileSync(zip);
  const server = createServer((request, response) => {
    if (request.url.startsWith("/tags")) response.end(JSON.stringify([{ name: "v9.9.9" }, { name: "v0.1.0" }, { name: "v10.0.0-rc.1" }]));
    else if (request.url === "/release.zip") response.end(archive);
    else response.writeHead(404).end();
  });
  server.unref();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, close: () => { server.close(); rmSync(root, { recursive: true, force: true }); } };
}

function installFolder(version) {
  const dir = mkdtempSync(join(tmpdir(), "install-"));
  copyFileSync(LAUNCHER, join(dir, "xeldash.ps1"));
  writeFileSync(join(dir, ".env"), `XELDASH_VERSION=${version}\nPOSTGRES_PASSWORD=keepme\n`);
  writeFileSync(join(dir, "docker-compose.yml"), "services: {old: true}\n");
  writeFileSync(join(dir, "VERSION"), `${version}\n`);
  mkdirSync(join(dir, "backups"));
  writeFileSync(join(dir, "backups", "mine.dump"), "my data");
  return dir;
}

function runUpdate(dir, github) {
  return new Promise((resolve) => {
    const child = spawn("powershell", ["-NoProfile", "-File", join(dir, "xeldash.ps1"), "update"], {
      cwd: dir, env: { ...process.env, XELDASH_RELEASE_API: github.base, XELDASH_ARCHIVE_URL: `${github.base}/release.zip`, XELDASH_UPDATE_NO_START: "1" },
    });
    let text = "";
    child.stdout.on("data", (d) => { text += d; });
    child.stderr.on("data", (d) => { text += d; });
    child.on("close", (status) => resolve({ status, text }));
  });
}

test("Windows: a release install is moved to the newest release, keeping .env and backups", { skip }, async () => {
  const github = await fakeGithub("9.9.9");
  const dir = installFolder("0.1.0");
  const r = await runUpdate(dir, github);
  assert.equal(r.status, 0, r.text);
  const env = readFileSync(join(dir, ".env"), "utf8");
  assert.match(env, /^XELDASH_VERSION=9\.9\.9\s*$/m);
  assert.match(env, /^POSTGRES_PASSWORD=keepme\s*$/m);
  assert.equal(readFileSync(join(dir, "VERSION"), "utf8").trim(), "9.9.9");
  assert.equal(readFileSync(join(dir, "NEW.txt"), "utf8").trim(), "from the new release");
  assert.equal(readFileSync(join(dir, "backups", "mine.dump"), "utf8"), "my data");
  assert.match(r.text, /updated to 9\.9\.9/i);
  const again = await runUpdate(dir, github);
  assert.match(again.text, /already have the newest/i);
  github.close();
  rmSync(dir, { recursive: true, force: true });
});

test("Windows: an archive that is not the release it claims to be changes nothing", { skip }, async () => {
  const github = await fakeGithub("1.2.3");
  const dir = installFolder("0.1.0");
  const r = await runUpdate(dir, github);
  assert.notEqual(r.status, 0);
  assert.match(r.text, /not xelDash release 9\.9\.9/);
  assert.match(readFileSync(join(dir, ".env"), "utf8"), /^XELDASH_VERSION=0\.1\.0\s*$/m);
  assert.ok(!existsSync(join(dir, "NEW.txt")));
  github.close();
  rmSync(dir, { recursive: true, force: true });
});

test("Windows: which version is newer", { skip: hasPowerShell ? false : "needs Windows PowerShell" }, () => {
  const newer = [["0.1.1", "0.1.0"], ["0.10.0", "0.9.9"], ["0.1.0", "0.1.0-rc.5"], ["0.1.0-rc.10", "0.1.0-rc.9"], ["0.1.0-rc.1", "0.1.0-beta.7"], ["0.1.0-rc.1.1", "0.1.0-rc.1"]];
  const notNewer = [["0.1.0", "0.1.0"], ["0.1.0-rc.5", "0.1.0"], ["0.9.9", "0.10.0"], ["0.1.0-rc.9", "0.1.0-rc.10"], ["0.1.0-beta.7", "0.1.0-rc.1"]];
  // The comparison function alone, taken out of the launcher.
  const source = readFileSync(LAUNCHER, "utf8");
  const start = source.indexOf("function Test-VersionNewer");
  const end = source.indexOf("# The newest release tag");
  const lines = [source.slice(start, end), ...newer.map(([a, b]) => `if (-not (Test-VersionNewer '${a}' '${b}')) { 'WRONG: ${a} should be newer than ${b}' }`),
    ...notNewer.map(([a, b]) => `if (Test-VersionNewer '${a}' '${b}') { 'WRONG: ${a} should not be newer than ${b}' }`), "'done'"];
  const file = join(mkdtempSync(join(tmpdir(), "ver-")), "t.ps1");
  writeFileSync(file, lines.join("\n"));
  const r = ps(["-File", file]);
  assert.equal(r.stdout.trim(), "done", r.stdout + r.stderr);
});
