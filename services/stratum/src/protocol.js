export const STRATUM_ERRORS = Object.freeze({
  UNKNOWN: 20,
  STALE_JOB: 21,
  DUPLICATE_SHARE: 22,
  LOW_DIFFICULTY: 23,
  UNAUTHORIZED: 24,
});

export const DEFAULT_ALGORITHM = "xel/v3";
const ALGORITHM_ALIASES = new Map([
  ["xel/v1", "xel/v1"], ["xel/0", "xel/v1"],
  ["xel/v2", "xel/v2"], ["xel/1", "xel/v2"],
  ["xel/v3", "xel/v3"], ["xel/2", "xel/v3"],
]);

export function negotiateAlgorithm(supported = []) {
  if (!Array.isArray(supported) || supported.length === 0) return DEFAULT_ALGORITHM;
  const normalized = supported.map((algorithm) => ALGORITHM_ALIASES.get(algorithm));
  return ["xel/v3", "xel/v2", "xel/v1"].find((algorithm) => normalized.includes(algorithm)) ?? null;
}

export function parseRequest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || value.jsonrpc !== "2.0" || typeof value.method !== "string"
      || !Array.isArray(value.params ?? [])) {
    throw new TypeError("Invalid JSON-RPC request");
  }
  const id = Object.hasOwn(value, "id") ? value.id : null;
  if (!(typeof id === "string" || Number.isSafeInteger(id) || id === null)) {
    throw new TypeError("Invalid JSON-RPC id");
  }
  return { id, method: value.method, params: value.params ?? [] };
}

export function response(id, result) {
  return { jsonrpc: "2.0", id, result };
}

export function errorResponse(id, code, message, data = null) {
  return { jsonrpc: "2.0", id, error: { code, message, data } };
}

export function notification(method, params) {
  return { jsonrpc: "2.0", id: null, method, params };
}

export function encodeMessage(message) {
  return `${JSON.stringify(message)}\n`;
}
