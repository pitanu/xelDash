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
  assert.deepEqual(ipGuardConfigFromEnv({}), { ...DEFAULT_IP_GUARD, exemptIps: [], allowedNetworks: "private",
    explicit: { maxConnectionsPerIp: false, maxConnections: false, sharesPerIpPerSecond: false, connectionsPerIpPerSecond: false, unprovenChecksPerMinute: false } });
  const c = ipGuardConfigFromEnv({ STRATUM_MAX_CONNECTIONS_PER_IP: "3", STRATUM_BAN_EXEMPT_IPS: "10.0.0.1, ::ffff:10.0.0.2", XELDASH_ALLOWED_NETWORKS: "private,tailscale" });
  assert.equal(c.maxConnectionsPerIp, 3);
  assert.deepEqual(c.explicit, { maxConnectionsPerIp: true, maxConnections: false, sharesPerIpPerSecond: false, connectionsPerIpPerSecond: false, unprovenChecksPerMinute: false }, "an empty or missing setting is not explicit");
  assert.equal(ipGuardConfigFromEnv({ STRATUM_SHARES_PER_IP_PER_SECOND: "500" }).sharesPerIpPerSecond, 500);
  assert.throws(() => ipGuardConfigFromEnv({ STRATUM_SHARES_PER_IP_PER_SECOND: "-1" }), /STRATUM_SHARES_PER_IP_PER_SECOND/);
  assert.equal(ipGuardConfigFromEnv({ STRATUM_MAX_CONNECTIONS_PER_IP: "" }).explicit?.maxConnectionsPerIp, false);
  assert.equal(ipGuardConfigFromEnv({ STRATUM_MAX_CONNECTIONS: "5000" }).maxConnections, 5000);
  assert.throws(() => ipGuardConfigFromEnv({ STRATUM_MAX_CONNECTIONS: "-1" }), /STRATUM_MAX_CONNECTIONS/);
  assert.deepEqual(c.exemptIps, ["10.0.0.1", "10.0.0.2"]);
  assert.equal(c.allowedNetworks, "private,tailscale");
  assert.throws(() => ipGuardConfigFromEnv({ STRATUM_MESSAGES_PER_SECOND: "0" }), /positive number/);
  assert.throws(() => ipGuardConfigFromEnv({ STRATUM_BAN_INVALID_RATIO: "1.5" }), /between 0 and 1/);
});

