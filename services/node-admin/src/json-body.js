// The small JSON bodies node-admin accepts (settings), read with a size limit.

/** A settings body over MAX_JSON_BYTES: answered 413. */
export class BodyTooLarge extends Error {}
export const MAX_JSON_BYTES = 100_000;

/**
 * Read a small JSON body (settings), refusing anything large: bytes are counted as they arrive, so a large body is stopped there
 * rather than gathered first.
 * @param {import("node:http").IncomingMessage} request
 */
export async function readJson(request) {
  /** @type {Buffer[]} */
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > MAX_JSON_BYTES) throw new BodyTooLarge(`Request body too large (at most ${MAX_JSON_BYTES} bytes)`);
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return null;
  }
}
