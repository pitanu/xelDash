// The Windows launcher's release update, against a local stand-in for GitHub. Only where PowerShell and Docker are available (Windows).
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

const LAUNCHER = fileURLToPath(new URL("../xeldash.ps1", import.meta.url));
const ps = (args, options = {}) => spawnSync("powershell", ["-NoProfile", ...args], { encoding: "utf8", ...options });
const hasPowerShell = process.platform === "win32" && ps(["-Command", "exit 0"]).status === 0;
const hasDocker = hasPowerShell && spawnSync("docker", ["info"], { timeout: 20_000 }).status === 0;
const skip = hasDocker ? false : "needs Windows PowerShell and Docker";

async function fakeGithub(archiveVersion, { emptyList = false } = {}) {
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
    // With emptyList, the list answers [] as GitHub's did during its trouble on 2026-10-22, and only /releases/latest knows the release.
    if (request.url === "/releases/latest") response.end(JSON.stringify({ tag_name: "v9.9.9" }));
    else if (request.url.startsWith("/releases")) response.end(JSON.stringify(emptyList ? [] : [{ tag_name: "v9.9.9" }, { tag_name: "v0.1.0" }, { tag_name: "v10.0.0-rc.1", prerelease: true }]));
    else if (request.url === "/release.zip") response.end(archive);
    else response.writeHead(404).end();
  });
  server.unref();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, close: () => { server.close(); rmSync(root, { recursive: true, force: true }); } };
}

function installFolder(version, compose = "services: {old: true}\n") {
  const dir = mkdtempSync(join(tmpdir(), "install-"));
  copyFileSync(LAUNCHER, join(dir, "xeldash.ps1"));
  writeFileSync(join(dir, ".env"), `XELDASH_VERSION=${version}\nPOSTGRES_PASSWORD=keepme\nSTRATUM_TARGET_SHARE_SECONDS=10\n`);
  writeFileSync(join(dir, "docker-compose.yml"), compose);
  writeFileSync(join(dir, "VERSION"), `${version}\n`);
  mkdirSync(join(dir, "backups"));
  writeFileSync(join(dir, "backups", "mine.dump"), "my data");
  return dir;
}

