import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { chmod, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

// Official XELIS daemon releases, from the project's GitHub releases only.
const REPO = "xelis-project/xelis-blockchain";
const RELEASES_URL = `https://api.github.com/repos/${REPO}/releases?per_page=15`;
const CACHE_MS = 60 * 60_000;
const VERSION = /^v(\d+)\.(\d+)\.(\d+)$/;
// Downloads must come from the repository's own release files.
const DOWNLOADS = `https://github.com/${REPO}/releases/download/`;
// Release archive for this machine. The node runtime is Debian 13 (glibc), so the gnu builds.
const ASSETS = /** @type {Record<string, string>} */ ({ x64: "x86_64-unknown-linux-gnu", arm64: "aarch64-unknown-linux-gnu" });
// Keep this many downloaded versions per node; older ones are deleted after a switch.
const KEEP_VERSIONS = 3;

/** @typedef {{ version: string, publishedAt: string | null, url: string, archive: { name: string, url: string, sha256: string | null }, checksumsUrl: string }} Release */

/** @param {string} cmd @param {string[]} args */
function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    child.stderr.on("data", (d) => { err += d; });
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(undefined) : reject(new Error(`${cmd} exited with ${code}: ${err.trim().slice(0, 300)}`))));
  });
}

/** @param {string} file */
async function sha256File(file) {
  const hash = createHash("sha256");
  await pipeline(createReadStream(file), hash);
  return hash.digest("hex");
}

/** The SHA-256 a checksums.txt lists for a file name. @param {string} text @param {string} name */
function checksumFor(text, name) {
  for (const line of text.split("\n")) {
    const match = /^([0-9a-f]{64})\s+\*?(\S+)\s*$/i.exec(line.trim());
    if (match && match[2] === name) return match[1].toLowerCase();
  }
  return null;
}

