// Connects once the database answers. The migrate service starts as soon as Compose thinks PostgreSQL is healthy, but on some
// computers (a slow one, under the load of an update, or another Compose version) it starts while PostgreSQL is still coming up, and
// a single failed connection made the whole update fail. Errors that waiting cannot fix (a wrong password, a missing database) still
// fail at once.

/** SQLSTATE codes and network errors that mean "not ready yet", not "wrong". */
const NOT_READY_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "EAI_AGAIN", "ETIMEDOUT", "EHOSTUNREACH", "57P03"]);
const NOT_READY_TEXT = /database system is (starting up|shutting down|in recovery mode)|connection terminated|the database system is not yet accepting/i;

/** Whether a connection error is worth waiting out. @param {any} error */
export function isNotReady(error) {
  if (!error) return false;
  const code = typeof error.code === "string" ? error.code : "";
  return NOT_READY_CODES.has(code) || code.startsWith("08") || NOT_READY_TEXT.test(String(error.message ?? ""));
}

/**
 * Connect a fresh client, again and again while the database is not ready, for up to `timeoutMs`.
 * @template {{ connect: () => Promise<unknown>, end: () => Promise<unknown> }} C
 * @param {() => C} makeClient a new client for each try (a pg client cannot connect twice)
 * @param {{ timeoutMs?: number, intervalMs?: number, logger?: Pick<Console, "info">, now?: () => number,
 *   sleep?: (ms: number) => Promise<void> }} [options]
 * @returns {Promise<C>}
 */
export async function connectWhenReady(makeClient, {
  timeoutMs = 90_000, intervalMs = 2_000, logger = console, now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  const started = now();
  let told = false;
  for (;;) {
    const client = makeClient();
    try {
      await client.connect();
      if (told) logger.info?.("The database answers; applying migrations");
      return client;
    } catch (error) {
      await client.end().catch(() => {});
      if (!isNotReady(error) || now() - started >= timeoutMs) throw error;
      if (!told) {
        told = true;
        logger.info?.(`Waiting for the database to accept connections (${error instanceof Error ? error.message : String(error)})`);
      }
      await sleep(intervalMs);
    }
  }
}
