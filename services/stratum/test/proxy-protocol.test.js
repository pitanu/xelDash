import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { acceptWithProxyHeader, parseProxyLine, proxyTrustFromEnv } from "../src/proxy-protocol.js";

test("a PROXY line is parsed for IPv4, IPv6 and UNKNOWN", () => {
  assert.deepEqual(parseProxyLine("PROXY TCP4 192.168.1.37 10.0.0.1 51234 3333"), { ip: "192.168.1.37" });
  assert.deepEqual(parseProxyLine("PROXY TCP6 fe80::1 fe80::2 1 2"), { ip: "fe80::1" });
  assert.deepEqual(parseProxyLine("PROXY UNKNOWN"), { ip: null });
});

test("anything that is not a valid PROXY line is refused", () => {
  for (const bad of [
    "PROXY TCP4 nope 1.1.1.1 1 2", "PROXY TCP4 ::1 1.1.1.1 1 2", "PROXY TCP6 1.1.1.1 1.1.1.1 1 2", "PROXY TCP4 1.1.1.1 1.1.1.1 99999 2",
    "PROXY TCP4 1.1.1.1 1.1.1.1 1", "PROXY TCP4 1.1.1.1 1.1.1.1 1 2 3", "PROXY TCP4 1.1.1.1 1.1.1.1 -1 2", "PROXY UDP4 1.1.1.1 1.1.1.1 1 2",
    "GET / HTTP/1.1", '{"id":1}', "", "proxy TCP4 1.1.1.1 1.1.1.1 1 2",
  ]) assert.equal(parseProxyLine(bad), null, bad);
});

test("who may send a PROXY line: addresses, networks, private and gateway; never everyone", () => {
  assert.equal(proxyTrustFromEnv(""), null);
  assert.equal(proxyTrustFromEnv(undefined), null);
  const t = proxyTrustFromEnv("192.168.1.20, 10.0.0.0/8, gateway", { gateway: "172.18.0.1" });
  assert.ok(t);
  for (const ip of ["192.168.1.20", "10.4.5.6", "172.18.0.1"]) assert.ok(t.trusts(ip), ip);
  for (const ip of ["192.168.1.21", "8.8.8.8", "172.18.0.2", "not-an-ip"]) assert.ok(!t.trusts(ip), ip);
  assert.ok(proxyTrustFromEnv("private").trusts("192.168.5.5"));
  assert.ok(!proxyTrustFromEnv("private").trusts("8.8.8.8"));
  // "gateway" without a gateway adds nothing
  assert.ok(!proxyTrustFromEnv("192.168.1.20,gateway").trusts("172.18.0.1"));
  for (const bad of ["any", "*", "0.0.0.0/0", "::/0", "junk", "10.0.0.0/33", "10.0.0.0/x", "1.2.3.4, any", "1.2.3.4/0"]) {
    assert.throws(() => proxyTrustFromEnv(bad), /STRATUM_PROXY_FROM/, bad);
  }
});

/** A server that hands connections to acceptWithProxyHeader and records what the handler saw. */
async function listen(trustText, seen, options = {}) {
  const trust = proxyTrustFromEnv(trustText);
  const server = net.createServer({ pauseOnConnect: true }, (socket) => {
    acceptWithProxyHeader(socket, trust, (ready) => {
      ready.on("data", (data) => seen.push([ready.remoteAddress, data.toString()]));
    }, { timeoutMs: 300, logger: { warn() {} }, ...options });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server;
}

/** Send the pieces with short pauses; resolves with whether the server closed the connection. */
function send(port, pieces, waitMs = 150) {
  return new Promise((resolve) => {
    const client = net.connect(port, "127.0.0.1");
    let closed = false;
    client.on("close", () => { closed = true; });
    client.on("error", () => {});
    (async () => {
      for (const piece of pieces) {
        client.write(piece);
        await new Promise((r) => setTimeout(r, 40));
      }
      setTimeout(() => { resolve(closed); client.destroy(); }, waitMs);
    })();
  });
}

test("a listed forwarder takes the address from the line, and the bytes after it are kept", async () => {
  const seen = [];
  const server = await listen("127.0.0.1", seen);
  const { port } = /** @type {net.AddressInfo} */ (server.address());
  assert.equal(await send(port, ['PROXY TCP4 9.9.9.9 1.1.1.1 1 2\r\n{"id":1}\n']), false);
  assert.equal(await send(port, ["PROXY TCP4 9.9.9.9 1.1.1.1 1 2\r", '\n{"id":2}\n']), false); // split across packets
  assert.deepEqual(seen, [["9.9.9.9", '{"id":1}\n'], ["9.9.9.9", '{"id":2}\n']]);
  server.close();
});

test("a listed forwarder that does not send the line is closed: silent, wrong, or too long", async () => {
  const seen = [];
  const server = await listen("127.0.0.1", seen);
  const { port } = /** @type {net.AddressInfo} */ (server.address());
  assert.equal(await send(port, ['{"id":3}\n']), true);
  assert.equal(await send(port, [], 600), true);
  assert.equal(await send(port, ["PROXY TCP4 ", "x".repeat(200)]), true);
  assert.equal(await send(port, ["PROXY TCP4 999.1.1.1 1.1.1.1 1 2\r\n"]), true);
  assert.deepEqual(seen, []);
  server.close();
});

test("an address that is not listed is never believed, and its connection works as usual", async () => {
  const seen = [];
  const server = await listen("10.9.9.9", seen); // 127.0.0.1 is not listed
  const { port } = /** @type {net.AddressInfo} */ (server.address());
  assert.equal(await send(port, ["PROXY TCP4 6.6.6.6 1.1.1.1 1 2\r\nhello\n"]), false);
  assert.ok(seen.length > 0, "the data arrives (the connection is not left paused)");
  for (const [address] of seen) assert.equal(address, "127.0.0.1");
  assert.match(seen.map((s) => s[1]).join(""), /PROXY TCP4 6\.6\.6\.6/, "the claim is just data to the handler");
  server.close();
});
