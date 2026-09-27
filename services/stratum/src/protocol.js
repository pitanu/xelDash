export const STRATUM_ERRORS = Object.freeze({
  UNKNOWN: 20,
  STALE_JOB: 21,
  DUPLICATE_SHARE: 22,
  LOW_DIFFICULTY: 23,
  UNAUTHORIZED: 24,
});

export const DEFAULT_ALGORITHM = "xel/v3";
/** @typedef {string | number | null} JsonRpcId */
/** @typedef {{ id: JsonRpcId, method: string, params: unknown[] }} StratumRequest */
const ALGORITHM_ALIASES = new Map([
  ["xel/v1", "xel/v1"], ["xel/0", "xel/v1"],
  ["xel/v2", "xel/v2"], ["xel/1", "xel/v2"],
  ["xel/v3", "xel/v3"], ["xel/2", "xel/v3"],
]);

/** @param {string[]} [supported] @returns {string | null} */
export function negotiateAlgorithm(supported = []) {
  if (!Array.isArray(supported) || supported.length === 0) return DEFAULT_ALGORITHM;
  const normalized = supported.map((algorithm) => ALGORITHM_ALIASES.get(algorithm));
  return ["xel/v3", "xel/v2", "xel/v1"].find((algorithm) => normalized.includes(algorithm)) ?? null;
}

/** @param {unknown} value @returns {StratumRequest} */
export function parseRequest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Invalid JSON-RPC request");
  }
  const request = /** @type {Record<string, unknown>} */ (value);
  // GPU miners such as Rigel speak classic Stratum and leave out "jsonrpc"; accept that, but
  // not a different version.
  if ((request.jsonrpc !== undefined && request.jsonrpc !== "2.0") || typeof request.method !== "string"
      || !Array.isArray(request.params ?? [])) {
    throw new TypeError("Invalid JSON-RPC request");
  }
  const id = Object.hasOwn(request, "id") ? request.id : null;
  if (!(typeof id === "string" || Number.isSafeInteger(id) || id === null)) {
    throw new TypeError("Invalid JSON-RPC id");
  }
  return {
    id: /** @type {JsonRpcId} */ (id),
    method: /** @type {string} */ (request.method),
    params: /** @type {unknown[]} */ (request.params ?? []),
  };
}

/** @param {JsonRpcId} id @param {unknown} result */
export function response(id, result) {
  return { jsonrpc: "2.0", id, result };
}

/** @param {JsonRpcId} id @param {number} code @param {string} message @param {unknown} [data] */
export function errorResponse(id, code, message, data = null) {
  return { jsonrpc: "2.0", id, error: { code, message, data } };
}

/** @param {string} method @param {unknown[]} params */
export function notification(method, params) {
  return { jsonrpc: "2.0", id: null, method, params };
}

/** @param {unknown} message */
export function encodeMessage(message) {
  return `${JSON.stringify(message)}\n`;
}
