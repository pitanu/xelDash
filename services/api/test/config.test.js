import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { alertConfigFromEnv, loadAlertConfig } from "../src/alerts.js";
import { coinSymbol } from "../src/coin.js";
import { getConnectInfo } from "../src/connect.js";
import { ADDRESS_PATTERN, clampLimit } from "../src/queries.js";
import { rpcUrlsFromEnv, nodeLabel } from "../src/nodes.js";

test("limits: a missing or silly value falls back, a big one is capped", () => {
  assert.equal(clampLimit(null, 50, 500), 50);
  assert.equal(clampLimit("20", 50, 500), 20);
  assert.equal(clampLimit("9999", 50, 500), 500);
  for (const bad of ["0", "-5", "abc", ""]) assert.equal(clampLimit(bad, 50, 500), 50, bad);
});

test("a miner address in a URL must look like one before it reaches a query", () => {
  assert.ok(ADDRESS_PATTERN.test(`xel:${"a".repeat(40)}`));
  assert.ok(ADDRESS_PATTERN.test(`xet:${"a1".repeat(20)}`));
  for (const bad of ["", "xel:", "xel:SHORT", `xel:${"A".repeat(40)}`, `xyz:${"a".repeat(40)}`, `xel:${"a".repeat(40)}'; DROP TABLE miners;--`, `xel:${"a".repeat(121)}`]) {
    assert.ok(!ADDRESS_PATTERN.test(bad), bad);
  }
});

test("alert settings from .env: every kind on by default, unknown kinds and half a Telegram setup are errors", () => {
  const c = alertConfigFromEnv({});
  assert.ok(c.events.has("block_found") && c.events.has("cluster"));
  assert.equal(c.discordWebhookUrl, null);
  assert.equal(alertConfigFromEnv({ ALERT_EVENTS: "block_found, disk_low" }).events.size, 2);
  assert.throws(() => alertConfigFromEnv({ ALERT_EVENTS: "block_found,bogus" }), /unknown event "bogus"/);
  assert.throws(() => alertConfigFromEnv({ ALERT_TELEGRAM_BOT_TOKEN: "t" }), /both/);
  assert.throws(() => alertConfigFromEnv({ ALERT_WORKER_OFFLINE_MINUTES: "0" }), /positive integer/);
  assert.equal(alertConfigFromEnv({ XELIS_NETWORK: "mainnet" }).explorerUrl, "https://explorer.xelis.io");
  assert.equal(alertConfigFromEnv({ XELIS_NETWORK: "devnet" }).explorerUrl, null, "devnet has no explorer");
  assert.equal(alertConfigFromEnv({ XELIS_NETWORK: "mainnet" }).coin, "XEL");
  for (const network of ["devnet", "testnet", undefined]) assert.equal(alertConfigFromEnv({ XELIS_NETWORK: network }).coin, "XET", `${network}: the coin is XET`);
});

test("the coin's symbol follows the network", () => {
  assert.equal(coinSymbol("mainnet"), "XEL");
  assert.equal(coinSymbol("MAINNET"), "XEL");
  assert.equal(coinSymbol("testnet"), "XET");
  assert.equal(coinSymbol("devnet"), "XET");
  assert.equal(coinSymbol(undefined), "XET");
});

test("alert settings saved on the dashboard win over .env, and an empty list means nothing, not everything", async () => {
  const dir = await mkdtemp(join(tmpdir(), "alerts-"));
  const file = join(dir, "alerts.json");
  const env = { ALERT_WEBHOOK_URL: "https://env.example/hook", XELIS_NETWORK: "mainnet" };
  assert.equal((await loadAlertConfig(env, file)).webhookUrl, "https://env.example/hook", "no file: .env");
  await writeFile(file, JSON.stringify({ webhookUrl: "https://saved.example/hook", events: ["cluster", "bogus"], workerOfflineMinutes: 25 }));
  const saved = await loadAlertConfig(env, file);
  assert.equal(saved.webhookUrl, "https://saved.example/hook");
  assert.deepEqual([...saved.events], ["cluster"]);
  assert.equal(saved.workerOfflineMinutes, 25);
  assert.equal(saved.explorerUrl, "https://explorer.xelis.io");
  await writeFile(file, JSON.stringify({ events: [] }));
  assert.equal((await loadAlertConfig(env, file)).events.size, 0);
  await writeFile(file, "{broken");
  assert.equal((await loadAlertConfig(env, file)).webhookUrl, "https://env.example/hook", "a damaged file falls back to .env");
  await rm(dir, { recursive: true, force: true });
});

test("what a miner needs to connect: ports, TLS and getwork only when on, and whether other computers can reach it", async () => {
  const defaults = await getConnectInfo({ XELIS_NETWORK: "MAINNET" });
  assert.equal(defaults.network, "mainnet");
  assert.equal(defaults.stratumPort, 3333);
  assert.equal(defaults.tlsPort, null);
  assert.equal(defaults.getworkPort, 8090);
  assert.equal(defaults.reachableFromNetwork, false, "bound to this computer only");
  const lan = await getConnectInfo({ CONNECT_BIND_IP: "0.0.0.0", CONNECT_HOST: " 192.168.1.10 ", STRATUM_TLS_ENABLED: "true", CONNECT_TLS_PORT: "4444", GETWORK_ENABLED: "false", CONNECT_STRATUM_PORT: "99999" });
  assert.equal(lan.reachableFromNetwork, true);
  assert.equal(lan.host, "192.168.1.10");
  assert.equal(lan.tlsPort, 4444);
  assert.equal(lan.getworkPort, null);
  assert.equal(lan.stratumPort, 3333, "a nonsense port falls back");
});

test("node addresses, in order, with names for the dashboard", () => {
  assert.deepEqual(rpcUrlsFromEnv({ XELIS_RPC_URLS: "http://a:8080/json_rpc,http://b:8080/json_rpc" }), ["http://a:8080/json_rpc", "http://b:8080/json_rpc"]);
  assert.equal(nodeLabel("http://daemon:8080/json_rpc"), "daemon");
});
