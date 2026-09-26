import { readFileSync } from "node:fs";

/** @typedef {{ port: number, cert: Buffer, key: Buffer, certFile: string }} TlsConfig */

/**
 * Optional TLS listener. Disabled unless STRATUM_TLS_ENABLED=true; when enabled, a missing or
 * unreadable certificate is a startup error rather than a silent fallback to plain Stratum.
 * @param {Partial<Record<string, string | undefined>>} env @returns {TlsConfig | null}
 */
export function tlsConfigFromEnv(env) {
  if ((env.STRATUM_TLS_ENABLED ?? "false").toLowerCase() !== "true") return null;
  const port = Number.parseInt(env.STRATUM_TLS_PORT ?? "3334", 10);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error("STRATUM_TLS_PORT must be an integer from 1 to 65535");
  }
  const certFile = env.STRATUM_TLS_CERT_FILE ?? "/tls/cert.pem";
  const keyFile = env.STRATUM_TLS_KEY_FILE ?? "/tls/key.pem";
  /** @param {string} file @param {string} what */
  const read = (file, what) => {
    try {
      return readFileSync(file);
    } catch (error) {
      throw new Error(`STRATUM_TLS_ENABLED is true but the TLS ${what} ${file} cannot be read`, { cause: error });
    }
  };
  return { port, cert: read(certFile, "certificate"), key: read(keyFile, "key"), certFile };
}