/** "1.25.0" style versions, newest first. @param {string} a @param {string} b */
export function compareVersions(a, b) {
  const x = a.split(".").map(Number);
  const y = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

export class Releases {
  constructor() {
    this.platform = ASSETS[process.arch] ?? null;
    /** @type {{ at: number, releases: Release[] } | null} */
    this.cache = null;
  }

  /** Stable releases with an archive for this machine, newest first. */
  async list() {
    if (!this.platform) return [];
    if (this.cache && Date.now() - this.cache.at < CACHE_MS) return this.cache.releases;
    const response = await fetch(RELEASES_URL, {
      headers: { accept: "application/vnd.github+json", "user-agent": "xelDash" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`GitHub returned HTTP ${response.status}`);
    const body = /** @type {any[]} */ (await response.json());
    /** @type {Release[]} */
    const releases = [];
    for (const r of body) {
      if (r.draft || r.prerelease || !VERSION.test(r.tag_name ?? "")) continue;
      const archive = r.assets?.find((/** @type {any} */ a) => a.name === `${this.platform}.tar.gz`);
      const checksums = r.assets?.find((/** @type {any} */ a) => a.name === "checksums.txt");
      if (!archive || !checksums) continue;
      if (![archive, checksums].every((/** @type {any} */ a) => String(a.browser_download_url).startsWith(DOWNLOADS))) continue;
      releases.push({
        version: r.tag_name.slice(1),
        publishedAt: r.published_at ?? null,
        url: r.html_url,
        archive: {
          name: archive.name,
          url: archive.browser_download_url,
          sha256: typeof archive.digest === "string" && archive.digest.startsWith("sha256:") ? archive.digest.slice(7).toLowerCase() : null,
        },
        checksumsUrl: checksums.browser_download_url,
      });
    }
    releases.sort((a, b) => compareVersions(b.version, a.version));
    this.cache = { at: Date.now(), releases };
    return releases;
  }

  /** @param {string} version */
  async find(version) {
    const release = (await this.list()).find((r) => r.version === version);
    if (!release) throw new Error(`No release ${version} for this machine`);
    return release;
  }

  /**
   * Download a release, check it, and place its xelis_daemon on the node's volume, ready for
   * the node's supervisor to switch to. The archive must match both the release's
   * checksums.txt and GitHub's own digest for the file, and the daemon inside it the archive's
   * own checksums.txt.
   * @param {import("./nodes.js").Node} node @param {string} version
   */
  async install(node, version) {
    const target = join(node.control, "bin", version, "xelis_daemon");
    if (existsSync(target)) return;
    const release = await this.find(version);
    const work = join(node.control, "work", `release-${version}`);
    await rm(work, { recursive: true, force: true });
    await mkdir(work, { recursive: true });
    try {
      const archive = join(work, release.archive.name);
      const response = await fetch(release.archive.url, { signal: AbortSignal.timeout(10 * 60_000) });
      if (!response.ok || !response.body) throw new Error(`Download failed: HTTP ${response.status}`);
      await pipeline(Readable.fromWeb(/** @type {any} */ (response.body)), createWriteStream(archive));

      const checksums = await (await fetch(release.checksumsUrl, { signal: AbortSignal.timeout(30_000) })).text();
      const listed = checksumFor(checksums, release.archive.name);
      const actual = await sha256File(archive);
      if (!listed || listed !== actual) throw new Error("The download does not match the release's checksums.txt");
      if (release.archive.sha256 && release.archive.sha256 !== actual) throw new Error("The download does not match GitHub's digest for it");

      await run("tar", ["-xzf", archive, "-C", work, `${this.platform}/xelis_daemon`, `${this.platform}/checksums.txt`]);
      const binary = join(work, this.platform, "xelis_daemon");
      const inner = checksumFor(await readFile(join(work, this.platform, "checksums.txt"), "utf8"), "xelis_daemon");
      if (!inner || inner !== await sha256File(binary)) throw new Error("xelis_daemon does not match the archive's checksums.txt");

      await chmod(binary, 0o755);
      await mkdir(join(node.control, "bin", version), { recursive: true });
      await rename(binary, target);
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  }

  /**
   * Ask the node to run a downloaded version (or "image", its image's own daemon) from its
   * next start, and restart it now.
   * @param {import("./nodes.js").Node} node @param {string} version
   */
  async activate(node, version) {
    if (version !== "image" && !existsSync(join(node.control, "bin", version, "xelis_daemon"))) {
      throw new Error(`${version} is not downloaded for ${node.id}`);
    }
    await mkdir(join(node.control, "bin"), { recursive: true });
    await writeFile(join(node.control, "bin", "pending"), version);
    await node.start();
    await writeFile(node.marker("RESTART"), new Date().toISOString());
  }

  /** Delete downloaded versions beyond the newest few, never the one in use. @param {import("./nodes.js").Node} node */
  async prune(node) {
    const dir = join(node.control, "bin");
    const current = await readFile(join(dir, "current"), "utf8").then((t) => t.trim()).catch(() => null);
    const versions = (await readdir(dir, { withFileTypes: true }).catch(() => []))
      .filter((e) => e.isDirectory() && /^\d+\.\d+\.\d+$/.test(e.name)).map((e) => e.name)
      .sort((a, b) => compareVersions(b, a));
    for (const version of versions.slice(KEEP_VERSIONS)) {
      if (version !== current) await rm(join(dir, version), { recursive: true, force: true });
    }
  }

  /** Which daemon a node runs and the outcome of the last switch. @param {import("./nodes.js").Node} node */
  async nodeStatus(node) {
    const dir = join(node.control, "bin");
    const current = await readFile(join(dir, "current"), "utf8").then((t) => t.trim()).catch(() => null);
    const pending = await readFile(join(dir, "pending"), "utf8").then((t) => t.trim()).catch(() => null);
    const text = (await readFile(node.marker("upgrade-result"), "utf8").catch(() => "")).trim();
    const match = /^(\S+) (applied|rejected|reverted)\s*([\s\S]*)$/.exec(text);
    const installed = (await readdir(dir, { withFileTypes: true }).catch(() => []))
      .filter((e) => e.isDirectory() && existsSync(join(dir, e.name, "xelis_daemon"))).map((e) => e.name)
      .sort((a, b) => compareVersions(b, a));
    return {
      binary: current ?? "image",
      pending,
      installed,
      lastResult: match ? { at: match[1], outcome: match[2], message: match[3] || null } : null,
    };
  }
}
