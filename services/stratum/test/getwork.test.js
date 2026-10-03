import test from "node:test";
import assert from "node:assert/strict";
import { createServer as createNetServer } from "node:net";
import { WebSocket } from "ws";
import { parseGetworkPath, startGetworkServer } from "../src/getwork.js";
import { DEFAULT_IP_GUARD, IpGuard } from "../src/ip-guard.js";
import { proxyTrustFromEnv } from "../src/proxy-protocol.js";
import { StratumSession } from "../src/session.js";

const ADDRESS = `xet:${"a".repeat(40)}`;
const quiet = { info() {}, warn() {} };

test("the getwork path is /getwork/<address>/<worker>, and nothing else is accepted", () => {
  assert.deepEqual(parseGetworkPath(`/getwork/${ADDRESS}/rig1`), { address: ADDRESS, worker: "rig1" });
  assert.deepEqual(parseGetworkPath(`/getwork/${ADDRESS}/my%20rig`), { address: ADDRESS, worker: "my rig" });
  for (const bad of [undefined, "/", "/getwork", `/getwork/${ADDRESS}`, `/getwork/${ADDRESS}/a/b`, `/other/${ADDRESS}/rig`, `/getwork//rig`,
    `/getwork/${ADDRESS}/${"w".repeat(33)}`, `/getwork/${ADDRESS}/bad%0Aname`, `/getwork/${ADDRESS}/%E0%A4%A`, `/getwork/${ADDRESS}/%1b%5b31m`]) {
    assert.equal(parseGetworkPath(bad), null, String(bad));
  }
  assert.ok(parseGetworkPath(`/getwork/${ADDRESS}/${"w".repeat(32)}`), "32 characters is allowed");
});

/** A getwork server with a real session behind it, on a random port. */
async function start({ allowed = "private", proxyTrust = null, shareResult = { accepted: true } } = {}) {
  const sessions = new Map();
  const seen = { ips: [], submissions: [], refused: [] };
  const ipGuard = new IpGuard({ ...DEFAULT_IP_GUARD, allowedNetworks: allowed });
  const job = {
    jobId: "job1", template: "t", timestampHex: "0000000000000064", headerWorkHash: "11".repeat(32), algorithm: "xel/v3", networkDifficulty: "1000000",
    height: 5, topoheight: 5, nodeId: 0, shareDifficulty: 1000, extraNonce: Buffer.alloc(32, 1), publicKey: Buffer.alloc(32, 0xab),
    buildMinerWork: () => Buffer.alloc(112, 2),
  };
  const createSession = (socket, ip) => {
    seen.ips.push(ip);
    return new StratumSession({
      socket,
      authorizeAddress: async ({ address }) => ({ minerId: 1n, workerId: 1n, address, publicKey: "ab".repeat(32) }),
      createJob: async () => ({ ...job }),
      submitShare: async (input) => { seen.submissions.push(input); return shareResult; },
      logger: quiet,
    });
  };
  // Port 0 is not reported back by the helper, so pick a free one first.
  const probe = createNetServer();
  await new Promise((r) => probe.listen(0, "127.0.0.1", r));
  const port = probe.address().port;
  await new Promise((r) => probe.close(r));
  const getwork = startGetworkServer({
    host: "127.0.0.1", port, ipGuard, rateLimit: DEFAULT_IP_GUARD, sessions, createSession, proxyTrust,
    onRefused: (ip, reason) => seen.refused.push([ip, reason]), logger: quiet,
  });
  await new Promise((r) => setTimeout(r, 100));
  return { port, seen, close: () => getwork.close() };
}

/** Connect and resolve with the messages received until `count` have arrived. */
function connect(port, path, { headers, count = 1 } = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers });
    const messages = [];
    ws.on("message", (data) => { messages.push(JSON.parse(String(data))); if (messages.length >= count) resolve({ ws, messages }); });
    ws.on("unexpected-response", (_, response) => resolve({ status: response.statusCode }));
    ws.on("error", reject);
    setTimeout(() => resolve({ ws, messages, timedOut: true }), 2000);
  });
}

