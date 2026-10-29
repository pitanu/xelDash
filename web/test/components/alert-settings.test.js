import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { createElement as h } from "react";
import { cleanup, fakeApi, getByText, interact, render, type } from "../dom/render.js";
import AlertSettings from "../../src/components/AlertSettings.jsx";

afterEach(cleanup);

const ALL = ["block_found", "block_rejected", "worker_offline"];
/** @param {any} [over] */
const alerts = (over = {}) => ({
  discord: { set: false, end: null }, telegram: { set: false, end: null, chatId: null }, webhook: { set: false, end: null },
  events: ["block_found"], allEvents: ALL, workerOfflineMinutes: 10, dashboardUrl: null, ...over,
});

/** The field inside the label that starts with `name`. @param {HTMLElement} container @param {string} name */
function field(container, name) {
  const label = [...container.querySelectorAll("label")].find((l) => (l.textContent ?? "").startsWith(name));
  const input = label?.querySelector("input");
  if (!input) throw new Error(`No field ${name}`);
  return input;
}

/** The body of the last save. @param {{ method: string, body: any }[]} calls */
const lastSave = (calls) => calls.filter((c) => c.method === "PUT").at(-1)?.body;

test("a saved secret is shown only by its last characters, never in full", async () => {
  fakeApi({ "GET /api/v1/node/alerts": alerts({ discord: { set: true, end: "x9Qz" } }) });
  const view = await render(h(AlertSettings, { token: "t", onUnauthorized: () => {} }));
  assert.match(view.text(), /set \(ends in x9Qz\)/);
  assert.equal(field(view.container, "Discord").value, "", "the field itself stays empty");
});

test("saving sends only what was changed: empty keeps a secret, a single - removes it", async () => {
  const calls = fakeApi({
    "GET /api/v1/node/alerts": alerts({ discord: { set: true, end: "x9Qz" }, webhook: { set: true, end: "hook" } }),
    "PUT /api/v1/node/alerts": ({ body }) => alerts({ ...body, discord: { set: true, end: "x9Qz" } }),
  });
  const view = await render(h(AlertSettings, { token: "t", onUnauthorized: () => {} }));
  await type(field(view.container, "Other (webhook)"), " - ");
  await interact(() => getByText(view.container, "A worker stops sending shares", "label").querySelector("input")?.click());
  await type(field(view.container, "A worker counts as offline after"), "25");
  await interact(() => getByText(view.container, "Save").click());
  const body = lastSave(calls);
  assert.equal(body.discordWebhookUrl, undefined, "left empty: unchanged");
  assert.equal(body.webhookUrl, "", "a single - removes it");
  assert.equal(body.telegramBotToken, undefined);
  assert.equal(body.telegramChatId, undefined, "an unchanged chat id is not sent");
  assert.deepEqual(body.events, ["block_found", "worker_offline"]);
  assert.equal(body.workerOfflineMinutes, 25);
  assert.match(view.text(), /Saved\. Alerts use the new settings within a few seconds\./);
});

test("removing the Telegram token removes its chat id with it", async () => {
  const calls = fakeApi({
    "GET /api/v1/node/alerts": alerts({ telegram: { set: true, end: "AbCd", chatId: "12345" } }),
    "PUT /api/v1/node/alerts": alerts(),
  });
  const view = await render(h(AlertSettings, { token: "t", onUnauthorized: () => {} }));
  assert.equal(field(view.container, "Telegram chat id").value, "12345");
  await type(field(view.container, "Telegram bot token"), "-");
  await interact(() => getByText(view.container, "Save").click());
  assert.equal(lastSave(calls).telegramBotToken, "");
  assert.equal(lastSave(calls).telegramChatId, "");
});

test("the test message reports each channel, with the reason a channel failed", async () => {
  fakeApi({
    "GET /api/v1/node/alerts": alerts({ discord: { set: true, end: "x9Qz" }, telegram: { set: true, end: "AbCd", chatId: "1" } }),
    "POST /api/v1/node/alerts/test": { results: [{ channel: "Discord", ok: true }, { channel: "Telegram", ok: false, error: "Unauthorized: bot token is wrong" }] },
  });
  const view = await render(h(AlertSettings, { token: "t", onUnauthorized: () => {} }));
  await interact(() => getByText(view.container, "Send a test message").click());
  const lines = [...view.container.querySelectorAll("li")].map((li) => li.textContent);
  assert.deepEqual(lines, [
    "Discord: sent. Check that the message arrived.",
    "Telegram: failed (Unauthorized: bot token is wrong). Check the address and try again.",
  ]);
});

test("the test button waits until something is set up", async () => {
  fakeApi({ "GET /api/v1/node/alerts": alerts() });
  const view = await render(h(AlertSettings, { token: "t", onUnauthorized: () => {} }));
  assert.equal(/** @type {HTMLButtonElement} */ (getByText(view.container, "Send a test message")).disabled, true);
});

test("without the admin token everything is read-only, and a refused token is reported upwards", async () => {
  fakeApi({ "GET /api/v1/node/alerts": alerts() });
  const locked = await render(h(AlertSettings, { token: "", onUnauthorized: () => {} }));
  assert.equal(field(locked.container, "Discord").disabled, true);
  assert.equal(/** @type {HTMLButtonElement} */ (getByText(locked.container, "Save")).disabled, true);
  assert.match(locked.text(), /Unlock above to change alerts\./);
  await locked.unmount();

  let refused = 0;
  fakeApi({ "GET /api/v1/node/alerts": alerts(), "PUT /api/v1/node/alerts": { status: 401, body: { error: "unauthorized" } } });
  const view = await render(h(AlertSettings, { token: "old", onUnauthorized: () => refused++ }));
  await interact(() => getByText(view.container, "Save").click());
  assert.equal(refused, 1);
  assert.equal(view.container.querySelector("[role=alert]")?.textContent, "unauthorized");
});

test("the weekly and monthly reports are chosen beside the alerts, and saved with them", async () => {
  const calls = fakeApi({
    "GET /api/v1/node/alerts": alerts({ reports: [], allReports: ["weekly", "monthly"] }),
    "PUT /api/v1/node/alerts": ({ body }) => alerts({ ...body, allReports: ["weekly", "monthly"] }),
  });
  const view = await render(h(AlertSettings, { token: "t", onUnauthorized: () => {} }));
  assert.match(view.text(), /Reports/);
  await interact(() => getByText(view.container, "Monthly report, on the 1st", "label").querySelector("input")?.click());
  await interact(() => getByText(view.container, "Save").click());
  assert.deepEqual(lastSave(calls).reports, ["monthly"]);
});
