import { spawn } from "node:child_process";
import { createHash, timingSafeEqual } from "node:crypto";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { lstat, mkdir, readdir, readFile, rename, rm, stat, statfs, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";

// Unpacked RocksDB snapshots are about as large as the zip; keep headroom on top of that.
const DISK_MARGIN = 1.1;
const DOWNLOAD_RETRIES = 5;

/** @param {unknown} error */
export function message(error) {
  return error instanceof Error ? error.message : String(error);
}

/** @param {string} a @param {string} b */
export function tokensMatch(a, b) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Run a command, collecting stdout. Rejects on a non-zero exit. @param {string} cmd @param {string[]} args @param {AbortSignal} [signal] @returns {Promise<string>} */
function run(cmd, args, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { signal, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(`${cmd} exited with ${code}: ${err.trim().slice(0, 300)}`))));
  });
}

/**
 * Throw if anything under a directory is not a plain file or directory. A symlink in a
 * snapshot could point the node's database at files elsewhere in its container.
 * @param {string} dir
 */
async function requireRegularFiles(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    const info = await lstat(path);
    if (info.isDirectory()) await requireRegularFiles(path);
    else if (!info.isFile()) throw new Error(`The archive contains a link or special file (${entry.name}); only regular files are accepted`);
  }
}

/** Total size of the files under a directory. @param {string} dir @returns {Promise<number>} */
async function dirSize(dir) {
  let total = 0;
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const path = join(dir, entry.name);
    total += entry.isDirectory() ? await dirSize(path) : (await stat(path).catch(() => ({ size: 0 }))).size;
  }
  return total;
}

/**
 * Copy a directory tree of regular files, reporting bytes as they are written.
 * @param {string} from @param {string} to @param {AbortSignal} signal @param {(bytes: number) => void} onBytes
 */
async function copyTree(from, to, signal, onBytes) {
  await mkdir(to, { recursive: true });
  for (const entry of await readdir(from, { withFileTypes: true })) {
    signal.throwIfAborted();
    const source = join(from, entry.name);
    const target = join(to, entry.name);
    if (entry.isDirectory()) {
      await copyTree(source, target, signal, onBytes);
    } else if (entry.isFile()) {
      const input = createReadStream(source);
      input.on("data", (chunk) => onBytes(chunk.length));
      await pipeline(input, createWriteStream(target), { signal });
    } else {
      throw new Error(`Refusing to copy ${entry.name}: not a regular file`);
    }
  }
}

/**
 * @typedef {{ phase: "idle" | "downloading" | "uploading" | "verifying" | "extracting" | "copying" | "ready" | "error",
 *   source: "download" | "upload" | "copy" | null, bytes: number, total: number | null, startedAt: string | null,
 *   note: string | null, error: string | null, sha256: string | null, checksumMatches: boolean | null }} SnapshotState
 */

/**
 * Downloads, receives, verifies and unpacks node snapshots onto the node's data volume. The
 * node container's entrypoint swaps a staged snapshot in when it restarts (docker/daemon/
 * entrypoint.sh); the two only share marker files under `<data>/.xeldash`.
 */
export class SnapshotManager {
  /**
   * @param {{ dataDir: string, network: string, snapshotUrl: string | null, checksumUrl: string | null,
   *   logger?: Pick<Console, "info" | "warn"> }} options
   */
  constructor({ dataDir, network, snapshotUrl, checksumUrl, logger = console }) {
    this.dataDir = dataDir;
    this.network = network;
    this.snapshotUrl = snapshotUrl;
    this.checksumUrl = checksumUrl;
    this.logger = logger;
    this.control = join(dataDir, ".xeldash");
    this.work = join(this.control, "work");
    this.staged = join(this.control, "staged");
    this.db = join(dataDir, network);
    /** @type {SnapshotState} */
    this.state = { phase: "idle", source: null, bytes: 0, total: null, startedAt: null, note: null, error: null, sha256: null, checksumMatches: null };
    /** @type {AbortController | null} */
    this.abort = null;
    this.stopping = false;
    /** @type {{ size: number | null, lastModified: string | null, checkedAt: number } | null} */
    this.officialInfo = null;
  }

