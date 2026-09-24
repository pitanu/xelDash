import { DaemonRpc } from "./rpc.js";

const address = process.env.XELIS_DEFAULT_ADDRESS;
if (!address) {
  throw new Error("Set XELIS_DEFAULT_ADDRESS to a valid address for the configured network.");
}

const endpoint = process.env.XELIS_RPC_URL ?? "http://127.0.0.1:8080/json_rpc";
const rpc = new DaemonRpc(endpoint);
const [height, difficulty, template] = await Promise.all([
  rpc.call<number>("get_height"),
  rpc.call<{ difficulty: string; hashrate?: string }>("get_difficulty"),
  rpc.getBlockTemplate(address),
]);

console.log(JSON.stringify({
  nodeHeight: height,
  networkDifficulty: difficulty.difficulty,
  networkHashrate: difficulty.hashrate,
  ...template,
}, null, 2));
