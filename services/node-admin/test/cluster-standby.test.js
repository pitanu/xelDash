import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AlertSettings } from "../src/alert-settings.js";
import { ClusterWatch } from "../src/cluster.js";
import { StandbyAlerts } from "../src/standby.js";

const quiet = { info() {}, warn() {} };

test("the cluster role is read from the address manager's file, and changes become events", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cluster-"));
  const events = [];
  const watch = new ClusterWatch({ configDir: dir, record: (type, payload) => events.push([type, payload]) });
  assert.deepEqual(await watch.status(), { configured: false });
  await watch.check();
  assert.equal(events.length, 0, "no file, nothing to say");

  const write = (state, since) => writeFile(join(dir, "cluster.json"), JSON.stringify({ state, since, vip: "192.168.1.250/24", interface: "eth0", server: "pc1" }));
  await write("MASTER", "t1");
  assert.equal((await watch.status()).configured, true);
  await watch.check();
  assert.equal(events.length, 0, "the first look only remembers the state");
  await watch.check();
  assert.equal(events.length, 0, "no change, no event");
  await write("BACKUP", "t2"); await watch.check();
  await write("FAULT", "t3"); await watch.check();
  await write("MASTER", "t4"); await watch.check();
  await write("STOP", "t5"); await watch.check();
  assert.deepEqual(events.map((e) => e[0]), ["cluster_standby", "cluster_fault", "cluster_active"], "STOP is not alerted");
  assert.deepEqual(events[0][1], { server: "pc1", vip: "192.168.1.250/24" });
  await writeFile(join(dir, "cluster.json"), "{garbage");
  assert.deepEqual(await watch.status(), { configured: false }, "a damaged file counts as no cluster");
  await rm(dir, { recursive: true, force: true });
});

async function standby({ reachable = true, alertsBody = { webhookUrl: "https://example.com/hook", events: ["cluster"] } } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "standby-"));
  const alertSettings = new AlertSettings({ configDir: dir, env: {} });
  const sent = [];
  alertSettings.broadcast = async (text, event) => { sent.push([text, event]); return [{ channel: "Webhook", ok: true }]; };
  const calls = [];
  const fetchStub = async (url, init) => {
    calls.push([url, init.headers["x-cluster-secret"]]);
    if (!reachable) throw new Error("connect ECONNREFUSED");
    if (url.endsWith("/api/v1/ingest/alerts")) return new Response(JSON.stringify(alertsBody), { status: 200 });
    return new Response("{}", { status: 200 });
  };
  const alerts = new StandbyAlerts({ alertSettings, primaryUrl: "http://main:8088/", secret: "s".repeat(20), serverName: "standby-1", fetch: fetchStub, logger: quiet });
  return { alerts, alertSettings, sent, calls, done: () => rm(dir, { recursive: true, force: true }) };
}

test("the standby copies the main server's alert settings, with the secret", async () => {
  const s = await standby();
  assert.equal(await s.alerts.sync(), true);
  assert.equal(s.calls[0][0], "http://main:8088/api/v1/ingest/alerts", "no double slash");
  assert.equal(s.calls[0][1], "s".repeat(20));
  assert.equal((await s.alertSettings.status()).webhook.set, true);
  await s.done();
});

test("an unreachable main server or bad settings keep the last copy and say so", async () => {
  const down = await standby({ reachable: false });
  assert.equal(await down.alerts.sync(), false);
  const bad = await standby({ alertsBody: { discordWebhookUrl: "https://evil.example/api/webhooks/1/x" } });
  assert.equal(await bad.alerts.sync(), false, "refused settings are not stored");
  assert.equal((await bad.alertSettings.status()).discord.set, false);
  await down.done(); await bad.done();
});

test("a failover is alerted from the standby only while the main server cannot be reached", async () => {
  const away = await standby({ reachable: false });
  const result = await away.alerts.onClusterChange("cluster_active", { server: "standby-1", vip: "192.168.1.250/24" });
  assert.equal(result.length, 1);
  assert.match(away.sent[0][0], /main server is not answering/);
  assert.match(away.sent[0][0], /192\.168\.1\.250\/24/);
  assert.equal(away.sent[0][1], "cluster");
  await away.alerts.onClusterChange("cluster_fault", { server: "standby-1" });
  assert.match(away.sent[1][0], /cannot mine/);
  await away.alerts.onClusterChange("cluster_standby", { server: "standby-1" });
  assert.equal(away.sent.length, 2, "standing by again is the main server's to report");

  const near = await standby({ reachable: true });
  assert.deepEqual(await near.alerts.onClusterChange("cluster_active", {}), []);
  assert.equal(near.sent.length, 0, "the main server is reachable, so it reports its own changes");
  await away.done(); await near.done();
});