  get busy() {
    return ["downloading", "uploading", "verifying", "extracting", "copying"].includes(this.state.phase);
  }

  hasData() {
    return existsSync(join(this.db, "CURRENT"));
  }

  isStaged() {
    return existsSync(join(this.staged, "READY"));
  }

  async init() {
    await mkdir(this.work, { recursive: true });
    // An interrupted run leaves partial extraction behind; a partial download is kept for resuming.
    await rm(join(this.work, "extract"), { recursive: true, force: true });
    await rm(join(this.work, "upload.zip"), { force: true });
    if (this.isStaged()) this.set({ phase: "ready", note: "A snapshot is staged; restart the node to switch to it." });
  }

  /** @param {Partial<SnapshotState>} patch */
  set(patch) {
    this.state = { ...this.state, ...patch };
  }

  /** @param {"download" | "upload" | "copy"} source @param {number | null} total */
  begin(source, total) {
    if (this.busy) throw new Error(`Another snapshot operation is running (${this.state.phase})`);
    this.abort = new AbortController();
    const phase = source === "download" ? "downloading" : source === "upload" ? "uploading" : "copying";
    this.set({ phase, source, bytes: 0, total,
      startedAt: new Date().toISOString(), note: null, error: null, sha256: null, checksumMatches: null });
    return this.abort.signal;
  }

  /** @param {unknown} error */
  fail(error) {
    const text = message(error);
    this.logger.warn?.(`Snapshot failed: ${text}`);
    this.set({ phase: "error", error: text });
    this.abort = null;
  }

  /** Service shutdown: stop work, but leave the bootstrap marker so the node keeps waiting. */
  shutdown() {
    this.stopping = true;
    this.cancel();
  }

  cancel() {
    if (!this.busy) return false;
    this.abort?.abort(new Error("Cancelled"));
    return true;
  }

  async disk() {
    const s = await statfs(this.dataDir);
    return { free: s.bavail * s.bsize, total: s.blocks * s.bsize };
  }

  /** Size and date of the official snapshot, cached for ten minutes. */
  async official() {
    if (!this.snapshotUrl) return null;
    if (this.officialInfo && Date.now() - this.officialInfo.checkedAt < 600_000) return this.officialInfo;
    try {
      const head = await fetch(this.snapshotUrl, { method: "HEAD", signal: AbortSignal.timeout(10_000) });
      this.officialInfo = {
        size: Number(head.headers.get("content-length")) || null,
        lastModified: head.headers.get("last-modified"),
        checkedAt: Date.now(),
      };
    } catch {
      this.officialInfo = { size: null, lastModified: null, checkedAt: Date.now() };
    }
    return this.officialInfo;
  }

  async officialChecksum() {
    if (!this.checksumUrl) return null;
    const text = await (await fetch(this.checksumUrl, { signal: AbortSignal.timeout(15_000) })).text();
    const match = /\b([0-9a-f]{64})\b/i.exec(text);
    if (!match) throw new Error("The official checksum file has no SHA-256");
    return match[1].toLowerCase();
  }

  /** Refuse to start without room for what is still to be written. @param {number} bytes */
  async requireSpace(bytes) {
    const { free } = await this.disk();
    const needed = Math.ceil(bytes * DISK_MARGIN);
    if (free < needed) {
      throw new Error(`Not enough disk space: ${Math.round(needed / 1e9)} GB needed, ${Math.round(free / 1e9)} GB free on the node's data volume`);
    }
  }

