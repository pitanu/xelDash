import test from "node:test";
import assert from "node:assert/strict";
import { ConnectionPlaces, EVICT_AFTER_QUIET_MS, connectionToEvict, idleConnections } from "../src/idle-connections.js";
import { DEFAULT_IP_GUARD, IpGuard } from "../src/ip-guard.js";

const NOW = 10_000_000;
const MIN = 60_000;
/** A session's activity: opened `ago` ms before NOW, last share `shareAgo` ms before (null: none), accepted share or not. */
const conn = (/** @type {{ ago: number, shareAgo?: number | null, accepted?: boolean, ip?: string }} */ { ago, shareAgo = null, accepted = false, ip = "203.0.113.1" }) => ({
  openedAt: NOW - ago, lastShareAt: shareAgo === null ? null : NOW - shareAgo, hadAcceptedShare: accepted, ip,
});

test("idle connections: past the limit since the last share, or half of it when none was ever sent", () => {
  const sessions = new Map([
    ["mining", conn({ ago: 60 * MIN, shareAgo: 5_000, accepted: true })],
    ["slow", conn({ ago: 60 * MIN, shareAgo: 29 * MIN, accepted: true })],
    ["stopped", conn({ ago: 60 * MIN, shareAgo: 31 * MIN, accepted: true })],
    ["new", conn({ ago: 14 * MIN })],
    ["silent", conn({ ago: 16 * MIN })],
  ]);
  assert.deepEqual(idleConnections(sessions, 30 * MIN, NOW), ["stopped", "silent"]);
  assert.deepEqual(idleConnections(sessions, 0, NOW), [], "0 closes nothing");
});

test("making room closes the longest-quiet connection that never had a share accepted, never one that mines", () => {
  const sessions = new Map([
    ["miner", conn({ ago: 60 * MIN, shareAgo: 50 * MIN, accepted: true })],
    ["idle-old", conn({ ago: 40 * MIN })],
    ["idle-newer", conn({ ago: 10 * MIN })],
    ["bad-shares", conn({ ago: 30 * MIN, shareAgo: 20 * MIN })],
  ]);
  assert.equal(connectionToEvict(sessions, { now: NOW }), "idle-old");
  sessions.delete("idle-old");
  assert.equal(connectionToEvict(sessions, { now: NOW }), "bad-shares", "quiet since its last (refused) share");
});

test("a rig still finding its first share is not pushed out: only connections quiet for a while are", () => {
  const sessions = new Map([
    ["starting", conn({ ago: EVICT_AFTER_QUIET_MS - 1_000 })],
    ["just-shared", conn({ ago: 30 * MIN, shareAgo: 10_000 })],
  ]);
  assert.equal(connectionToEvict(sessions, { now: NOW }), null, "nothing qualifies: the newcomer is refused as before");
  assert.equal(connectionToEvict(new Map([["a", conn({ ago: EVICT_AFTER_QUIET_MS })]]), { now: NOW }), "a");
});

test("for an address's own limit, only that address's connections are closed", () => {
  const sessions = new Map([
    ["other", conn({ ago: 50 * MIN, ip: "198.51.100.7" })],
    ["own", conn({ ago: 10 * MIN, ip: "203.0.113.1" })],
  ]);
  assert.equal(connectionToEvict(sessions, { ip: "203.0.113.1", now: NOW }), "own");
  assert.equal(connectionToEvict(sessions, { ip: "192.0.2.9", now: NOW }), null);
  assert.equal(connectionToEvict(sessions, { now: NOW }), "other", "the total limit looks at everyone");
});

test("a full server makes room from a connection that has not mined, and counts every place exactly once", () => {
  const guard = new IpGuard({ ...DEFAULT_IP_GUARD, allowedNetworks: "any", maxConnectionsPerIp: 3, maxConnections: 3 });
  /** @type {Map<any, ReturnType<typeof conn>>} */
  const sessions = new Map();
  /** @type {string[][]} */
  const evicted = [];
  const places = new ConnectionPlaces(guard, sessions, { onEvict: (ip, forIp, reason) => evicted.push([ip, forIp, reason]) });
  /** A connection: admitted, then its session registered, as the server does. @param {string} ip @param {Parameters<typeof conn>[0]} activity */
  const open = (ip, activity) => {
    const refused = places.admit(ip, NOW);
    if (refused) return refused;
    const socket = { closed: false, destroy() { this.closed = true; } };
    sessions.set(socket, conn({ ...activity, ip }));
    return socket;
  };
  /** A socket closing, as its close event does. @param {any} socket */
  const close = (socket) => { places.release(socket, sessions.get(socket).ip); sessions.delete(socket); };

  const miner = /** @type {any} */ (open("198.51.100.1", { ago: 60 * MIN, shareAgo: 5_000, accepted: true }));
  const idle = /** @type {any} */ (open("203.0.113.1", { ago: 30 * MIN }));
  const starting = /** @type {any} */ (open("203.0.113.2", { ago: 30_000 }));
  assert.equal(guard.total, 3);

  assert.equal(typeof open("192.0.2.5", { ago: 0 }), "object", "the newcomer is admitted");
  assert.deepEqual(evicted, [["203.0.113.1", "192.0.2.5", "server full"]]);
  assert.equal(idle.closed, true);
  assert.equal(miner.closed, false, "the miner stays");
  assert.equal(starting.closed, false, "the rig still finding its first share stays");
  assert.equal(guard.total, 3);

  close(idle);
  assert.equal(guard.total, 3, "the closed-to-make-room connection's close does not give its place back twice");
  assert.equal(open("192.0.2.6", { ago: 0 }), "server full", "nobody left to make room from: refused as before");
  close(starting);
  assert.equal(guard.total, 2);
  assert.equal(typeof open("192.0.2.6", { ago: 0 }), "object");
});

test("an address at its own limit makes room only from its own idle connections", () => {
  const guard = new IpGuard({ ...DEFAULT_IP_GUARD, allowedNetworks: "any", maxConnectionsPerIp: 2, maxConnections: 0 });
  const sessions = new Map();
  const places = new ConnectionPlaces(guard, sessions);
  const add = (/** @type {string} */ ip, /** @type {number} */ ago) => {
    assert.equal(places.admit(ip, NOW), null);
    const socket = { destroy() {} };
    sessions.set(socket, conn({ ago, ip }));
  };
  add("203.0.113.1", 30 * MIN);
  add("203.0.113.1", 20 * MIN);
  add("198.51.100.7", 50 * MIN);
  assert.equal(places.admit("203.0.113.1", NOW), null, "its own idle connection made room");
  assert.equal(guard.connections.get("203.0.113.1"), 2);
  assert.equal(guard.connections.get("198.51.100.7"), 1, "another address's connection was not touched");
});
