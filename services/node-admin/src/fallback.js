import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

// Public RPC nodes run by the XELIS team. Stratum can mine through one of them while none of
// our own nodes can issue work; it is never used while one of ours can.
const OFFICIAL_NODES = /** @type {Record<string, string>} */ ({
  mainnet: "https://node.xelis.io/json_rpc",
  testnet: "https://testnet-node.xelis.io/json_rpc",
});

/**
 * The mining fallback switch, kept in a small file on the shared config volume. Stratum and
 * the API read it every few seconds, so a change needs no restart.
 */
export class MiningFallback {
  /** @param {{ configDir: string, network: string, env: Partial<Record<string, string | undefined>> }} options */
  constructor({ configDir, network, env }) {
    this.file = join(configDir, "mining-nodes.json");
    this.configDir = configDir;
    const url = env.XELIS_OFFICIAL_NODE_URL?.trim() || OFFICIAL_NODES[network] || null;
    if (url) {
      const { protocol } = new URL(url);
      if (protocol !== "http:" && protocol !== "https:") throw new Error("XELIS_OFFICIAL_NODE_URL must be http(s)");
    }
    this.url = url;
    this.defaultEnabled = (env.XELIS_OFFICIAL_FALLBACK ?? "false").toLowerCase() === "true";
  }

  /** Write the .env default on first start, so a headless setup works without the dashboard. */
  async init() {
    const saved = await this.read();
    if (!saved) await this.write(this.defaultEnabled && this.url !== null);
  }

  async read() {
    try {
      return JSON.parse(await readFile(this.file, "utf8"));
    } catch {
      return null;
    }
  }

  async status() {
    const saved = await this.read();
    return { available: this.url !== null, url: this.url, enabled: Boolean(saved?.fallback?.enabled && this.url) };
  }

  /** @param {boolean} enabled */
  async write(enabled) {
    if (enabled && !this.url) throw new Error("There is no official node for this network");
    await mkdir(this.configDir, { recursive: true });
    const body = { fallback: { enabled, url: this.url }, updatedAt: new Date().toISOString() };
    // Write and rename, so a reader never sees half a file.
    await writeFile(`${this.file}.tmp`, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o644 });
    await rename(`${this.file}.tmp`, this.file);
    return this.status();
  }
}
