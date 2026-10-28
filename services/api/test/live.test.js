import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import net from "node:net";
import { startLiveUpdates } from "../src/live.js";
import { hostAllowed, hostRulesFromEnv } from "../src/allowed-hosts.js";

const quiet = { info() {}, warn() {} };

/** The live-update endpoint on a real HTTP server, with a database that cannot be reached (the endpoint then just retries). */
async function start(options = {}) {
  const server = createServer((request, response) => response.writeHead(404).end());
  const live = startLiveUpdates({ server, pool: { connect: async () => { throw new Error("no database"); } }, logger: quiet, ...options });
  server.unref();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { port: server.address().port, close: async () => { await live.stop(); server.close(); } };
}

/** The status line the endpoint answers to a hand-made upgrade request. */
function upgradeStatus(port, path, headers = {}) {
  return new Promise((resolve) => {
    const socket = net.connect(port, "127.0.0.1");
    let text = "";
    const done = () => { socket.destroy(); resolve(/^HTTP\/1\.1 (\d+)/.exec(text)?.[1] ?? "none"); };
    socket.on("data", (d) => { text += d; if (text.includes("\r\n")) done(); });
    socket.on("error", () => {});
    socket.on("close", done);
    // The test's own Host replaces the default (Node keeps the first of two).
    const all = { Host: "127.0.0.1", ...headers };
    const lines = [`GET ${path} HTTP/1.1`, "Connection: Upgrade", "Upgrade: websocket", "Sec-WebSocket-Version: 13", "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
      ...Object.entries(all).map(([k, v]) => `${k}: ${v}`), "", ""];
    socket.write(lines.join("\r\n"));
    setTimeout(done, 2000);
  });
}

test("the live feed refuses other paths and other websites' browsers", async () => {
  const s = await start();
  assert.equal(await upgradeStatus(s.port, "/somewhere/else"), "404");
  assert.equal(await upgradeStatus(s.port, "/api/v1/live", { Origin: "https://evil.example" }), "403");
  assert.equal(await upgradeStatus(s.port, "/api/v1/live", { Origin: "http://127.0.0.1:8088", Host: "127.0.0.1:8088" }) !== "403", true, "its own origin is let in");
  await s.close();
});

test("a client that resets the connection while it is being refused cannot stop the API", async () => {
  const s = await start();
  const errors = [];
  const onUncaught = (e) => errors.push(e);
  process.on("uncaughtException", onUncaught);
  try {
    for (let i = 0; i < 40; i++) {
      // Settles however the attempt ends (connected, refused, closed, or 2 s gone by), so one lost connection cannot hang the test.
      await new Promise((resolve) => {
        const socket = net.connect(s.port, "127.0.0.1");
        const timer = setTimeout(() => { socket.destroy(); resolve(); }, 2_000);
        const done = () => { clearTimeout(timer); resolve(); };
        socket.on("error", done);
        socket.on("close", done);
        socket.on("connect", () => {
          socket.write("GET /api/v1/live HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nOrigin: https://evil.example\r\n\r\n");
          socket.resetAndDestroy();
          done();
        });
      });
    }
    await new Promise((r) => setTimeout(r, 400));
  } finally {
    process.off("uncaughtException", onUncaught);
  }
  assert.deepEqual(errors.map((e) => e.message), []);
  assert.equal(await upgradeStatus(s.port, "/api/v1/live", { Origin: "https://evil.example" }), "403");
  await s.close();
});

test("a public viewer gets only block news; the operator gets every event", async () => {
  const { EventEmitter } = await import("node:events");
  const { WebSocket } = await import("ws");
  const listener = Object.assign(new EventEmitter(), { query: async () => {}, release: () => {} });
  const server = createServer((request, response) => response.writeHead(404).end());
  const live = startLiveUpdates({ server, pool: /** @type {any} */ ({ connect: async () => listener }), logger: quiet,
    isPublic: (request) => request.headers["x-xeldash-view"] !== "admin" });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = /** @type {import("node:net").AddressInfo} */ (server.address()).port;
  /** @param {Record<string, string>} headers */
  const viewer = (headers) => new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/v1/live`, { headers });
    const got = [];
    ws.on("message", (data) => got.push(JSON.parse(String(data)).eventType ?? JSON.parse(String(data)).type));
    ws.on("open", () => resolve({ ws, got }));
  });
  const visitor = await viewer({});
  const operator = await viewer({ "X-Xeldash-View": "admin" });
  for (const payload of [{ type: "event", id: "1", eventType: "ip_banned" }, { type: "event", id: "2", eventType: "block_submitted" },
    { type: "block", height: 5, hash: "ab" }, { type: "event", id: "3", eventType: "backup_done" }]) {
    listener.emit("notification", { channel: "xeldash_live", payload: JSON.stringify(payload) });
  }
  await new Promise((r) => setTimeout(r, 200));
  assert.deepEqual(visitor.got, ["hello", "block_submitted", "block"]);
  assert.deepEqual(operator.got, ["hello", "ip_banned", "block_submitted", "block", "backup_done"]);
  visitor.ws.close();
  operator.ws.close();
  await live.stop();
  server.close();
});

test("a page from another website pointed at this address (DNS rebinding) is refused, though its origin matches its Host", async () => {
  const rules = hostRulesFromEnv({});
  const s = await start({ allowHost: (/** @type {import("node:http").IncomingMessage} */ request) => hostAllowed(request.headers.host, rules) });
  // The rebinding page: Origin and Host are both the other website's, so the same-origin check alone lets it in.
  assert.equal(await upgradeStatus(s.port, "/api/v1/live", { Host: "evil.example:8088", Origin: "http://evil.example:8088" }), "421");
  assert.notEqual(await upgradeStatus(s.port, "/api/v1/live", { Host: "192.168.1.20:8088", Origin: "http://192.168.1.20:8088" }), "421");
  await s.close();
});
