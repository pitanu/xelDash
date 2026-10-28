// Which host names the dashboard and API answer to (DNS rebinding). A website can point its own domain at your dashboard's address
// (your LAN address, or 127.0.0.1) and then read the dashboard's answers in your browser as if they were its own. Such a request
// always carries the website's domain in Host, so answering only names that belong here stops it: addresses, names without a dot
// (a computer's own name, "localhost", Docker's service names), the local-only suffixes below, and the names in .env. The web
// container applies the same rules in nginx (docker/web/42-allowed-hosts.sh); keep the two in step.

/** Suffixes that only exist on your own network or computer, so a website cannot have a name under them. */
export const LOCAL_SUFFIXES = ["localhost", "local", "lan", "home", "home.arpa", "internal", "ts.net"];

/**
 * @typedef {{ any: boolean, names: Set<string>, suffixes: string[] }} HostRules
 * any: answer every host name (XELDASH_ALLOWED_HOSTS=any); names: exact names; suffixes: "*.example.org" entries, as "example.org"
 */

/** A host name as written in .env, lower case and without a port or trailing dot. @param {string} value */
function cleanName(value) {
  return value.trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/:\d+$/, "").replace(/\.$/, "");
}

/**
 * The names this server answers to besides the built-in ones: where miners are told to connect, the public domain, the HTTPS proxy's
 * name, and XELDASH_ALLOWED_HOSTS (a comma list; "*.example.org" for every name under it; "any" turns the check off).
 * @param {Partial<Record<string, string | undefined>>} env @returns {HostRules}
 */
export function hostRulesFromEnv(env) {
  /** @type {HostRules} */
  const rules = { any: false, names: new Set(), suffixes: [] };
  const configured = [env.XELDASH_CONNECT_HOST, env.XELDASH_PUBLIC_HOST, env.CONNECT_HOST, env.XELDASH_PUBLIC_DOMAIN, env.XELDASH_PROXY_HOST];
  for (const value of configured) if (value && cleanName(value)) rules.names.add(cleanName(value));
  for (const entry of (env.XELDASH_ALLOWED_HOSTS ?? "").split(",").map((e) => e.trim()).filter(Boolean)) {
    if (entry.toLowerCase() === "any") rules.any = true;
    else if (entry.startsWith("*.")) rules.suffixes.push(cleanName(entry.slice(2)));
    else rules.names.add(cleanName(entry));
  }
  return rules;
}

/**
 * Whether a request's Host header names this server. A request without one (HTTP/1.0, some health checks) cannot come from a
 * rebinding page and is answered.
 * @param {string | undefined} header @param {HostRules} rules
 */
export function hostAllowed(header, rules) {
  if (rules.any || header === undefined || header.trim() === "") return true;
  const value = header.trim().toLowerCase();
  // [IPv6 address], with or without a port.
  if (/^\[[0-9a-f:.]+\](:\d+)?$/.test(value)) return true;
  const name = value.replace(/:\d+$/, "").replace(/\.$/, "");
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(name)) return true;
  if (/^[a-z0-9_-]+$/.test(name)) return true;
  if (rules.names.has(name)) return true;
  const under = (/** @type {string} */ suffix) => name === suffix || name.endsWith(`.${suffix}`);
  return LOCAL_SUFFIXES.some(under) || rules.suffixes.some(under);
}
