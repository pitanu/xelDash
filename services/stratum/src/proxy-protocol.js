import { BlockList, isIP } from "node:net";
import { PRIVATE_NETWORKS, normalizeIp } from "./ip-guard.js";

// PROXY protocol, version 1: when miners reach Stratum through a forwarder (the front door of a cluster, see
// docker/frontdoor), every connection arrives from the forwarder's address, which would make all rigs look like one
// client to the per-address limits and bans. The forwarder starts each connection with a line naming the real client,
//
//   PROXY TCP4 192.168.1.37 192.168.1.20 51234 3333\r\n
//
// and this module reads it. The line is believed ONLY from addresses listed in STRATUM_PROXY_FROM: from anyone else a
// claim about who the client "really" is would let it dodge bans and limits, so such a connection is taken as it is
// (and a line like that is simply not valid Stratum).

const MAX_HEADER_BYTES = 107; // the longest line the protocol allows
const HEADER_TIMEOUT_MS = 3_000;

/**
 * Parse one PROXY line (without the line end). `null` when it is not a valid one; `{ ip: null }` for UNKNOWN (a health check
 * from the forwarder itself), which keeps the forwarder's own address.
 * @param {string} line @returns {{ ip: string | null } | null}
 */
export function parseProxyLine(line) {
  const parts = line.split(" ");
  if (parts[0] !== "PROXY") return null;
  if (parts[1] === "UNKNOWN") return { ip: null };
  if (parts.length !== 6 || (parts[1] !== "TCP4" && parts[1] !== "TCP6")) return null;
  const family = parts[1] === "TCP4" ? 4 : 6;
  if (isIP(parts[2]) !== family || isIP(parts[3]) !== family) return null;
  for (const port of [parts[4], parts[5]]) if (!/^\d{1,5}$/.test(port) || Number(port) > 65_535) return null;
  return { ip: normalizeIp(parts[2]) };
}

/**
 * Who may send a PROXY line, from STRATUM_PROXY_FROM: exact addresses, networks like 192.168.1.0/24, `private`, and `gateway`
 * (the Docker network's gateway address: Docker Desktop shows every client from outside the machine as that, so a forwarder
 * cannot be told from any other computer there, and trusting it is the only way to recover real addresses). `any` is refused.
 * Returns null when nothing is listed (PROXY protocol off).
 * @param {string | undefined} text @param {{ gateway?: string | null }} [options]
 * @returns {{ trusts: (ip: string) => boolean, text: string } | null}
 */
export function proxyTrustFromEnv(text, { gateway = null } = {}) {
  const tokens = (text ?? "").split(",").map((t) => t.trim().toLowerCase()).filter(Boolean);
  if (tokens.length === 0) return null;
  const list = new BlockList();
  for (const token of tokens) {
    if (token === "any" || token === "*" || token === "0.0.0.0/0" || token === "::/0") {
      throw new Error("STRATUM_PROXY_FROM: list the forwarder's address; \"any\" would let every computer claim to be someone else");
    }
    /** @type {string[]} */
    let entries;
    if (token === "private") entries = [...PRIVATE_NETWORKS];
    else if (token === "gateway") {
      if (!gateway) continue; // not running behind Docker's gateway: nothing to add
      entries = [gateway];
    } else entries = [token];
    for (const entry of entries) {
      const [address, prefix] = entry.split("/");
      const family = isIP(address);
      if (family === 0) throw new Error(`STRATUM_PROXY_FROM: "${token}" is not an address, a network like 192.168.1.0/24, private or gateway`);
      const max = family === 4 ? 32 : 128;
      const bits = prefix === undefined ? max : Number(prefix);
      if (!Number.isInteger(bits) || bits < 0 || bits > max) throw new Error(`STRATUM_PROXY_FROM: bad network size in "${entry}"`);
      if (bits === 0) throw new Error("STRATUM_PROXY_FROM: a network of every address is not allowed");
      list.addSubnet(address, bits, family === 4 ? "ipv4" : "ipv6");
    }
  }
  return {
    text: tokens.join(","),
    trusts: (ip) => {
      const family = isIP(ip);
      return family !== 0 && list.check(ip, family === 4 ? "ipv4" : "ipv6");
    },
  };
}

/**
 * Take a new connection. From a listed forwarder, read its PROXY line first, make `socket.remoteAddress` the real client, put
 * back any bytes that followed the line, and hand the socket on; a forwarder that does not send one is a misconfiguration and
 * is closed. From anyone else, hand the socket on untouched.
 * @param {import("node:net").Socket} socket @param {{ trusts: (ip: string) => boolean }} trust
 * @param {(socket: import("node:net").Socket) => void} onReady
 * @param {{ timeoutMs?: number, logger?: Pick<Console, "warn"> }} [options]
 */
export function acceptWithProxyHeader(socket, trust, onReady, { timeoutMs = HEADER_TIMEOUT_MS, logger = console } = {}) {
  const peer = normalizeIp(socket.remoteAddress);
  if (!trust.trusts(peer)) {
    onReady(socket);
    return;
  }
  let received = Buffer.alloc(0);
  const timer = setTimeout(() => fail("did not send a PROXY line in time"), timeoutMs);
  timer.unref();

  /** @param {string} why */
  function fail(why) {
    cleanup();
    logger.warn?.(`Closing a connection from ${peer}: it is a listed forwarder (STRATUM_PROXY_FROM) but ${why}`);
    socket.destroy();
  }
  function cleanup() {
    clearTimeout(timer);
    socket.removeListener("data", onData);
    socket.removeListener("close", onClose);
    socket.removeListener("error", onClose);
  }
  function onClose() {
    cleanup();
  }
  /** @param {Buffer} chunk */
  function onData(chunk) {
    received = Buffer.concat([received, chunk]);
    const start = received.subarray(0, 6).toString("latin1");
    if (!"PROXY ".startsWith(start) && !start.startsWith("PROXY ")) {
      fail("sent something that is not a PROXY line");
      return;
    }
    const end = received.indexOf("\r\n");
    if (end === -1) {
      if (received.length > MAX_HEADER_BYTES) fail("sent something that is not a PROXY line");
      return;
    }
    if (end > MAX_HEADER_BYTES) {
      fail("sent a PROXY line that is too long");
      return;
    }
    const parsed = parseProxyLine(received.subarray(0, end).toString("latin1"));
    if (!parsed) {
      fail("sent something that is not a PROXY line");
      return;
    }
    cleanup();
    socket.pause();
    const rest = received.subarray(end + 2);
    if (rest.length > 0) socket.unshift(rest);
    if (parsed.ip) Object.defineProperty(socket, "remoteAddress", { value: parsed.ip, configurable: true });
    onReady(socket);
    // The handlers are attached by now; let the data flow.
    setImmediate(() => socket.resume());
  }
  socket.on("data", onData);
  socket.resume(); // the listener alone does not start a socket that was accepted paused
  socket.once("close", onClose);
  socket.once("error", onClose);
}