  /**
   * Download the official snapshot, resuming a partial download when the server still has the
   * same file (same ETag). A snapshot published during the download restarts it from zero, so
   * the file never mixes two versions.
   */
  async download() {
    if (!this.snapshotUrl) throw new Error(`No official snapshot is published for ${this.network}`);
    const url = this.snapshotUrl;
    const signal = this.begin("download", null);
    const part = join(this.work, "download.zip");
    const metaFile = join(this.work, "download.json");
    try {
      const head = await fetch(url, { method: "HEAD", signal });
      if (!head.ok) throw new Error(`Snapshot server returned HTTP ${head.status}`);
      const size = Number(head.headers.get("content-length"));
      const etag = head.headers.get("etag") ?? head.headers.get("last-modified") ?? "";
      const checksum = await this.officialChecksum();
      this.set({ total: size });
      const meta = JSON.parse(await readFile(metaFile, "utf8").catch(() => "{}"));
      const have = meta.etag === etag && existsSync(part) ? (await stat(part)).size : 0;
      if (have === 0) await rm(part, { force: true });
      else this.logger.info?.(`Resuming the snapshot download at ${have} of ${size} bytes`);
      // The rest of the zip, plus its unpacked copy (about the same size).
      await this.requireSpace(size - have + size);
      await writeFile(metaFile, JSON.stringify({ etag, size, checksum }));

      for (let attempt = 1; ; attempt += 1) {
        const offset = existsSync(part) ? (await stat(part)).size : 0;
        this.set({ bytes: offset });
        if (offset >= size) break;
        try {
          const response = await fetch(url, {
            headers: offset > 0 ? { range: `bytes=${offset}-`, "if-range": etag } : {},
            signal,
          });
          if (!response.ok || !response.body) throw new Error(`Snapshot server returned HTTP ${response.status}`);
          // 200 instead of 206 means the file changed since the partial download: start over.
          const append = response.status === 206;
          if (!append && offset > 0) this.logger.info?.("The official snapshot changed; restarting the download");
          const out = createWriteStream(part, { flags: append ? "a" : "w" });
          let bytes = append ? offset : 0;
          const counter = new TransformStream({ transform: (chunk, controller) => {
            bytes += chunk.byteLength;
            this.set({ bytes });
            controller.enqueue(chunk);
          } });
          await pipeline(response.body.pipeThrough(counter), out, { signal });
        } catch (error) {
          if (signal.aborted || attempt >= DOWNLOAD_RETRIES) throw error;
          this.logger.warn?.(`Snapshot download interrupted (${message(error)}); retrying (${attempt}/${DOWNLOAD_RETRIES})`);
          await new Promise((resolve) => setTimeout(resolve, 5_000 * attempt));
        }
      }
      const sha256 = await this.hashFile(part, signal);
      if (checksum && sha256 !== checksum) {
        await rm(part, { force: true });
        throw new Error("The downloaded snapshot does not match the official checksum; it was deleted. Try again.");
      }
      this.set({ sha256, checksumMatches: checksum ? true : null });
      await this.extract(part, signal);
      await rm(metaFile, { force: true });
    } catch (error) {
      this.fail(error);
      throw error;
    }
  }

  /**
   * Receive an uploaded snapshot zip as a stream, hashing it on the way to disk.
   * @param {import("node:stream").Readable} body @param {number} size
   */
  async upload(body, size) {
    const signal = this.begin("upload", size);
    const file = join(this.work, "upload.zip");
    try {
      await this.requireSpace(size * 2);
      const hash = createHash("sha256");
      let bytes = 0;
      body.on("data", (chunk) => {
        bytes += chunk.length;
        hash.update(chunk);
        this.set({ bytes });
      });
      await pipeline(body, createWriteStream(file), { signal });
      if (bytes !== size) throw new Error(`Upload incomplete: received ${bytes} of ${size} bytes`);
      const sha256 = hash.digest("hex");
      // Only today's official file has a published checksum; an older or self-made snapshot
      // is accepted, relying on the zip's own CRC checks during extraction.
      const official = await this.officialChecksum().catch(() => null);
      this.set({ sha256, checksumMatches: official ? sha256 === official : null });
    } catch (error) {
      await rm(file, { force: true });
      this.fail(error);
      throw error;
    }
    // The upload request is answered now; unpacking a large snapshot takes minutes.
    void this.extract(file, signal).catch(async (error) => {
      await rm(file, { force: true });
      this.fail(error);
    });
  }

