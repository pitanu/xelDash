import { readFile } from "node:fs/promises";

/**
 * Reads the mining fallback switch that node-admin writes (the dashboard's Node page), and
 * reports the fallback node URL whenever it changes: a URL when switched on, null when off.
 * A missing or unreadable file means off.
 * @param {{ file: string, intervalMs?: number, onChange: (url: string | null) => void | Promise<void>,
 *   logger?: Pick<Console, "warn"> }} options
 */
export function watchFallbackConfig({ file, intervalMs = 5_000, onChange, logger = console }) {
  /** @type {string | null | undefined} */
  let current;
  let warned = false;
  let busy = false;

  async function check() {
    if (busy) return;
    busy = true;
    try {
      /** @type {string | null} */
      let url = null;
      try {
        const config = JSON.parse(await readFile(file, "utf8"));
        if (config?.fallback?.enabled === true && typeof config.fallback.url === "string") {
          const { protocol } = new URL(config.fallback.url);
          if (protocol === "http:" || protocol === "https:") url = config.fallback.url;
        }
        warned = false;
      } catch (error) {
        const code = /** @type {{ code?: string }} */ (error).code;
        if (code !== "ENOENT" && !warned) {
          logger.warn?.(`Cannot read ${file}; the mining fallback stays off: ${error instanceof Error ? error.message : String(error)}`);
          warned = true;
        }
      }
      if (url !== current) {
        current = url;
        await onChange(url);
      }
    } finally {
      busy = false;
    }
  }

  const timer = setInterval(() => void check(), intervalMs);
  timer.unref();
  return { ready: check(), stop: () => clearInterval(timer) };
}
