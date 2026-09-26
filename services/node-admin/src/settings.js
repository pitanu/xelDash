import { existsSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

// Flags xelDash sets itself or depends on; the dashboard cannot change them.
export const LOCKED = new Set([
  "network", "rpc-bind-address", "dir-path", "config-file", "generate-config-template",
  "disable-rpc-server", "help", "version",
]);
// Values that must never be sent back to the browser.
const SECRET = /password|private-key|secret/;
export const UNCHANGED_SECRET = "__unchanged__";
// Options that change how the node stores or checks the chain; the dashboard warns before use.
const CAUTION = /^(use-db-backend|simulator|genesis-block-hex|skip-pow-verification|skip-block-template-txs-verification|disable-p2p-server|recovery-mode|auto-prune-keep-n-blocks|allow-fast-sync)$/;

/** @type {[string, RegExp][]} */
const GROUPS = [
  ["P2P", /^p2p-|^(tag|max-peers|priority-nodes|exclusive-nodes|allow-fast-sync|allow-boost-sync|allow-priority-blocks|max-chain-response-size|disable-ip-sharing|disable-fast-sync-support|enable-p2p-compression|disable-p2p-server)$/],
  ["RPC", /^rpc-/],
  ["GetWork", /^getwork-|^disable-getwork-server$/],
  ["Metrics", /prometheus/],
  ["Storage", /^(rocksdb-|sled-|use-db-backend|flush-db-every-n-blocks|check-db-integrity|recovery-mode|auto-prune-keep-n-blocks)/],
  ["Logging", /log|datetime-format|disable-ascii-art/],
];

/** @typedef {{ flag: string, valueName: string | null, description: string, default: string | null, choices: string[], group: string, secret: boolean, caution: boolean }} Setting */

/**
 * Settings from the daemon's own --help (clap long help), so the list always matches the
 * installed daemon version. Positional arguments and locked flags are left out.
 * @param {string} text @returns {Setting[]}
 */
export function parseHelp(text) {
  const lines = text.replace(/\r/g, "").split("\n");
  /** @type {Setting[]} */
  const settings = [];
  /** @type {{ flag: string, valueName: string | null, body: string[] } | null} */
  let current = null;
  const flush = () => {
    if (!current || LOCKED.has(current.flag)) return;
    const body = current.body.join("\n");
    const def = /\[default: ([^\]]*)\]/.exec(body)?.[1] ?? null;
    const inline = /\[possible values: ([^\]]*)\]/.exec(body)?.[1];
    const listed = [...body.matchAll(/^\s*- ([A-Za-z0-9_.-]+):/gm)].map((m) => m[1]);
    const description = body
      .replace(/\[default: [^\]]*\]/g, "")
      .replace(/\[possible values: [^\]]*\]/g, "")
      .replace(/\n\s*Possible values:[\s\S]*$/, "")
      .split("\n").map((l) => l.trim()).join("\n").replace(/\n{3,}/g, "\n\n").trim();
    settings.push({
      flag: current.flag,
      valueName: current.valueName,
      description,
      default: def,
      choices: inline ? inline.split(",").map((v) => v.trim()) : listed,
      group: GROUPS.find(([, re]) => re.test(current?.flag ?? ""))?.[0] ?? "Core",
      secret: SECRET.test(current.flag),
      caution: CAUTION.test(current.flag),
    });
  };
  let inOptions = false;
  for (const line of lines) {
    if (/^Options:/.test(line)) {
      inOptions = true;
      continue;
    }
    if (!inOptions) continue;
    const header = /^\s{2,8}(?:-[A-Za-z0-9], )?--([a-z0-9-]+)(?: <([^>]+)>)?(?:\s{2,}(.*))?$/.exec(line);
    if (header) {
      flush();
      current = { flag: header[1], valueName: header[2] ?? null, body: header[3] ? [header[3]] : [] };
    } else if (current) {
      current.body.push(line);
    }
  }
  flush();
  return settings;
}

/**
 * Saved dashboard settings: extra daemon flags on the node's data volume, one per line, in the
 * form `--flag` or `--flag=value`. The node's entrypoint checks and applies them on restart.
 */
export class DaemonSettings {
  /** @param {{ dataDir: string }} options */
  constructor({ dataDir }) {
    this.control = join(dataDir, ".xeldash");
  }

