// Public mode (XELDASH_PUBLIC_MODE=true): the dashboard is open to the internet, for a server that lets anyone solo mine to their own
// address. Visitors must never learn a miner's IP address, so every API response to them goes through scrubIps. The operator's own
// view (the admin-web container, published on 127.0.0.1 only) marks its requests with X-Xeldash-View: admin; the public web server
// always overwrites that header, so a visitor cannot claim it.

/** @param {Partial<Record<string, string | undefined>>} env */
export function publicModeFromEnv(env) {
  return /^(1|true|yes|on)$/i.test((env.XELDASH_PUBLIC_MODE ?? "").trim());
}

/**
 * Whether this request gets the public view: public mode is on and the request did not come through the operator's admin web.
 * @param {boolean} publicMode @param {import("node:http").IncomingMessage} request
 */
export function isPublicView(publicMode, request) {
  return publicMode && request.headers["x-xeldash-view"] !== "admin";
}

// Field names that hold an IP address anywhere in the API's answers (workers' last address, bans, connection problems, events).
const IP_KEYS = new Set(["ip", "lastIp", "last_ip", "remoteIp", "remote_ip", "clientIp", "client_ip"]);

/**
 * A copy of a JSON value with every IP-address field removed, at any depth. Applied to everything the public view sends, so an
 * endpoint added later cannot leak an address by forgetting to.
 * @template T @param {T} value @returns {T}
 */
export function scrubIps(value) {
  if (Array.isArray(value)) return /** @type {T} */ (value.map(scrubIps));
  if (value instanceof Date || value === null || typeof value !== "object") return value;
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const [key, inner] of Object.entries(value)) {
    if (!IP_KEYS.has(key)) out[key] = scrubIps(inner);
  }
  return /** @type {T} */ (out);
}

/**
 * Settings that make a public server less safe or not work, logged at startup. Public mode still starts with them (the operator may
 * have a reason, such as their own reverse proxy).
 * @param {Partial<Record<string, string | undefined>>} env @returns {string[]}
 */
export function publicModeWarnings(env) {
  if (!publicModeFromEnv(env)) return [];
  const warnings = [];
  const allowed = (env.XELDASH_ALLOWED_NETWORKS ?? "private").trim().toLowerCase();
  if (allowed === "private" || allowed === "") {
    warnings.push("XELDASH_ALLOWED_NETWORKS is \"private\": miners and dashboard visitors on the internet are turned away. Set it to \"any\" for a public server.");
  }
  if (!(env.XELDASH_PUBLIC_DOMAIN ?? "").trim()) {
    warnings.push("XELDASH_PUBLIC_DOMAIN is empty, so the built-in HTTPS (profile public-https) is not set up: unless your own HTTPS reverse proxy is in front, visitors use plain HTTP. See docs/OPERATIONS.md#public-mode.");
  }
  if ((env.XELIS_DEFAULT_ADDRESS ?? "").trim()) {
    warnings.push("XELIS_DEFAULT_ADDRESS is ignored in public mode: every miner must log in with its own address.");
  }
  return warnings;
}
