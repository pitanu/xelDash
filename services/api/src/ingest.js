import { timingSafeEqual } from "node:crypto";
import { ingestRecords } from "@xeldash/db";

// Where a standby server (the second server of a redundancy cluster) sends what it recorded while it
// mined, in batches, because it has no database of its own. Protected by the cluster secret, which both
// servers share (XELDASH_CLUSTER_SECRET in .env); without it set, the endpoints do not exist.

const MAX_BODY_BYTES = 4 * 1024 * 1024;
const MAX_RECORDS = 2_000;
const MIN_SECRET_LENGTH = 16;

/** @param {string} a @param {string} b */
function same(a, b) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** @param {import("node:http").IncomingMessage} request */
async function readBody(request) {
  let size = 0;
  /** @type {Buffer[]} */
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new RangeError("Request body too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Handles /api/v1/ingest (POST: a batch) and /api/v1/ingest/ping (GET: is the database ready for one).
 * Returns false when the request is not for this module.
 * @param {{ request: import("node:http").IncomingMessage, response: import("node:http").ServerResponse, pathname: string,
 *   pool: import("pg").Pool, secret: string | undefined, send: (response: import("node:http").ServerResponse, status: number, body: unknown) => void,
 *   logger?: Pick<Console, "info" | "warn"> }} context
 */
export async function handleIngest({ request, response, pathname, pool, secret, send, logger = console }) {
  if (pathname !== "/api/v1/ingest" && pathname !== "/api/v1/ingest/ping") return false;
  if (!secret || secret.length < MIN_SECRET_LENGTH) {
    send(response, 404, { error: "not_found" });
    return true;
  }
  const header = request.headers["x-cluster-secret"];
  if (typeof header !== "string" || !same(header, secret)) {
    send(response, 401, { error: "Wrong or missing cluster secret" });
    return true;
  }
  if (pathname === "/api/v1/ingest/ping") {
    await pool.query("SELECT 1");
    send(response, 200, { ok: true });
    return true;
  }
  if (request.method !== "POST") {
    send(response, 405, { error: "method_not_allowed" });
    return true;
  }
  let body;
  try {
    body = JSON.parse(await readBody(request));
  } catch (error) {
    send(response, error instanceof RangeError ? 413 : 400, { error: error instanceof RangeError ? "too_large" : "bad_request" });
    return true;
  }
  if (typeof body?.instance !== "string" || !Array.isArray(body.records) || body.records.length > MAX_RECORDS) {
    send(response, 400, { error: "Send { instance, records: [...] } with at most 2000 records" });
    return true;
  }
  const result = await ingestRecords(pool, body.instance, body.records);
  if (result.applied > 0) logger.info?.(`Recorded ${result.applied} record${result.applied === 1 ? "" : "s"} from ${body.instance}`);
  send(response, 200, result);
  return true;
}