function runUpdate(dir, github, env = {}) {
  return new Promise((resolve) => {
    const child = spawn("powershell", ["-NoProfile", "-File", join(dir, "xeldash.ps1"), "update"], {
      cwd: dir, env: { ...process.env, XELDASH_RELEASE_API: github.base, XELDASH_ARCHIVE_URL: `${github.base}/release.zip`, XELDASH_UPDATE_NO_START: "1", ...env },
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
  assert.match(env, /^STRATUM_TARGET_SHARE_SECONDS=5\s*$/m, "the old default share target (10 s) becomes the block time");
  assert.equal(readFileSync(join(dir, "VERSION"), "utf8").trim(), "9.9.9");
  assert.equal(readFileSync(join(dir, "NEW.txt"), "utf8").trim(), "from the new release");
  assert.equal(readFileSync(join(dir, "backups", "mine.dump"), "utf8"), "my data");
  assert.match(r.text, /updated to 9\.9\.9/i);
  const again = await runUpdate(dir, github);
  assert.match(again.text, /already have the newest/i);
  github.close();
  rmSync(dir, { recursive: true, force: true });
});

test("Windows: when GitHub's release list comes back empty, its latest release is found", { skip }, async () => {
  const github = await fakeGithub("9.9.9", { emptyList: true });
  const dir = installFolder("0.1.0");
  const r = await runUpdate(dir, github);
  assert.equal(r.status, 0, r.text);
  assert.match(readFileSync(join(dir, ".env"), "utf8"), /^XELDASH_VERSION=9.9.9s*$/m);
  assert.match((await runUpdate(dir, github)).text, /already have the newest/i, "and an install on it is told it has the newest");
  github.close();
  rmSync(dir, { recursive: true, force: true });
});

test("Windows: when the backup before it cannot be taken, the update changes nothing; it can be skipped on purpose", { skip }, async () => {
  const github = await fakeGithub("9.9.9");
  const dir = installFolder("0.1.0", "services:\n  postgres:\n    image: xeldash-test/no-such-image:0\n    pull_policy: never\n");
  const r = await runUpdate(dir, github);
  assert.notEqual(r.status, 0);
  assert.match(r.text, /nothing was changed/);
  assert.match(readFileSync(join(dir, ".env"), "utf8"), /^XELDASH_VERSION=0\.1\.0\s*$/m);
  assert.ok(!existsSync(join(dir, "NEW.txt")));
  const skipped = await runUpdate(dir, github, { XELDASH_UPDATE_SKIP_BACKUP: "1" });
  assert.equal(skipped.status, 0, skipped.text);
  assert.match(skipped.text, /No backup before this update/);
  assert.match(readFileSync(join(dir, ".env"), "utf8"), /^XELDASH_VERSION=9\.9\.9\s*$/m);
  // The update replaced the compose file with one without services, so "down" alone leaves the project's network behind (and
  // Docker runs out of networks after enough runs): remove it by the project's name, the folder's.
  spawnSync("docker", ["compose", "down"], { cwd: dir });
  spawnSync("docker", ["network", "rm", `${basename(dir).toLowerCase()}_default`]);
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

test("Windows: a new setup stops when xelDash already has a database on this computer, and says where", { skip: hasPowerShell ? false : "needs Windows PowerShell" }, () => {
  const source = readFileSync(LAUNCHER, "utf8");
  const fn = /^function Get-ExistingInstall[\s\S]*?^}/m.exec(source)?.[0];
  assert.ok(fn, "Get-ExistingInstall is in the launcher");
  // Stand-ins for docker (run through cmd by the launcher): project "xeldash" has a database, run from C:/xelDash; "empty" has a database but no containers left.
  const script = `
    function Test-Native([string]$CommandLine) { return $CommandLine -match "volume inspect (xeldash|empty)_postgres-data$" }
    function cmd { if (($args -join " ") -match "project=xeldash ") { "com.docker.compose.project=xeldash,com.docker.compose.project.working_dir=C:/xelDash,com.docker.compose.service=api" } }
    ${fn}
    foreach ($p in "xeldash", "empty", "xeldash2") { $w = Get-ExistingInstall $p; if ($null -eq $w) { "$($p): none" } else { "$($p): [$($w.Dir)]" } }
  `;
  const r = ps(["-Command", script]);
  assert.deepEqual(r.stdout.trim().split(/\r?\n/), ["xeldash: [C:/xelDash]", "empty: []", "xeldash2: none"], r.stderr);
});

test("Windows: XELDASH_CONNECT_HOST is added from the old XELDASH_PUBLIC_HOST, which stays for going back; lan keeps both the same", { skip: hasPowerShell ? false : "needs Windows PowerShell" }, () => {
  const source = readFileSync(LAUNCHER, "utf8");
  const fn = /^function Rename-OldSettings[\s\S]*?^}/m.exec(source)?.[0];
  assert.ok(fn, "Rename-OldSettings is in the launcher");
  const setEnv = /^function Set-EnvValue[\s\S]*?^}/m.exec(source)?.[0];
  const setHost = /^function Set-ConnectHost[\s\S]*?^}/m.exec(source)?.[0];
  assert.ok(setEnv && setHost, "Set-EnvValue and Set-ConnectHost are in the launcher");
  const run = (/** @type {string} */ before, /** @type {string} */ command) => {
    const dir = mkdtempSync(join(tmpdir(), "rename-"));
    const file = join(dir, ".env");
    writeFileSync(file, before);
    const r = ps(["-Command", `$envPath = '${file}'\n${fn}\n${setEnv}\n${setHost}\n${command}`]);
    assert.equal(r.status, 0, r.stderr);
    const after = readFileSync(file, "utf8");
    rmSync(dir, { recursive: true, force: true });
    return after;
  };
  const rename = (/** @type {string} */ before) => run(before, "Rename-OldSettings");
  const kept = "# Kept the same as XELDASH_CONNECT_HOST, for going back to xelDash 0.6.1 or older:\n";
  assert.equal(rename("A=1\nXELDASH_PUBLIC_HOST=192.168.1.10\nB=2\n"), `A=1\nXELDASH_CONNECT_HOST=192.168.1.10\n${kept}XELDASH_PUBLIC_HOST=192.168.1.10\nB=2\n`);
  assert.equal(rename("XELDASH_PUBLIC_HOST=\n"), `XELDASH_CONNECT_HOST=\n${kept}XELDASH_PUBLIC_HOST=\n`, "an empty one too");
  assert.equal(rename(`XELDASH_CONNECT_HOST=a\n${kept}XELDASH_PUBLIC_HOST=a\n`), `XELDASH_CONNECT_HOST=a\n${kept}XELDASH_PUBLIC_HOST=a\n`, "only once");
  assert.match(run(`XELDASH_CONNECT_HOST=a\n${kept}XELDASH_PUBLIC_HOST=a\n`, "Set-ConnectHost '192.168.1.20'"), /^XELDASH_CONNECT_HOST=192\.168\.1\.20\n# Kept.*\nXELDASH_PUBLIC_HOST=192\.168\.1\.20\n$/, "lan on sets both");
  assert.match(run(`XELDASH_CONNECT_HOST=a\n${kept}XELDASH_PUBLIC_HOST=a\n`, "Set-ConnectHost ''"), /^XELDASH_CONNECT_HOST=\n# Kept.*\nXELDASH_PUBLIC_HOST=\n$/, "lan off empties both");
  assert.equal(run("XELDASH_CONNECT_HOST=a\n", "Set-ConnectHost 'b'").trim(), "XELDASH_CONNECT_HOST=b", "a newer .env has only the new name");
  assert.equal(rename("XELDASH_PUBLIC_HOST=a\nXELDASH_CONNECT_HOST=b\n"), "XELDASH_PUBLIC_HOST=a\nXELDASH_CONNECT_HOST=b\n", "both there: left alone");
  assert.equal(rename("# XELDASH_PUBLIC_HOST=a\nC=3\n"), "# XELDASH_PUBLIC_HOST=a\nC=3\n", "a comment is not a setting");
});