test("a getwork miner is logged in and sent its work as a new_job", async () => {
  const s = await start();
  const { ws, messages } = await connect(s.port, `/getwork/${ADDRESS}/rig1`);
  assert.equal(messages[0].new_job.algorithm, "xel/v3");
  assert.equal(messages[0].new_job.miner_work.length, 224, "112 bytes of work, in hex");
  assert.equal(messages[0].new_job.difficulty, "1000");
  assert.equal(messages[0].new_job.height, 5);
  ws.close();
  await s.close();
});

test("a submitted block is answered with block_accepted or the reason it was refused", async () => {
  for (const [block, expected] of [[{ hash: "ab", accepted: true, error: null }, "block_accepted"], [{ hash: "ab", accepted: false, error: "too old" }, { block_rejected: "too old" }]]) {
    const s = await start({ shareResult: { accepted: true, block } });
    const { ws, messages } = await connect(s.port, `/getwork/${ADDRESS}/rig1`);
    const work = Buffer.alloc(112);
    Buffer.from("11".repeat(32), "hex").copy(work, 0);
    work.writeBigUInt64BE(100n, 32);
    Buffer.alloc(30, 1).copy(work, 48);
    Buffer.alloc(32, 0xab).copy(work, 80);
    const answer = new Promise((resolve) => ws.once("message", (data) => resolve(JSON.parse(String(data)))));
    ws.send(JSON.stringify({ miner_work: work.toString("hex") }));
    assert.deepEqual(await answer, expected);
    assert.equal(s.seen.submissions.length, 1);
    assert.ok(messages.length >= 1);
    ws.close();
    await s.close();
  }
});

test("bad requests are refused before a session exists: browsers and bad paths", async () => {
  const s = await start();
  assert.equal((await connect(s.port, `/getwork/${ADDRESS}/rig1`, { headers: { origin: "https://evil.example" } })).status, 403, "a browser");
  assert.equal((await connect(s.port, "/getwork/only-one-part")).status, 400);
  assert.equal(s.seen.ips.length, 0, "no session was created for any of them");
  await s.close();
});

test("an address that is not on the allowed networks is refused and reported", async () => {
  // The test client is 127.0.0.1, which is always allowed; a trusted forwarder names a public address to be refused.
  const trust = proxyTrustFromEnv("127.0.0.1");
  const front = await start({ proxyTrust: trust });
  const { default: net } = await import("node:net");
  const reply = await new Promise((resolve) => {
    const socket = net.connect(front.port, "127.0.0.1");
    let text = "";
    socket.on("data", (d) => { text += d; });
    socket.on("close", () => resolve(text));
    socket.write(`PROXY TCP4 8.8.8.8 1.1.1.1 1 2\r\nGET /getwork/${ADDRESS}/rig1 HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`);
    setTimeout(() => { socket.destroy(); resolve(text); }, 1500);
  });
  assert.match(reply, /^HTTP\/1.1 403/);
  assert.deepEqual(front.seen.refused, [["8.8.8.8", "not on your local network"]]);
  await front.close();
});

test("behind a front door the miner's own address is what the session and the limits see", async () => {
  const s = await start({ proxyTrust: proxyTrustFromEnv("127.0.0.1") });
  const { default: net } = await import("node:net");
  const got = await new Promise((resolve) => {
    const socket = net.connect(s.port, "127.0.0.1");
    let text = "";
    socket.on("data", (d) => { text += d; if (text.includes("new_job") || text.length > 200) resolve(text); });
    socket.write(`PROXY TCP4 192.168.1.37 1.1.1.1 1 2\r\nGET /getwork/${ADDRESS}/rig1 HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`);
    setTimeout(() => { socket.destroy(); resolve(text); }, 1500);
  });
  assert.match(got, /^HTTP\/1.1 101/);
  assert.deepEqual(s.seen.ips, ["192.168.1.37"]);
  await s.close();
  const direct = await start({ proxyTrust: proxyTrustFromEnv("10.9.9.9") });
  const { ws } = await connect(direct.port, `/getwork/${ADDRESS}/rig1`);
  assert.deepEqual(direct.seen.ips, ["127.0.0.1"], "an address that is not listed is taken as it is, and still works");
  ws.close();
  await direct.close();
});
