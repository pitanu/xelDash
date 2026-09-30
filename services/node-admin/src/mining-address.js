import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

// The address xelDash mines to when a miner does not send its own. It is set from the
// dashboard's setup page, checked by the node itself, and kept on the shared config volume
// where Stratum reads it. XELIS_DEFAULT_ADDRESS in .env is only the starting value.

const SHAPE = /^(xel|xet):[a-z0-9]{30,120}$/;

/** What the daemon call could not do, in words a beginner can act on. */
export class AddressProblem extends Error {}

export class MiningAddress {
  /** @param {{ configDir: string, network: string, env: Partial<Record<string, string | undefined>>, rpcUrl?: string }} options */
  constructor({ configDir, network, env, rpcUrl = "http://daemon:8080/json_rpc" }) {
    this.configDir = configDir;
    this.file = join(configDir, "mining-address.json");
    this.network = network;
    this.rpcUrl = rpcUrl;
    this.envAddress = (env.XELIS_DEFAULT_ADDRESS ?? "").trim();
    // Mainnet addresses start with "xel:"; testnet and devnet with "xet:".
    this.prefix = network === "mainnet" ? "xel" : "xet";
  }

  /** Start from the .env value when nothing was saved from the dashboard yet. */
  async init() {
    if (!(await this.read()) && this.envAddress) await this.write(this.envAddress, "env");
  }

  /** @returns {Promise<{ address: string, source: string } | null>} */
  async read() {
    try {
      const saved = JSON.parse(await readFile(this.file, "utf8"));
      return typeof saved.address === "string" && saved.address ? { address: saved.address, source: saved.source ?? "dashboard" } : null;
    } catch {
      return null;
    }
  }

  /** @param {string} address @param {string} source */
  async write(address, source) {
    await mkdir(this.configDir, { recursive: true });
    const body = { address, source, network: this.network, updatedAt: new Date().toISOString() };
    await writeFile(`${this.file}.tmp`, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o644 });
    await rename(`${this.file}.tmp`, this.file);
  }

  async status() {
    const saved = await this.read();
    return { address: saved?.address ?? null, source: saved?.source ?? null, network: this.network, prefix: this.prefix };
  }

  /**
   * Check an address the way a beginner needs it explained, then ask the node, which is the
   * authority on what is valid for this network.
   * @param {string} input
   */
  async validate(input) {
    const address = input.trim();
    if (!address) throw new AddressProblem("Paste your XELIS address first.");
    if (/\s/.test(address)) throw new AddressProblem("An address has no spaces. Copy it again from your wallet.");
    const wrongNetwork = this.prefix === "xel" ? /^xet:/i.test(address) : /^xel:/i.test(address);
    if (wrongNetwork) {
      throw new AddressProblem(this.prefix === "xel"
        ? "That is a test-network address (it starts with xet:). This server mines on mainnet, so use an address that starts with xel:."
        : `That is a mainnet address (it starts with xel:), but this server is on ${this.network}, which needs an address that starts with xet:.`);
    }
    if (!SHAPE.test(address)) {
      throw new AddressProblem(`That does not look like a XELIS address. It should start with ${this.prefix}: followed by lowercase letters and numbers.`);
    }
    /** @type {{ is_valid?: boolean, is_integrated?: boolean } | undefined} */
    let result;
    try {
      const response = await fetch(this.rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "validate_address", params: { address, allow_integrated: true } }),
        signal: AbortSignal.timeout(5_000),
      });
      const body = await response.json();
      if (body.error) {
        // The node answered, and did not like the address. That is a typo, not an outage.
        throw new AddressProblem(/checksum/i.test(String(body.error.message))
          ? "This address has a typo: its checksum does not match. Copy it again from your wallet, all of it."
          : "The node says this is not a valid XELIS address. Check that it was copied completely, with no missing letters.");
      }
      result = body.result;
    } catch (error) {
      if (error instanceof AddressProblem) throw error;
      throw new AddressProblem("Your node is not answering yet, so the address cannot be checked. Wait a minute and try again.");
    }
    if (!result?.is_valid) throw new AddressProblem("The node says this is not a valid XELIS address. Check that it was copied completely, with no missing letters.");
    if (result.is_integrated) throw new AddressProblem("This is an integrated address (it carries a payment ID). Use your normal wallet address instead.");
    return address;
  }

  /** Save an address (empty clears it, back to the .env value if there is one). @param {string} input */
  async set(input) {
    if (!input.trim()) {
      await this.write(this.envAddress, this.envAddress ? "env" : "cleared");
      return this.status();
    }
    await this.write(await this.validate(input), "dashboard");
    return this.status();
  }
}
