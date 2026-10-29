// The weekly and monthly reports (src/reports.js, sent by src/alerts.js). The periods need no database; the report itself runs against a
// real PostgreSQL (see packages/db/test/database.test.js for how to start one): a rig's week in, a webhook message and a browser alert
// out, once, with its electricity where a power draw is set.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { lastPeriod } from "../src/reports.js";
import { testDatabase } from "../../../packages/db/test/test-database.js";

const database = await testDatabase();
const url = database?.url;
const skip = url ? false : "set TEST_DATABASE_URL to run the database tests";
const MIN = 60_000;

test.after(async () => { await database?.drop(); });

test("the period just ended: Monday to Monday for a week, the 1st to the 1st for a month, in UTC", () => {
  // Thursday 29 October 2026, 15:00 UTC.
  const thursday = new Date("2026-10-29T15:00:00Z");
  const week = lastPeriod("weekly", thursday);
  assert.equal(week.from.toISOString(), "2026-10-19T00:00:00.000Z");
  assert.equal(week.to.toISOString(), "2026-10-26T00:00:00.000Z");
  assert.equal(week.key, "weekly:2026-10-19");
  // Just after midnight on a Monday: the week that just ended.
  assert.equal(lastPeriod("weekly", new Date("2026-10-26T00:05:00Z")).from.toISOString(), "2026-10-19T00:00:00.000Z");
  // A Sunday is still in the week that began on Monday 19 October: the one reported is the week before.
  assert.equal(lastPeriod("weekly", new Date("2026-10-25T23:59:00Z")).from.toISOString(), "2026-10-12T00:00:00.000Z");
  const month = lastPeriod("monthly", thursday);
  assert.equal(month.from.toISOString(), "2026-09-01T00:00:00.000Z");
  assert.equal(month.to.toISOString(), "2026-10-01T00:00:00.000Z");
  assert.equal(month.key, "monthly:2026-09");
  assert.equal(lastPeriod("monthly", new Date("2026-01-01T00:10:00Z")).from.toISOString(), "2025-12-01T00:00:00.000Z", "across a year");
});

