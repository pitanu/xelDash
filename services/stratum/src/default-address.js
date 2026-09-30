import { readFile } from "node:fs/promises";

/**
 * The address to mine to when a miner does not send one: the one chosen on the dashboard's
 * setup page (a small file on the shared config volume), else XELIS_DEFAULT_ADDRESS from
 * .env. Re-read every few seconds, so a change needs no restart.
 * @param {{ file: string, fallback?: string, intervalMs?: number, logger?: Pick<Console, "warn"> }} options
 */
export function watchDefaultAddress({ file, fallback = "", intervalMs = 5_000, logger = console }) {
  let current = fallback;
  let warned = false;

  async function read() {
    try {
      const saved = JSON.parse(await readFile(file, "utf8"));
      current = typeof saved.address === "string" && saved.address ? saved.address : fallback;
      warned = false;
    } catch (error) {
      current = fallback;
      const code = /** @type {{ code?: string }} */ (error).code;
      if (code !== "ENOENT" && !warned) {
        logger.warn?.(`Cannot read ${file}; using the address from .env: ${error instanceof Error ? error.message : String(error)}`);
        warned = true;
      }
    }
  }

  const timer = setInterval(() => void read(), intervalMs);
  timer.unref();
  return { ready: read(), get: () => current, stop: () => clearInterval(timer) };
}