  path(/** @type {string} */ name) {
    return join(this.control, name);
  }

  async schema() {
    const help = await readFile(this.path("daemon-help.txt"), "utf8").catch(() => null);
    return help ? parseHelp(help) : null;
  }

  /** @param {string} name @returns {Promise<Record<string, string | true> | null>} */
  async readArgs(name) {
    const text = await readFile(this.path(name), "utf8").catch(() => null);
    if (text === null) return null;
    /** @type {Record<string, string | true>} */
    const values = {};
    for (const line of text.split("\n").map((l) => l.trim()).filter(Boolean)) {
      const match = /^--([a-z0-9-]+)(?:=([\s\S]*))?$/.exec(line);
      if (match) values[match[1]] = match[2] === undefined ? true : match[2];
    }
    return values;
  }

  /** @param {Setting[] | null} schema @param {Record<string, string | true> | null} values */
  mask(schema, values) {
    if (!values) return values;
    const secret = new Set((schema ?? []).filter((s) => s.secret).map((s) => s.flag));
    return Object.fromEntries(Object.entries(values).map(([k, v]) => [k, secret.has(k) && v !== true ? UNCHANGED_SECRET : v]));
  }

  async lastResult() {
    const text = (await readFile(this.path("settings-result"), "utf8").catch(() => "")).trim();
    const match = /^(\S+) (applied|rejected|reverted)\s*([\s\S]*)$/.exec(text);
    return match ? { at: match[1], outcome: match[2], message: match[3] || null } : null;
  }

  async status() {
    const schema = await this.schema();
    return {
      available: schema !== null,
      schema,
      locked: [...LOCKED].filter((flag) => !["help", "version"].includes(flag)),
      current: this.mask(schema, (await this.readArgs("daemon-args")) ?? {}),
      pending: this.mask(schema, await this.readArgs("daemon-args.pending")),
      lastResult: await this.lastResult(),
    };
  }

  /**
   * Validate settings from the dashboard and save them for the next restart. Only values
   * that differ from the daemon's defaults need to be sent; an empty object clears them all.
   * @param {Record<string, unknown>} values
   */
  async save(values) {
    const schema = await this.schema();
    if (!schema) throw new Error("The node has not reported its settings yet; start it once first");
    const byFlag = new Map(schema.map((s) => [s.flag, s]));
    const current = (await this.readArgs("daemon-args")) ?? {};
    /** @type {string[]} */
    const lines = [];
    for (const [flag, raw] of Object.entries(values)) {
      if (LOCKED.has(flag)) throw new Error(`--${flag} is set by xelDash and cannot be changed here`);
      const setting = byFlag.get(flag);
      if (!setting) throw new Error(`The daemon has no --${flag} option`);
      if (setting.valueName === null) {
        if (raw !== true) throw new Error(`--${flag} is an on/off switch`);
        lines.push(`--${flag}`);
        continue;
      }
      let value = raw;
      if (setting.secret && value === UNCHANGED_SECRET) {
        value = current[flag];
        if (typeof value !== "string") throw new Error(`--${flag} has no saved value to keep`);
      }
      if (typeof value !== "string" || value.length === 0 || value.length > 2000 || /[\r\n]/.test(value)) {
        throw new Error(`--${flag} needs a single-line value`);
      }
      if (setting.choices.length > 0 && !setting.choices.includes(value)) {
        throw new Error(`--${flag} must be one of: ${setting.choices.join(", ")}`);
      }
      if (setting.default !== null && /^\d+$/.test(setting.default) && !/^\d+$/.test(value)) {
        throw new Error(`--${flag} must be a whole number`);
      }
      lines.push(`--${flag}=${value}`);
    }
    const text = lines.length ? `${lines.join("\n")}\n` : "";
    const same = ((await readFile(this.path("daemon-args"), "utf8").catch(() => "")) === text);
    if (same) await rm(this.path("daemon-args.pending"), { force: true });
    else await writeFile(this.path("daemon-args.pending"), text);
    return { pending: !same };
  }

  /** Ask the node to restart; its entrypoint applies pending settings first. */
  async requestRestart() {
    await writeFile(this.path("RESTART"), new Date().toISOString());
  }

  async discardPending() {
    await rm(this.path("daemon-args.pending"), { force: true });
  }

  hasPending() {
    return existsSync(this.path("daemon-args.pending"));
  }
}
