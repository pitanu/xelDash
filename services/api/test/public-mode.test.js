import test from "node:test";
import assert from "node:assert/strict";
import { isPublicView, publicModeFromEnv, publicModeWarnings, scrubIps } from "../src/public-mode.js";
import { getConnectInfo } from "../src/connect.js";

const request = (headers = {}) => /** @type {import("node:http").IncomingMessage} */ (/** @type {unknown} */ ({ headers }));

test("public mode is on only for an explicit yes", () => {
  for (const value of ["true", "TRUE", "1", "yes", "on", " true "]) assert.equal(publicModeFromEnv({ XELDASH_PUBLIC_MODE: value }), true, value);
  for (const value of [undefined, "", "false", "0", "no", "off", "public"]) assert.equal(publicModeFromEnv({ XELDASH_PUBLIC_MODE: value }), false, String(value));
});

test("in public mode only the operator's admin web gets the full view", () => {
  assert.equal(isPublicView(false, request()), false, "not a public server: everyone gets the full view");
  assert.equal(isPublicView(true, request()), true);
  assert.equal(isPublicView(true, request({ "x-xeldash-view": "public" })), true);
  assert.equal(isPublicView(true, request({ "x-xeldash-view": "Admin" })), true, "exactly \"admin\" only");
  assert.equal(isPublicView(true, request({ "x-xeldash-view": "admin" })), false);
});

test("every IP-address field is removed, at any depth, and nothing else", () => {
  const input = {
    ip: "203.0.113.1", lastIp: "203.0.113.2", last_ip: "203.0.113.3",
    worker: { name: "rig1", lastIp: "2001:db8::1", seen: new Date(0) },
    bans: [{ ip: "203.0.113.4", reason: "invalid shares" }],
    events: [{ type: "ip_banned", payload: { ip: "203.0.113.5", until: "x" } }],
    address: "xel:abc", count: 3, ok: true, none: null,
  };
  const out = scrubIps(input);
  assert.doesNotMatch(JSON.stringify(out), /203\.0\.113|2001:db8/);
  assert.deepEqual(out.bans, [{ reason: "invalid shares" }]);
  assert.deepEqual(out.events[0], { type: "ip_banned", payload: { until: "x" } });
  assert.equal(out.address, "xel:abc");
  assert.equal(out.worker.name, "rig1");
  assert.ok(out.worker.seen instanceof Date);
  assert.equal(out.none, null);
  assert.equal(input.ip, "203.0.113.1", "the original is not changed");
  assert.equal(scrubIps("text"), "text");
});

test("risky public-mode settings are warned about, and nothing is said when public mode is off", () => {
  assert.deepEqual(publicModeWarnings({ XELIS_DEFAULT_ADDRESS: "xel:x" }), []);
  const all = publicModeWarnings({ XELDASH_PUBLIC_MODE: "true", XELIS_DEFAULT_ADDRESS: "xel:x" });
  assert.equal(all.length, 3);
  assert.match(all.join("\n"), /XELDASH_ALLOWED_NETWORKS/);
  assert.match(all.join("\n"), /XELDASH_PUBLIC_DOMAIN/);
  assert.match(all.join("\n"), /XELIS_DEFAULT_ADDRESS is ignored/);
  assert.deepEqual(publicModeWarnings({ XELDASH_PUBLIC_MODE: "true", XELDASH_ALLOWED_NETWORKS: "any", XELDASH_PUBLIC_DOMAIN: "solo.example.org" }), []);
});

test("a public server's visitors are never offered the operator's address", async () => {
  const env = { XELIS_NETWORK: "mainnet", XELIS_DEFAULT_ADDRESS: "xel:operator" };
  const operator = await getConnectInfo(env, { publicMode: true, publicView: false });
  assert.equal(operator.address, "xel:operator");
  assert.equal(operator.view, "operator");
  const visitor = await getConnectInfo(env, { publicMode: true, publicView: true });
  assert.equal(visitor.address, null);
  assert.equal(visitor.view, "public");
  assert.equal(visitor.publicMode, true);
  assert.equal((await getConnectInfo(env)).publicMode, false, "off by default");
});