test("shares checked per IP address: two seconds' worth at once, then the rate; exempt addresses and 0 have no limit", () => {
  const guard = new IpGuard({ ...DEFAULT_IP_GUARD, sharesPerIpPerSecond: 10, exemptIps: ["10.0.0.9"] });
  for (let i = 0; i < 20; i++) assert.ok(guard.allowShare("10.0.0.1", 0), `share ${i}`);
  assert.ok(!guard.allowShare("10.0.0.1", 0), "over the burst");
  assert.ok(guard.allowShare("10.0.0.2", 0), "another address has its own");
  assert.ok(guard.allowShare("10.0.0.1", 100), "a tenth of a second refills one");
  assert.ok(!guard.allowShare("10.0.0.1", 100));
  for (let i = 0; i < 100; i++) assert.ok(guard.allowShare("10.0.0.9", 0), "exempt");
  const off = new IpGuard({ ...DEFAULT_IP_GUARD });
  for (let i = 0; i < 1000; i++) assert.ok(off.allowShare("10.0.0.1", 0), "no limit by default");
  guard.prune(61_000);
  assert.equal(guard.shareBuckets.size, 0, "idle buckets are forgotten");
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

test("a global connection cap: all addresses together, freed again on disconnect", () => {
  const guard = new IpGuard({ ...DEFAULT_IP_GUARD, exemptIps: [], allowedNetworks: "any", maxConnectionsPerIp: 1000, maxConnections: 3 });
  assert.equal(guard.connect("203.0.113.1"), null);
  assert.equal(guard.connect("203.0.113.1"), null);
  assert.equal(guard.connect("203.0.113.2"), null);
  assert.equal(guard.connect("203.0.113.3"), "server full");
  guard.disconnect("203.0.113.1");
  assert.equal(guard.connect("203.0.113.3"), null, "room again after one left");
  guard.disconnect("203.0.113.9");
  assert.equal(guard.total, 3, "an address that was never connected does not lower the count");
});

test("raw connections are refused at accept when banned or too many from one address; closing frees the place; unsettled ones close at the deadline", async () => {
  const { createServer, connect } = await import("node:net");
  const { guardRawConnections } = await import("../src/ip-guard.js");
  const guard = new IpGuard({ ...DEFAULT_IP_GUARD, maxConnectionsPerIp: 2 });
  const server = createServer(() => {});
  const refused = [];
  const raw = guardRawConnections(server, guard, { slack: 1, deadlineMs: 800, onRefused: (ip, reason) => refused.push(reason) });
  server.on("connection", (s) => { if (raw.openFrom("127.0.0.1") <= 2) raw.settled(s); });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = /** @type {import("node:net").AddressInfo} */ (server.address()).port;
  // Resolves once connected, or at once if the server already closed it.
  const open = () => new Promise((resolve) => {
    const s = connect(port, "127.0.0.1");
    s.on("error", () => {});
    s.once("connect", () => resolve(s));
    s.once("close", () => resolve(s));
  });
  const closedSoon = (s) => new Promise((resolve) => { const t = setTimeout(() => resolve(false), 500); s.once("close", () => { clearTimeout(t); resolve(true); }); });
  const kept = [await open(), await open()];
  const unsettled = await open();
  const extra = await open();
  assert.ok(extra.destroyed || await closedSoon(extra), "one too many");
  for (const s of kept) assert.equal(await closedSoon(s), false, "within the limit plus slack");
  assert.deepEqual(refused, ["too many connections"]);
  assert.ok(unsettled.destroyed || await closedSoon(unsettled), "the one never settled is closed at its deadline");
  kept[0].destroy();
  await new Promise((r) => setTimeout(r, 100));
  const again = await open();
  assert.equal(await closedSoon(again), false, "a closed one frees its place");
  guard.ban("127.0.0.1", "test");
  const banned = await open();
  assert.ok(banned.destroyed || await closedSoon(banned), "a banned address is refused at once");
  for (const s of [...kept, again]) s.destroy();
  await new Promise((r) => server.close(r));
});

test("the TLS port charges the connection rate as a socket is accepted, before any handshake, and only once", async () => {
  const { createServer, connect } = await import("node:net");
  const { guardRawConnections } = await import("../src/ip-guard.js");
  const guard = new IpGuard({ ...DEFAULT_IP_GUARD, maxConnectionsPerIp: 3, connectionsPerIpPerSecond: 0.001 });
  const server = createServer(() => {});
  const refused = [];
  guardRawConnections(server, guard, { chargeAttempts: true, onRefused: (ip, reason) => refused.push(reason) });
  /** @type {(string | null)[]} */
  const admitted = [];
  // What the TLS server does once a handshake is done (here at once): connect, without charging the rate again.
  server.on("connection", (s) => {
    if (s.destroyed) return;
    const reason = guard.connect("127.0.0.1", Date.now(), { attempted: true });
    admitted.push(reason);
    if (!reason) s.once("close", () => guard.disconnect("127.0.0.1"));
    s.destroy();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = /** @type {import("node:net").AddressInfo} */ (server.address()).port;
  // A client reconnecting in a loop: each connection closed by the server.
  for (let i = 0; i < 6; i++) {
    await new Promise((resolve) => {
      const s = connect(port, "127.0.0.1");
      s.on("error", () => {});
      s.once("close", resolve);
    });
  }
  await new Promise((r) => server.close(r));
  assert.deepEqual(admitted, [null, null, null], "the burst (its connection limit) is let through, each charged once");
  assert.deepEqual(refused, ["connecting too often", "connecting too often", "connecting too often"], "the rest refused at accept");
  // Without chargeAttempts nothing is charged at accept: the server's connect does it, as on the plain port.
  const plain = new IpGuard({ ...DEFAULT_IP_GUARD, maxConnectionsPerIp: 1, connectionsPerIpPerSecond: 0.001 });
  assert.equal(plain.connect("10.0.0.1", 0), null);
  plain.disconnect("10.0.0.1");
  assert.equal(plain.connect("10.0.0.1", 0), "connecting too often");
  assert.equal(plain.connect("10.0.0.1", 0, { attempted: true }), null, "already charged: not again");
});

test("new connections per IP address: a burst as large as its connection limit, then the rate; exempt addresses and 0 have no limit", () => {
  const guard = new IpGuard({ ...DEFAULT_IP_GUARD, maxConnectionsPerIp: 5, connectionsPerIpPerSecond: 2, exemptIps: ["10.0.0.9"] });
  /** Connect and close at once, as a client reconnecting in a loop does. */
  const attempt = (/** @type {string} */ ip, /** @type {number} */ now) => {
    const refused = guard.connect(ip, now);
    if (!refused) guard.disconnect(ip);
    return refused;
  };
  for (let i = 0; i < 5; i++) assert.equal(attempt("10.0.0.1", 0), null, `burst ${i}`);
  assert.equal(attempt("10.0.0.1", 0), "connecting too often");
  assert.equal(attempt("10.0.0.2", 0), null, "another address has its own");
  assert.equal(attempt("10.0.0.1", 500), null, "half a second refills one at 2 a second");
  assert.equal(attempt("10.0.0.1", 500), "connecting too often");
  for (let i = 0; i < 50; i++) assert.equal(attempt("10.0.0.9", 0), null, "exempt");
  const off = new IpGuard({ ...DEFAULT_IP_GUARD });
  for (let i = 0; i < 500; i++) assert.equal(off.connect("10.0.0.1", 0) ?? off.disconnect("10.0.0.1"), undefined, "no limit by default");
  guard.prune(61_000);
  assert.equal(guard.connectBuckets.size, 0, "full buckets are forgotten");
  assert.equal(ipGuardConfigFromEnv({ STRATUM_CONNECTIONS_PER_IP_PER_SECOND: "20" }).connectionsPerIpPerSecond, 20);
  assert.equal(ipGuardConfigFromEnv({}).explicit?.connectionsPerIpPerSecond, false);
  assert.throws(() => ipGuardConfigFromEnv({ STRATUM_CONNECTIONS_PER_IP_PER_SECOND: "-1" }), /0 \(no limit\) or a positive/);
});

test("until an IP address has a share accepted, its shares are checked only a few a minute; one accepted share lifts it", () => {
  const guard = new IpGuard({ ...DEFAULT_IP_GUARD, unprovenChecksPerMinute: 6, exemptIps: ["10.0.0.9"] });
  for (let i = 0; i < 6; i++) assert.ok(guard.allowShare("10.0.0.1", 0), `check ${i}`);
  assert.ok(!guard.allowShare("10.0.0.1", 0), "over the allowance: answered without a hash");
  assert.ok(!guard.proven("10.0.0.1", 0));
  assert.ok(guard.allowShare("10.0.0.1", 10_000), "ten seconds refill one at 6 a minute");
  assert.ok(!guard.allowShare("10.0.0.1", 10_000));
  // Its connections' checked shares were all invalid: still on probation, and the invalid ones still count toward a ban.
  for (let i = 0; i < 7; i++) guard.record("10.0.0.1", false, 10_000);
  assert.ok(!guard.allowShare("10.0.0.1", 10_000));
  // A real rig: its first checked share is accepted.
  guard.record("10.0.0.2", true, 0);
  assert.ok(guard.proven("10.0.0.2", 0));
  for (let i = 0; i < 500; i++) assert.ok(guard.allowShare("10.0.0.2", 0), "proven: no probation (the per-second limit still applies when set)");
  // The proof lasts for the ban window; after it the next accepted share proves the address again.
  assert.ok(!guard.proven("10.0.0.2", DEFAULT_IP_GUARD.invalidWindowSeconds * 1000));
  for (let i = 0; i < 50; i++) assert.ok(guard.allowShare("10.0.0.9", 0), "exempt");
  const off = new IpGuard({ ...DEFAULT_IP_GUARD });
  for (let i = 0; i < 500; i++) assert.ok(off.allowShare("10.0.0.1", 0), "no limit by default");
  guard.prune(120_000);
  assert.equal(guard.unprovenBuckets.size, 0);
  assert.equal(ipGuardConfigFromEnv({ STRATUM_UNPROVEN_CHECKS_PER_MINUTE: "30" }).unprovenChecksPerMinute, 30);
  assert.throws(() => ipGuardConfigFromEnv({ STRATUM_UNPROVEN_CHECKS_PER_MINUTE: "x" }), /0 \(no limit\) or a positive/);
});
