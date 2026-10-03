import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { diskLevel } from "../src/disk-watch.js";
import { AddressProblem, MiningAddress } from "../src/mining-address.js";
import { compareVersions } from "../src/releases.js";
import { parseHelp, parsePeers } from "../src/settings.js";
import { tokensMatch } from "../src/snapshot.js";

const GB = 1024 ** 3;

test("disk level: ok, low under the warning size, critical under 5 GB (or the warning size if smaller)", () => {
  assert.equal(diskLevel(50 * GB, 20 * GB), "ok");
  assert.equal(diskLevel(20 * GB, 20 * GB), "ok");
  assert.equal(diskLevel(19 * GB, 20 * GB), "low");
  assert.equal(diskLevel(4 * GB, 20 * GB), "critical");
  assert.equal(diskLevel(2 * GB, 3 * GB), "critical", "the warning size can lower the critical one");
  assert.equal(diskLevel(6 * GB, 7 * GB), "low");
});

test("daemon versions are compared numerically, not as text", () => {
  assert.ok(compareVersions("1.25.0", "1.24.9") > 0);
  assert.ok(compareVersions("1.9.0", "1.10.0") < 0);
  assert.equal(compareVersions("1.25.0", "1.25.0"), 0);
});

test("secrets are compared in constant time and exactly", () => {
  assert.equal(tokensMatch("abc", "abc"), true);
  assert.equal(tokensMatch("abc", "abd"), false);
  assert.equal(tokensMatch("abc", "abcd"), false);
  assert.equal(tokensMatch("", ""), true);
});

test("peer lists are split, de-duplicated and checked", () => {
  assert.deepEqual(parsePeers("priority-nodes", "203.0.113.5:2125, 203.0.113.6:2125\n203.0.113.5:2125"), ["203.0.113.5:2125", "203.0.113.6:2125"]);
  assert.throws(() => parsePeers("priority-nodes", ""), /at least one/);
  assert.throws(() => parsePeers("priority-nodes", "203.0.113.5:99999"), /not a peer address/);
  assert.throws(() => parsePeers("priority-nodes", "no-port"), /not a peer address/);
  assert.throws(() => parsePeers("priority-nodes", Array.from({ length: 500 }, (_, i) => `10.0.${Math.floor(i / 250)}.${i % 250}:2125`).join(",")), /at most/);
});

const HELP = `Usage: xelis_daemon [OPTIONS]

Options:
      --network <NETWORK>
          Network selected [default: mainnet] [possible values: mainnet, testnet, devnet]
      --log-level <LOG_LEVEL>
          How much to log [default: info] [possible values: off, error, info]
      --auto-prune-keep-n-blocks <AUTO_PRUNE_KEEP_N_BLOCKS>
          Automatically prune the chain
      --rpc-bind-address <RPC_BIND_ADDRESS>
          RPC address [default: 127.0.0.1:8080]
      --p2p-bind-address <P2P_BIND_ADDRESS>
          P2P address
      --rpc-password <RPC_PASSWORD>
          Password for the RPC
      --dir-path <DIR_PATH>
          Directory path
  -h, --help
          Print help
`;

test("settings come from the daemon's own help text, with locked ones left out", () => {
  const found = parseHelp(HELP);
  const flags = found.map((s) => s.flag);
  assert.ok(flags.includes("log-level") && flags.includes("auto-prune-keep-n-blocks"));
  for (const locked of ["network", "rpc-bind-address", "dir-path", "help"]) assert.ok(!flags.includes(locked), `${locked} is locked: xelDash sets it itself`);
  const level = found.find((s) => s.flag === "log-level");
  assert.equal(level.default, "info");
  assert.deepEqual(level.choices, ["off", "error", "info"]);
  assert.equal(level.valueName, "LOG_LEVEL");
  assert.equal(found.find((s) => s.flag === "auto-prune-keep-n-blocks").caution, true);
  assert.equal(found.find((s) => s.flag === "p2p-bind-address").group, "P2P");
  assert.equal(found.find((s) => s.flag === "rpc-password")?.secret, true);
  assert.deepEqual(parseHelp("no options here"), []);
});

test("the mining address: checked for network and shape before the node is asked", async () => {
  const dir = await mkdtemp(join(tmpdir(), "addr-"));
  const main = new MiningAddress({ configDir: dir, network: "mainnet", env: {}, rpcUrl: "http://127.0.0.1:1/json_rpc" });
  await assert.rejects(main.validate("  "), /Paste your XELIS address/);
  await assert.rejects(main.validate("xel: abc"), /no spaces/);
  await assert.rejects(main.validate("xet:" + "a".repeat(40)), /test-network/);
  await assert.rejects(main.validate("xel:SHORT"), /does not look like/);
  await assert.rejects(main.validate("xel:" + "a".repeat(40)), /not answering yet/, "a shaped address needs the node");
  const dev = new MiningAddress({ configDir: dir, network: "devnet", env: {} });
  await assert.rejects(dev.validate("xel:" + "a".repeat(40)), /mainnet address/);
  assert.ok(new AddressProblem("x") instanceof Error);
  await rm(dir, { recursive: true, force: true });
});

test("the mining address starts from .env, and a saved one wins; clearing returns to .env", async () => {
  const dir = await mkdtemp(join(tmpdir(), "addr-"));
  const fromEnv = "xet:" + "b".repeat(40);
  const a = new MiningAddress({ configDir: dir, network: "devnet", env: { XELIS_DEFAULT_ADDRESS: fromEnv } });
  assert.equal((await a.status()).address, null);
  await a.init();
  assert.deepEqual(await a.read(), { address: fromEnv, source: "env" });
  await a.write("xet:" + "c".repeat(40), "dashboard");
  await a.init();
  assert.equal((await a.read()).address, "xet:" + "c".repeat(40), "init does not overwrite a saved choice");
  await a.set("");
  assert.deepEqual(await a.read(), { address: fromEnv, source: "env" });
  const none = new MiningAddress({ configDir: await mkdtemp(join(tmpdir(), "addr-")), network: "mainnet", env: {} });
  await none.init();
  assert.equal(await none.read(), null);
  await rm(dir, { recursive: true, force: true });
});

test("a snapshot's database folder is refused when unzip would read it as an option or a wildcard", async () => {
  const { unsafeArchivePrefix } = await import("../src/snapshot.js");
  for (const ok of ["", "mainnet/", "xelis snapshot (1)/", "data/mainnet/", "a.b-c_d/"]) assert.equal(unsafeArchivePrefix(ok), false, ok);
  for (const bad of ["-d/", "-x/", "*/", "mainnet/*", "a?/", "[ab]/", "x]/", `a${String.fromCharCode(92)}b/`]) assert.equal(unsafeArchivePrefix(bad), true, bad);
});