  /** @param {string} file @param {AbortSignal} signal */
  async hashFile(file, signal) {
    this.set({ phase: "verifying", bytes: 0, total: (await stat(file)).size });
    const hash = createHash("sha256");
    let bytes = 0;
    const stream = createReadStream(file);
    stream.on("data", (chunk) => {
      bytes += chunk.length;
      this.set({ bytes });
    });
    await pipeline(stream, hash, { signal });
    return hash.digest("hex");
  }

  /**
   * Check the archive, unpack the database and stage it for the node. Rejects archives with
   * unsafe paths or without a RocksDB database (a CURRENT and a MANIFEST file).
   * @param {string} zip @param {AbortSignal} signal
   */
  async extract(zip, signal) {
    this.set({ phase: "extracting", bytes: 0, total: null });
    const names = (await run("unzip", ["-Z1", zip], signal)).split("\n").filter(Boolean);
    if (names.some((name) => name.startsWith("/") || name.split("/").includes(".."))) {
      throw new Error("The archive contains unsafe paths");
    }
    // zipinfo lists each entry's type first: "-" for files, "d" for directories, "l" for links.
    const types = (await run("unzip", ["-Z", zip], signal)).split("\n").filter((line) => /^[a-z-][rwxsStT-]{9}\s/.test(line));
    if (types.some((line) => !["-", "d"].includes(line[0]))) {
      throw new Error("The archive contains links or special files; only regular files are accepted");
    }
    const current = names.filter((name) => name === "CURRENT" || name.endsWith("/CURRENT"));
    if (current.length !== 1) throw new Error("The archive does not contain exactly one RocksDB database (CURRENT file)");
    const prefix = current[0].slice(0, -"CURRENT".length);
    if (!names.some((name) => name.startsWith(`${prefix}MANIFEST-`))) throw new Error("The archive's database has no MANIFEST file");
    const totals = /(\d+) bytes uncompressed/.exec(await run("unzip", ["-Zt", zip], signal));
    const unpacked = totals ? Number(totals[1]) : null;
    if (unpacked) {
      const { free } = await this.disk();
      if (free < unpacked * DISK_MARGIN) throw new Error(`Not enough disk space to unpack: ${Math.round(unpacked / 1e9)} GB needed`);
    }
    this.set({ total: unpacked });

    const target = join(this.work, "extract");
    await rm(target, { recursive: true, force: true });
    await mkdir(target, { recursive: true });
    const progress = setInterval(() => {
      void dirSize(target).then((bytes) => { if (this.state.phase === "extracting") this.set({ bytes }); });
    }, 3_000);
    try {
      // unzip checks each file's CRC and fails on corruption.
      await run("unzip", ["-q", "-o", zip, `${prefix}*`, "-d", target], signal);
    } finally {
      clearInterval(progress);
    }
    // A second check on what was actually written, in case the listing missed something.
    await requireRegularFiles(target);
    await rm(this.staged, { recursive: true, force: true });
    await rename(join(target, prefix), this.staged);
    await rm(join(this.staged, "LOCK"), { force: true });
    await writeFile(join(this.staged, "READY"), new Date().toISOString());
    await rm(target, { recursive: true, force: true });
    await rm(zip, { force: true });
    this.abort = null;
    this.set({ phase: "ready", bytes: 0, total: null,
      note: "The snapshot is ready. Restart the node to switch to it; the current data is kept as a backup." });
    this.logger.info?.("Snapshot unpacked and staged for the node");
  }