test("a weekly report: each rig's week and electricity, to the webhook and to an open dashboard, once", { skip, timeout: 30_000 }, async () => {
  const script = fileURLToPath(new URL("../../../packages/db/src/migrate.js", import.meta.url));
  execFileSync(process.execPath, [script], { env: { ...process.env, DATABASE_URL: url }, encoding: "utf8" });
  const db = await import("@xeldash/db");
  const { alertConfigFromEnv, startAlerts } = await import("../src/alerts.js");
  const pool = db.createPool(/** @type {string} */ (url));

  // The week reported is the one before the clock's: the clock is a Monday soon after midnight, the week the 7 days before it.
  const clock = new Date("2031-03-10T00:20:00Z");
  const { from, to, key } = lastPeriod("weekly", clock);
  const day = (/** @type {Date} */ d) => d.toISOString().slice(0, 10);
  const address = `xet:${randomBytes(20).toString("hex")}`;
  const { workerId } = await db.ensureWorker(pool, { address, name: "rig1" });
  // Tracking began well before the week (time before the first minute stats does not count as off).
  const anchor = await db.ensureWorker(pool, { address: `xet:${randomBytes(20).toString("hex")}`, name: "anchor" });
  await pool.query("INSERT INTO worker_stats_1m (bucket, worker_id, accepted, rejected, sum_difficulty, sum_effort) VALUES ($1, $2, 1, 0, 1, 0) ON CONFLICT DO NOTHING",
    [new Date(from.getTime() - 100 * 86_400_000), anchor.workerId]);
  // 10 hours on, in the middle of the week: 600 minutes of 600 difficulty and 0.001 expected blocks each, 1 of 101 shares rejected.
  const times = Array.from({ length: 600 }, (_, i) => new Date(from.getTime() + 2 * 86_400_000 + i * MIN));
  await pool.query(
    `INSERT INTO worker_stats_1m (bucket, worker_id, accepted, rejected, sum_difficulty, sum_effort)
     SELECT t, $2, 1, CASE WHEN t = $3 THEN 1 ELSE 0 END, 600, 0.001 FROM unnest($1::timestamptz[]) AS t`,
    [times, workerId, times[0]],
  );

  const dir = await mkdtemp(join(tmpdir(), "report-"));
  const powerFile = join(dir, "power.json");
  await writeFile(powerFile, JSON.stringify({ currency: "eur", pricePerKwh: 0.25, watts: { [`${address}/rig1`]: 300 } }));

  /** @type {any[]} */
  const received = [];
  const hook = createServer((request, response) => {
    let body = "";
    request.on("data", (c) => { body += c; });
    request.on("end", () => { received.push(JSON.parse(body)); response.end("ok"); });
  });
  await new Promise((resolve) => hook.listen(0, "127.0.0.1", () => resolve(undefined)));
  const hookUrl = `http://127.0.0.1:${/** @type {import("node:net").AddressInfo} */ (hook.address()).port}/`;
  /** @type {any[]} */
  const relayed = [];
  const options = {
    pool, logger: { info() {}, warn() {} }, reportCheckMs: 100, workerCheckMs: 60_000,
    relay: { active: () => true, push: (/** @type {any} */ a) => relayed.push(a) },
    reportSources: { powerFile, rewardAtomic: async () => 150_000_000, xelPrice: async () => 2, now: () => clock },
  };
  const alerts = startAlerts({ ...options, config: alertConfigFromEnv({ ALERT_WEBHOOK_URL: hookUrl, ALERT_EVENTS: "block_found", ALERT_REPORTS: "weekly" }) });
  for (let i = 0; i < 100 && received.length === 0; i++) await new Promise((r) => setTimeout(r, 50));
  // Checked several more times, and by a restarted API: still one report.
  await new Promise((r) => setTimeout(r, 400));
  alerts?.stop();
  const again = startAlerts({ ...options, config: alertConfigFromEnv({ ALERT_WEBHOOK_URL: hookUrl, ALERT_REPORTS: "weekly" }) });
  await new Promise((r) => setTimeout(r, 400));
  again?.stop();
  hook.close();

  assert.equal(received.length, 1, "one report, however often it is checked");
  const report = received[0];
  assert.equal(report.event, "report_weekly");
  assert.equal(report.period, "weekly");
  assert.equal(report.from, from.toISOString());
  const rig = report.rigs.find((/** @type {any} */ r) => r.address === address);
  assert.ok(rig, "our rig is in it");
  assert.equal(rig.onMinutes, 600);
  assert.equal(rig.hashrateWhileOn, 10);
  assert.equal(rig.accepted, 600);
  assert.equal(rig.rejected, 1);
  assert.ok(Math.abs(rig.expectedBlocks - 0.6) < 1e-9);
  assert.equal(rig.kwh, 3, "300 W for 10 hours");
  assert.equal(rig.cost, 0.75);
  assert.ok(Math.abs(rig.expectedValue - 1.8) < 1e-9, "0.6 blocks of 1.5 XEL at 2 €");
  assert.ok(report.text.startsWith(`Weekly report, ${day(from)} to ${day(new Date(to.getTime() - 86_400_000))} (UTC)`), report.text);
  assert.match(report.text, /- rig1 \(xet:.*\): on 10 h \(6%\), 10\.0 H\/s while on, 0\.2% rejected, 0 of 0\.6 blocks, 0\.75 EUR power/);
  assert.deepEqual(relayed.filter((a) => a.kind === "report_weekly").length, 1, "and once to the open dashboard");
  const recorded = await pool.query("SELECT payload FROM service_events WHERE type = 'report_sent' AND payload->>'key' = $1", [key]);
  assert.equal(recorded.rows.length, 1);
  assert.deepEqual(recorded.rows[0].payload, { key, period: "weekly", from: day(from), to: day(to) });
  await pool.end();
});

test("not chosen, nobody looking, a day late or a public server: no report", { skip, timeout: 30_000 }, async () => {
  const db = await import("@xeldash/db");
  const { alertConfigFromEnv, startAlerts } = await import("../src/alerts.js");
  const pool = db.createPool(/** @type {string} */ (url));
  /** @type {string[]} */
  const sent = [];
  const relay = (/** @type {boolean} */ open) => ({ active: () => open, push: (/** @type {any} */ a) => sent.push(`${a.kind}`) });
  const run = async (/** @type {Record<string, string>} */ env, /** @type {Date} */ now, /** @type {boolean} */ open) => {
    const a = startAlerts({ pool, config: alertConfigFromEnv(env), logger: { info() {}, warn() {} }, reportCheckMs: 50, relay: relay(open),
      reportSources: { now: () => now } });
    await new Promise((r) => setTimeout(r, 200));
    a?.stop();
  };
  const hook = "http://127.0.0.1:9/";
  await run({ ALERT_WEBHOOK_URL: hook }, new Date("2032-03-08T00:20:00Z"), false);
  await run({ ALERT_WEBHOOK_URL: hook, ALERT_REPORTS: "weekly" }, new Date("2032-03-09T01:00:00Z"), true);
  await run({ ALERT_WEBHOOK_URL: hook, ALERT_REPORTS: "weekly,monthly", XELDASH_PUBLIC_MODE: "true" }, new Date("2032-03-15T00:20:00Z"), true);
  assert.deepEqual(sent.filter((k) => k.startsWith("report_")), []);
  const recorded = await pool.query("SELECT count(*)::int AS n FROM service_events WHERE type = 'report_sent' AND payload->>'key' LIKE '%2032-%'");
  assert.equal(recorded.rows[0].n, 0);
  await pool.end();
});
