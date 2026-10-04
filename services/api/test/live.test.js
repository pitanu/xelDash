import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import net from "node:net";
import { startLiveUpdates } from "../src/live.js";

const quiet = { info() {}, warn() {} };

/** The live-update endpoint on a real HTTP server, with a database that cannot be reached (the endpoint then just retries). */
async function start() {
  const server = createServer((request, response) => response.writeHead(404).end());
  const live = startLiveUpdates({ server, pool: { connect: async () => { throw new Error("no database"); } }, logger: quiet });
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
    const lines = [`GET ${path} HTTP/1.1`, "Host: 127.0.0.1", "Connection: Upgrade", "Upgrade: websocket", "Sec-WebSocket-Version: 13", "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
      ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`), "", ""];
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
      await new Promise((resolve) => {
        const socket = net.connect(s.port, "127.0.0.1");
        socket.on("error", () => {});
        socket.on("connect", () => {
          socket.write("GET /api/v1/live HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nOrigin: https://evil.example\r\n\r\n");
          socket.resetAndDestroy();
          resolve();
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
