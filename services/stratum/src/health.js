import { createServer } from "node:http";

/**
 * A tiny status endpoint: 200 while this server can give miners work, 503 with the reason while it
 * cannot (no node is ready, or the database does not answer). The redundancy cluster's address
 * manager asks it, so the shared address moves to a server that can really mine, not only one that
 * is powered on. Published on this computer's loopback only.
 * @param {{ port: number, host?: string, check: () => Promise<string | null>, logger?: Pick<Console, "info" | "warn"> }} options
 */
export function startHealthServer({ port, host = "0.0.0.0", check, logger = console }) {
  const server = createServer(async (request, response) => {
    if (request.method !== "GET" || (request.url ?? "").split("?")[0] !== "/healthz") {
      response.writeHead(404).end();
      return;
    }
    let reason;
    try {
      reason = await Promise.race([
        check(),
        new Promise((resolve) => setTimeout(() => resolve("health check timed out"), 3_000).unref()),
      ]);
    } catch (error) {
      reason = error instanceof Error ? error.message : String(error);
    }
    const body = JSON.stringify(reason ? { ok: false, reason } : { ok: true });
    response.writeHead(reason ? 503 : 200, { "content-type": "application/json", "content-length": Buffer.byteLength(body), "cache-control": "no-store" });
    response.end(body);
  });
  server.listen(port, host, () => logger.info?.(`xelDash health listening on ${host}:${port}`));
  return { close: () => new Promise((resolve) => server.close(() => resolve(undefined))) };
}
