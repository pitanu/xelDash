import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AlertSettings, AlertSettingsProblem } from "../src/alert-settings.js";

const TOKEN = "123456789:ABCdefGHIjklMNOpqrSTUvwxYZ_-0123456789";

async function settings(env = {}) {
  const dir = await mkdtemp(join(tmpdir(), "alerts-"));
  return { s: new AlertSettings({ configDir: dir, env }), dir, done: () => rm(dir, { recursive: true, force: true }) };
}

test("the starting values come from .env, with every alert type on by default", async () => {
  const { s, done } = await settings({ ALERT_DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/1/abcdWXYZ", ALERT_EVENTS: "block_found,nonsense", ALERT_WORKER_OFFLINE_MINUTES: "30" });
  const status = await s.status();
  assert.deepEqual(status.discord, { set: true, end: "WXYZ" });
  assert.deepEqual(status.events, ["block_found"], "unknown names are dropped");
  assert.equal(status.workerOfflineMinutes, 30);
  assert.equal(status.webhook.set, false);
  const fresh = await settings({});
  assert.deepEqual((await fresh.s.status()).events, (await fresh.s.status()).allEvents);
  await done(); await fresh.done();
});

test("a secret is never given back, only that it is set and its last four characters", async () => {
  const { s, done } = await settings();
  await s.set({ webhookUrl: "https://example.com/hook?key=SECRETVALUE1234" });
  const status = await s.status();
  assert.deepEqual(status.webhook, { set: true, end: "1234" });
  assert.ok(!JSON.stringify(status).includes("SECRETVALUE"));
  await done();
});

test("what is typed is checked, with messages a beginner can act on", async () => {
  const { s, done } = await settings();
  await assert.rejects(s.set({ discordWebhookUrl: "not a url" }), AlertSettingsProblem);
  await assert.rejects(s.set({ discordWebhookUrl: "http://discord.com/api/webhooks/1/x" }), /https/);
  await assert.rejects(s.set({ discordWebhookUrl: "https://example.com/api/webhooks/1/x" }), /Discord webhook/);
  await assert.rejects(s.set({ webhookUrl: "ftp://example.com/x" }), /http/);
  await assert.rejects(s.set({ telegramBotToken: "abc", telegramChatId: "1" }), /bot token/);
  await assert.rejects(s.set({ telegramBotToken: TOKEN }), /both/);
  await assert.rejects(s.set({ telegramBotToken: TOKEN, telegramChatId: "hello world" }), /chat id/);
  await assert.rejects(s.set({ events: ["nope"] }), /Unknown alert type/);
  await assert.rejects(s.set({ workerOfflineMinutes: 0 }), /1 to 1440/);
  await assert.rejects(s.set({ workerOfflineMinutes: "5" }), /1 to 1440/);
  assert.ok(!(await stat(join(s.configDir, "alerts.json")).then(() => true, () => false)), "nothing was saved by the refused changes");
  await s.set({ telegramBotToken: TOKEN, telegramChatId: "@mychannel", events: ["block_found", "block_found", "cluster"], workerOfflineMinutes: 15 });
  const status = await s.status();
  assert.deepEqual(status.events, ["block_found", "cluster"]);
  assert.equal(status.telegram.chatId, "@mychannel");
  await done();
});

test("a missing field is left alone, an empty string removes a setting", async () => {
  const { s, done } = await settings();
  await s.set({ webhookUrl: "https://example.com/a", dashboardUrl: "http://192.168.1.10:8088" });
  await s.set({ events: ["cluster"] });
  assert.equal((await s.status()).webhook.set, true);
  await s.set({ webhookUrl: "" });
  assert.equal((await s.status()).webhook.set, false);
  assert.equal((await s.status()).dashboardUrl, "http://192.168.1.10:8088/");
  await done();
});

test("a copy from another server is checked like anything typed in", async () => {
  const { s, done } = await settings();
  await s.importFrom({ webhookUrl: "https://example.com/hook", events: ["cluster"], workerOfflineMinutes: 20 });
  assert.equal((await s.status()).webhook.set, true);
  await assert.rejects(s.importFrom({ discordWebhookUrl: "https://evil.example/api/webhooks/1/x" }), AlertSettingsProblem);
  await assert.rejects(s.importFrom(null), /No alert settings/);
  await assert.rejects(s.importFrom({ events: ["bogus"] }), /Unknown alert type/);
  await done();
});

/** A web server that records what alerts it is sent. */
async function receiver() {
  const got = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => { body += d; });
    req.on("end", () => { got.push(JSON.parse(body)); res.end("ok"); });
  });
  server.unref();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { got, url: `http://127.0.0.1:${server.address().port}/hook`, close: () => server.close() };
}

test("an alert goes only to the places set up, and only if its type is switched on", async () => {
  const rx = await receiver();
  const { s, done } = await settings();
  await s.set({ webhookUrl: rx.url, events: ["block_found"] });
  assert.deepEqual(await s.broadcast("hello", "cluster"), [], "that type is off");
  assert.deepEqual(await s.broadcast("found one", "block_found"), [{ channel: "Webhook", ok: true }]);
  assert.equal(rx.got.length, 1);
  assert.equal(rx.got[0].event, "block_found");
  assert.equal(rx.got[0].text, "found one");
  assert.deepEqual(await s.test(), [{ channel: "Webhook", ok: true }], "the test message ignores the type list");
  rx.close();
  await done();
});

test("a failed delivery says so without revealing the address", async () => {
  const { s, done } = await settings();
  await s.set({ webhookUrl: "http://127.0.0.1:1/secret-path-123" });
  const [result] = await s.test();
  assert.equal(result.ok, false);
  assert.ok(!String(result.error).includes("secret-path-123"));
  await done();
});

test("the saved file is valid JSON on the volume", async () => {
  const { s, done } = await settings();
  await s.set({ events: ["cluster"] });
  assert.deepEqual(JSON.parse(await readFile(s.file, "utf8")).events, ["cluster"]);
  await done();
});