  /**
   * Copy another node's chain data into this node: stop the source so its database is closed,
   * copy it into this node's staging area, start the source again, then restart this node,
   * which swaps the copy in (its own data is kept as <network>.previous).
   * @param {import("./nodes.js").Node} source
   */
  async copyFrom(source) {
    const from = source.snapshots.db;
    if (!existsSync(join(from, "CURRENT"))) throw new Error(`${source.id} has no chain data to copy`);
    const size = await dirSize(from);
    await this.requireSpace(size);
    const signal = this.begin("copy", size);
    let stopped = false;
    try {
      this.set({ note: `Stopping ${source.id} so its database can be copied…` });
      await source.stopAndWait();
      stopped = true;
      this.set({ note: `Copying from ${source.id}; it starts again when the copy is done.` });
      const target = join(this.work, "copy");
      await rm(target, { recursive: true, force: true });
      let bytes = 0;
      await copyTree(from, target, signal, (n) => {
        bytes += n;
        this.set({ bytes });
      });
      await source.start();
      stopped = false;
      await rm(join(target, "LOCK"), { force: true });
      await rm(this.staged, { recursive: true, force: true });
      await rename(target, this.staged);
      await writeFile(join(this.staged, "READY"), new Date().toISOString());
      this.abort = null;
      await writeFile(join(this.control, "RESTART"), new Date().toISOString());
      this.set({ phase: "idle", source: null, bytes: 0, total: null,
        note: `Copied ${Math.round(size / 1e9)} GB from ${source.id}. The node is restarting with it; its previous data is kept as a backup.` });
      this.logger.info?.(`Copied chain data from ${source.id}`);
    } catch (error) {
      if (stopped) await source.start();
      await rm(join(this.work, "copy"), { recursive: true, force: true });
      this.fail(error);
      throw error;
    }
  }

  /** Ask the node's entrypoint to restart the daemon, which swaps the staged snapshot in. */
  async requestRestart() {
    if (!this.isStaged()) throw new Error("No snapshot is staged");
    await writeFile(join(this.control, "RESTART"), new Date().toISOString());
    this.set({ phase: "idle", source: null, note: "The node is restarting with the new snapshot." });
  }

  async discardStaged() {
    if (this.busy) throw new Error("A snapshot operation is running");
    await rm(this.staged, { recursive: true, force: true });
    this.set({ phase: "idle", source: null, note: null, error: null });
  }

  async discardPrevious() {
    await rm(`${this.db}.previous`, { recursive: true, force: true });
  }

  async status() {
    const previous = existsSync(join(`${this.db}.previous`, "CURRENT"));
    return {
      network: this.network,
      officialAvailable: Boolean(this.snapshotUrl),
      official: await this.official(),
      state: this.state,
      dataPresent: this.hasData(),
      staged: this.isStaged(),
      previous,
      bootstrapping: existsSync(join(this.control, "BOOTSTRAPPING")),
      disk: await this.disk(),
    };
  }

  /** Without automatic snapshots, make sure no stale marker holds the node back. */
  async clearBootstrap() {
    await rm(join(this.control, "BOOTSTRAPPING"), { force: true });
  }

  /**
   * First start with XELIS_SNAPSHOT_AUTO: hold the node back (BOOTSTRAPPING marker) and fetch
   * the official snapshot. If it fails, the node starts anyway and syncs normally.
   */
  async bootstrap() {
    const marker = join(this.control, "BOOTSTRAPPING");
    if (this.hasData() || this.isStaged() || !this.snapshotUrl) {
      await rm(marker, { force: true });
      return false;
    }
    await writeFile(marker, new Date().toISOString());
    void this.download().then(
      () => rm(marker, { force: true }),
      async (error) => {
        // Stopped by a restart of this service: keep holding the node; the next start resumes.
        if (this.stopping) return;
        this.logger.warn?.(`Automatic snapshot failed; the node will sync from the network instead: ${message(error)}`);
        await rm(marker, { force: true });
      },
    );
    return true;
  }
}
