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
 * Whether visitors of a public server see worker names (XELDASH_PUBLIC_HIDE_WORKERS=true hides them; off by default). Worker names
 * are what miners call their rigs ("garage-pc", a hostname, a name): with this on, a visitor sees an address's totals and how many
 * rigs it has, not what they are called. The operator's own view always has them.
 * @param {Partial<Record<string, string | undefined>>} env
 */
export function hideWorkersFromEnv(env) {
  return /^(1|true|yes|on)$/i.test((env.XELDASH_PUBLIC_HIDE_WORKERS ?? "").trim());
}

// Field names that hold a worker's name in the API's answers (blocks, best shares, problems).
const WORKER_KEYS = new Set(["worker", "workerName"]);

/**
 * A copy of a JSON value without worker names, at any depth, for the public view with XELDASH_PUBLIC_HIDE_WORKERS: worker-name
 * fields removed, and lists of workers emptied (the miner route sends their totals as workerTotals instead). Like scrubIps, it is
 * applied to everything that view sends, so a route added later cannot leak a name by forgetting to.
 * @template T @param {T} value @returns {T}
 */
export function scrubWorkers(value) {
  if (Array.isArray(value)) return /** @type {T} */ (value.map(scrubWorkers));
  if (value instanceof Date || value === null || typeof value !== "object") return value;
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const [key, inner] of Object.entries(value)) {
    if (WORKER_KEYS.has(key)) continue;
    out[key] = key === "workers" && Array.isArray(inner) ? [] : scrubWorkers(inner);
  }
  return /** @type {T} */ (out);
}

/**
 * An address's workers as totals only: how many, and their hashrate and shares added up (what the miner page shows above its list).
 * @param {{ hashrate5m: string, hashrate1h: string, accepted1h: string, rejected1h: string }[]} workers
 */
export function workerTotals(workers) {
  const sum = (/** @type {"hashrate5m" | "hashrate1h" | "accepted1h" | "rejected1h"} */ key) => workers.reduce((t, w) => t + Number(w[key]), 0);
  return {
    count: workers.length,
    hashrate5m: sum("hashrate5m").toFixed(3),
    hashrate1h: sum("hashrate1h").toFixed(3),
    accepted1h: String(sum("accepted1h")),
    rejected1h: String(sum("rejected1h")),
  };
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
  // The API believes the view header, which only the web servers set: reached directly, anyone could ask for the operator's view.
  const apiBind = (env.API_BIND_IP ?? "127.0.0.1").trim().toLowerCase();
  if (!["127.0.0.1", "localhost", "::1", ""].includes(apiBind)) {
    warnings.push(`XELDASH_API_BIND_IP is ${apiBind}: anyone who reaches the API's port directly can ask for the operator's view, IP addresses included. Keep it 127.0.0.1; visitors use the dashboard.`);
  }
  // The public dashboard is meant to be reached through HTTPS (the public-https profile, or your own proxy on this computer). Published
  // past it, visitors skip HTTPS, and where connections arrive from the Docker network (Docker Desktop, IPv6 through Docker's proxy)
  // the per-visitor limits, which trust X-Forwarded-For from that network, can be dodged with a made-up header.
  const webBind = (env.WEB_BIND_IP ?? "127.0.0.1").trim().toLowerCase();
  if (!["127.0.0.1", "localhost", "::1", ""].includes(webBind)) {
    warnings.push(`XELDASH_WEB_BIND_IP is ${webBind}: the dashboard's own port is reachable past the HTTPS proxy, where visitors skip HTTPS and, on some setups, can dodge the per-visitor limits with a made-up X-Forwarded-For header. Keep it 127.0.0.1; the proxy reaches the dashboard anyway.`);
  }
  if ((env.XELIS_DEFAULT_ADDRESS ?? "").trim()) {
    warnings.push("XELIS_DEFAULT_ADDRESS is ignored in public mode: every miner must log in with its own address.");
  }
  return warnings;
}
