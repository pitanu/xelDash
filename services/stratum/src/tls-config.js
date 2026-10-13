import { readFileSync, statSync } from "node:fs";
import { X509Certificate } from "node:crypto";
import { createSecureContext } from "node:tls";

/** @typedef {{ port: number, certFile: string, keyFile: string }} TlsConfig */
/** @typedef {{ cert: Buffer, key: Buffer, validTo: Date }} TlsPair */

/**
 * Optional TLS listener. Disabled unless STRATUM_TLS_ENABLED=true. The certificate is read by watchTlsCertificate.
 * @param {Partial<Record<string, string | undefined>>} env @returns {TlsConfig | null}
 */
export function tlsConfigFromEnv(env) {
  if ((env.STRATUM_TLS_ENABLED ?? "false").toLowerCase() !== "true") return null;
  const port = Number.parseInt(env.STRATUM_TLS_PORT ?? "3334", 10);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error("STRATUM_TLS_PORT must be an integer from 1 to 65535");
  }
  return { port, certFile: env.STRATUM_TLS_CERT_FILE || "/tls/cert.pem", keyFile: env.STRATUM_TLS_KEY_FILE || "/tls/key.pem" };
}

/**
 * Read and check a certificate and its key. An error with code ENOENT means a file is not there (yet).
 * @param {TlsConfig} config @returns {TlsPair}
 */
export function loadTlsPair({ certFile, keyFile }) {
  /** @param {string} file @param {string} what */
  const read = (file, what) => {
    try {
      return readFileSync(file);
    } catch (error) {
      const code = /** @type {{ code?: string }} */ (error).code;
      throw Object.assign(new Error(`The TLS ${what} ${file} cannot be read${code ? ` (${code})` : ""}`, { cause: error }), { code });
    }
  };
  const cert = read(certFile, "certificate");
  const key = read(keyFile, "key");
  try {
    // Throws when the key does not belong to the certificate (for example one file renewed and the other not yet).
    createSecureContext({ cert, key });
    return { cert, key, validTo: new Date(new X509Certificate(cert).validTo) };
  } catch (error) {
    throw new Error(`The TLS certificate ${certFile} and key ${keyFile} do not make a usable pair: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}

/** @param {TlsConfig} config */
function signature({ certFile, keyFile }) {
  try {
    return [certFile, keyFile].map((file) => { const s = statSync(file); return `${s.mtimeMs}:${s.size}`; }).join("|");
  } catch {
    return null;
  }
}

/**
 * Load the certificate now and again whenever its files change, so a renewed certificate (Let's Encrypt renews every two months or
 * so) is used without a restart. A certificate that is there but unusable at start is an error, as before; one that is not there yet
 * (a public server's certificate is requested after the first start) is waited for, and plain Stratum runs meanwhile. A renewal
 * that cannot be used keeps the previous certificate, with a warning, and is tried again at the next check.
 * @param {{ config: TlsConfig, onLoad: (pair: TlsPair, first: boolean) => void, logger?: Pick<Console, "warn" | "info">,
 *   intervalMs?: number, waitIntervalMs?: number }} options
 */
export function watchTlsCertificate({ config, onLoad, logger = console, intervalMs = 10 * 60_000, waitIntervalMs = 30_000 }) {
  let loaded = false;
  /** @type {string | null} */
  let seen = null;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let timer = null;
  let stopped = false;
  /** @param {boolean} atStart */
  const attempt = (atStart) => {
    const now = signature(config);
    if (now === null) {
      if (atStart) logger.warn(`Stratum TLS waits for its certificate ${config.certFile} and key ${config.keyFile}; plain Stratum runs meanwhile`);
      return;
    }
    if (now === seen) return;
    try {
      const pair = loadTlsPair(config);
      seen = now;
      const first = !loaded;
      loaded = true;
      onLoad(pair, first);
      const days = Math.floor((pair.validTo.getTime() - Date.now()) / 86_400_000);
      if (days < 14) logger.warn(`The Stratum TLS certificate ${config.certFile} expires on ${pair.validTo.toISOString()} (in ${days} days)`);
    } catch (error) {
      if (atStart && /** @type {{ code?: string }} */ (error).code !== "ENOENT") throw error;
      seen = now;
      logger.warn(`${error instanceof Error ? error.message : String(error)}; ${loaded ? "keeping the certificate in use" : "plain Stratum runs meanwhile"}`);
    }
  };
  const schedule = () => {
    if (stopped) return;
    timer = setTimeout(() => {
      attempt(false);
      schedule();
    }, loaded ? intervalMs : waitIntervalMs);
    timer.unref?.();
  };
  attempt(true);
  schedule();
  return { stop: () => { stopped = true; if (timer) clearTimeout(timer); } };
}
