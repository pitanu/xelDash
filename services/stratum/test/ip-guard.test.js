import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_IP_GUARD, IpGuard, MessageRateLimiter, ipGuardConfigFromEnv, normalizeIp, parseAllowedNetworks } from "../src/ip-guard.js";

test("allowed networks: private by default, presets, ranges, addresses and any", () => {
  const priv = parseAllowedNetworks("");
  for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.5", "169.254.1.1", "::1", "fd00::1", "fe80::1"]) assert.ok(priv.allows(ip), ip);
  for (const ip of ["8.8.8.8", "172.32.0.1", "100.64.0.1", "2001:db8::1", "garbage", ""]) assert.ok(!priv.allows(ip), ip);
  assert.ok(parseAllowedNetworks("private,tailscale").allows("100.64.1.1"));
  assert.ok(parseAllowedNetworks("192.168.1.0/24").allows("192.168.1.77"));
  assert.ok(!parseAllowedNetworks("192.168.1.0/24").allows("192.168.2.77"));
  assert.ok(parseAllowedNetworks("192.168.1.0/24").allows("127.0.0.1"), "this computer is always allowed");
  assert.ok(parseAllowedNetworks("203.0.113.5").allows("203.0.113.5"));
  assert.ok(parseAllowedNetworks("any").allows("8.8.8.8"));
  assert.equal(parseAllowedNetworks("any").any, true);
  assert.throws(() => parseAllowedNetworks("nonsense"), /STRATUM_ALLOWED_NETWORKS/);
  assert.throws(() => parseAllowedNetworks("10.0.0.0/40"), /bad network size/);
});

test("IPv4-mapped addresses are normalised", () => {
  assert.equal(normalizeIp("::ffff:10.0.0.5"), "10.0.0.5");
  assert.equal(normalizeIp("10.0.0.5"), "10.0.0.5");
  assert.equal(normalizeIp("::ffff:abcd"), "::ffff:abcd");
  assert.equal(normalizeIp(undefined), "unknown");
});

test("settings come from the environment and are checked", () => {
  assert.deepEqual(ipGuardConfigFromEnv({}), { ...DEFAULT_IP_GUARD, exemptIps: [], allowedNetworks: "private" });
  const c = ipGuardConfigFromEnv({ STRATUM_MAX_CONNECTIONS_PER_IP: "3", STRATUM_BAN_EXEMPT_IPS: "10.0.0.1, ::ffff:10.0.0.2", XELDASH_ALLOWED_NETWORKS: "private,tailscale" });
  assert.equal(c.maxConnectionsPerIp, 3);
  assert.deepEqual(c.exemptIps, ["10.0.0.1", "10.0.0.2"]);
  assert.equal(c.allowedNetworks, "private,tailscale");
  assert.throws(() => ipGuardConfigFromEnv({ STRATUM_MESSAGES_PER_SECOND: "0" }), /positive number/);
  assert.throws(() => ipGuardConfigFromEnv({ STRATUM_BAN_INVALID_RATIO: "1.5" }), /between 0 and 1/);
});

test("the message rate limiter is a token bucket", () => {
  const l = new MessageRateLimiter({ messagesPerSecond: 10, messageBurst: 20 }, 0);
  assert.ok(l.take(20, 0));
  assert.ok(!l.take(1, 0), "burst used up");
  const m = new MessageRateLimiter({ messagesPerSecond: 10, messageBurst: 20 }, 0);
  assert.ok(m.take(20, 0));
  assert.ok(m.take(5, 500), "half a second refills 5");
  assert.ok(!m.take(1, 500));
  const n = new MessageRateLimiter({ messagesPerSecond: 10, messageBurst: 20 }, 0);
  assert.ok(n.take(1, 10_000_000), "never more than the burst");
  assert.ok(n.take(19, 10_000_000));
  assert.ok(!n.take(1, 10_000_000));
});

const config = { ...DEFAULT_IP_GUARD, maxConnectionsPerIp: 2, invalidMinCount: 5, invalidRatio: 0.5, invalidWindowSeconds: 60, banMinutes: 15 };

test("connections: allowed networks, per-address limit, exempt addresses", () => {
  const g = new IpGuard({ ...config, exemptIps: ["10.0.0.9"] });
  assert.equal(g.connect("8.8.8.8", 0), "not on your local network");
  assert.equal(g.connect("10.0.0.1", 0), null);
  assert.equal(g.connect("10.0.0.1", 0), null);
  assert.equal(g.connect("10.0.0.1", 0), "too many connections");
  g.disconnect("10.0.0.1");
  assert.equal(g.connect("10.0.0.1", 0), null);
  for (let i = 0; i < 10; i++) assert.equal(g.connect("10.0.0.9", 0), null, "exempt: no limit");
});

test("bans: many invalid shares in a window ban the address for the configured time", () => {
  const bans = [];
  const g = new IpGuard(config, { onBan: (b) => bans.push(b) });
  const t = 1_000_000;
  for (let i = 0; i < 4; i++) assert.equal(g.record("10.0.0.1", false, t), false);
  assert.equal(g.record("10.0.0.1", false, t), true, "the fifth invalid share of five bans");
  assert.equal(bans.length, 1);
  assert.equal(bans[0].ip, "10.0.0.1");
  assert.equal(g.connect("10.0.0.1", t + 1000), "banned");
  assert.equal(g.connect("10.0.0.2", t + 1000), null, "others are unaffected");
  assert.equal(g.connect("10.0.0.1", t + 16 * 60_000), null, "the ban expires");
});

test("bans need a high enough share of invalid submissions, and the window resets", () => {
  const g = new IpGuard(config);
  const t = 0;
  for (let i = 0; i < 30; i++) g.record("10.0.0.1", true, t);
  for (let i = 0; i < 10; i++) assert.equal(g.record("10.0.0.1", false, t), false, "10 invalid of 40 is under half");
  const h = new IpGuard(config);
  for (let i = 0; i < 4; i++) h.record("10.0.0.2", false, 0);
  assert.equal(h.record("10.0.0.2", false, 61_000), false, "a new window starts counting again");
  const e = new IpGuard({ ...config, exemptIps: ["10.0.0.3"] });
  for (let i = 0; i < 50; i++) assert.equal(e.record("10.0.0.3", false, 0), false);
});

test("saved bans are loaded, and pruning keeps the maps small", () => {
  const g = new IpGuard(config);
  g.loadBans([{ ip: "::ffff:10.0.0.7", until: new Date(5_000) }]);
  assert.ok(g.isBanned("10.0.0.7", 1000));
  assert.ok(!g.isBanned("10.0.0.7", 6000));
  g.record("10.0.0.8", false, 0);
  g.prune(1_000_000);
  assert.equal(g.windows.size, 0);
});
