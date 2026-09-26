// Devnet verification miner. Mines through the xelDash Stratum server with the native
// hash addon. For each accepted share that also meets the network target, the block must
// exist in the daemon under the BLAKE3 MinerWork hash we compute. Devnet only; this is not a production miner.
//
//   docker compose run --rm -v ./services/stratum/scripts:/app/services/stratum/scripts \
//     stratum node services/stratum/scripts/devnet-miner.js <address> [blocks]
import { readFileSync } from "node:fs";
import { connect } from "node:net";
import { connect as connectTls } from "node:tls";
import { blake3 } from "@noble/hashes/blake3.js";
import { hashMinerWork } from "@xeldash/xelis-hash";

const address = process.argv[2];
const wantedBlocks = Number.parseInt(process.argv[3] ?? "3", 10);
const stratumHost = process.env.MINER_STRATUM_HOST ?? "stratum";
const useTls = process.env.MINER_TLS === "1";
const stratumPort = Number.parseInt(process.env.MINER_STRATUM_PORT ?? (useTls ? "3334" : "3333"), 10);
const rpcUrl = process.env.XELIS_RPC_URL ?? "http://daemon:8080/json_rpc";
const MAX_U256 = (1n << 256n) - 1n;
const WORKER = "devnet-verify";

if (!address) {
  console.error("Usage: devnet-miner.js <address> [blocks]");
  process.exit(2);
}

/** @param {string} method @param {Record<string, unknown> | undefined} params */
async function rpc(method, params) {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, ...(params ? { params } : {}) }),
  });
  const body = await response.json();
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}

// MINER_TLS=1 uses the TLS port. MINER_TLS_CA verifies the server against that CA file;
// without it the certificate is not verified (fine for a devnet check, not for real use).
const socket = useTls
  ? connectTls({
    host: stratumHost,
    port: stratumPort,
    servername: process.env.MINER_TLS_SERVERNAME ?? stratumHost,
    ...(process.env.MINER_TLS_CA ? { ca: readFileSync(process.env.MINER_TLS_CA) } : { rejectUnauthorized: false }),
  })
  : connect(stratumPort, stratumHost);
let nextId = 1;
/** @type {Map<number, (message: any) => void>} */
const pending = new Map();
/** @type {{ jobId: string, timestamp: Buffer, header: Buffer } | null} */
let job = null;
let extraNonce = Buffer.alloc(32);
let publicKey = Buffer.alloc(32);
let target = 0n;
let nonce = BigInt(Math.floor(Math.random() * 2 ** 32)) << 32n;
let hashes = 0;
let shares = 0;
let found = 0;
let failures = 0;
const started = Date.now();

/** @param {string} method @param {unknown[]} params @returns {Promise<any>} */
function request(method, params) {
  const id = nextId++;
  socket.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  return new Promise((resolve) => pending.set(id, resolve));
}

let buffered = "";
socket.setEncoding("utf8");
socket.on("data", (chunk) => {
  buffered += chunk;
  let newline;
  while ((newline = buffered.indexOf("\n")) >= 0) {
    const line = buffered.slice(0, newline);
    buffered = buffered.slice(newline + 1);
    if (line) handle(JSON.parse(line));
  }
});
socket.on("error", (error) => {
  console.error("Stratum connection failed:", error.message);
  process.exit(1);
});
socket.on("close", () => {
  console.error("Stratum server closed the connection (node paused, banned, or over a limit)");
  process.exit(1);
});

/** @param {any} message */
function handle(message) {
  if (message.id !== null && pending.has(message.id)) {
    pending.get(message.id)?.(message);
    pending.delete(message.id);
    return;
  }
  switch (message.method) {
    case "mining.set_extranonce":
      extraNonce = Buffer.from(message.params[0], "hex");
      publicKey = Buffer.from(message.params[2], "hex");
      break;
    case "mining.set_difficulty":
      target = MAX_U256 / BigInt(message.params[0]);
      console.info(`difficulty ${message.params[0]}`);
      break;
    case "mining.notify": {
      const [jobId, timestampHex, headerHash, algorithm, clean] = message.params;
      const timestamp = Buffer.alloc(8);
      timestamp.writeBigUInt64BE(BigInt(`0x${timestampHex}`));
      job = { jobId, timestamp, header: Buffer.from(headerHash, "hex") };
      console.info(`job ${jobId.slice(0, 8)} ${algorithm} clean=${clean}`);
      break;
    }
    case "mining.ping":
      socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, method: "mining.pong", params: [] })}\n`);
      break;
    default:
      break;
  }
}

/** @param {{ jobId: string, timestamp: Buffer, header: Buffer }} work @param {bigint} value */
function minerWork(work, value) {
  const bytes = Buffer.alloc(112);
  work.header.copy(bytes, 0);
  work.timestamp.copy(bytes, 32);
  bytes.writeBigUInt64BE(value, 40);
  extraNonce.copy(bytes, 48);
  publicKey.copy(bytes, 80);
  return bytes;
}

/** @param {{ jobId: string }} work @param {Buffer} bytes @param {bigint} value @param {bigint} hash */
async function submit(work, bytes, value, hash) {
  const nonceHex = value.toString(16).padStart(16, "0");
  const blockHash = Buffer.from(blake3(bytes)).toString("hex");
  const reply = await request("mining.submit", [WORKER, work.jobId, nonceHex]);
  if (reply.error) {
    console.warn(`share rejected: ${reply.error.message}`);
    return;
  }
  shares += 1;
  const { difficulty } = await rpc("get_info", undefined);
  if (hash > MAX_U256 / BigInt(difficulty)) return;
  // Give the daemon a moment to process the block the Stratum server just submitted.
  await new Promise((resolve) => setTimeout(resolve, 500));
  try {
    const block = await rpc("get_block_by_hash", { hash: blockHash });
    found += 1;
    console.info(`OK block ${blockHash} height ${block.height} miner ${block.miner}`);
  } catch (error) {
    failures += 1;
    console.warn(`share accepted but no block ${blockHash}: ${error instanceof Error ? error.message : error}`);
  }
}

async function mine() {
  while (found + failures < wantedBlocks) {
    if (!job || target === 0n) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      continue;
    }
    const work = job;
    for (let i = 0; i < 64 && work === job; i++) {
      nonce += 1n;
      const bytes = minerWork(work, nonce);
      hashes += 1;
      const hash = BigInt(`0x${hashMinerWork(bytes).toString("hex")}`);
      if (hash <= target) await submit(work, bytes, nonce, hash);
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
  const seconds = (Date.now() - started) / 1000;
  console.info(`done: ${shares} shares, ${found} blocks verified, ${failures} failed, ${hashes} hashes in ${seconds.toFixed(0)}s (${(hashes / seconds).toFixed(0)} H/s)`);
  socket.removeAllListeners("close");
  socket.end();
  process.exit(failures === 0 ? 0 : 1);
}

socket.once(useTls ? "secureConnect" : "connect", async () => {
  const subscribed = await request("mining.subscribe", ["xeldash-devnet-miner", ["xel/v3"]]);
  if (subscribed.error) throw new Error(subscribed.error.message);
  const authorized = await request("mining.authorize", [address, WORKER, ""]);
  if (authorized.error || authorized.result !== true) {
    console.error("authorize failed:", authorized.error?.message ?? authorized.result);
    process.exit(1);
  }
  await mine();
});
