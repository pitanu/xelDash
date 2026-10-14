import test, { afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { createElement as h } from "react";
import { cleanup, fakeApi, getByText, interact, render } from "../dom/render.js";
import OfflineNotice from "../../src/components/OfflineNotice.jsx";
import UpdateNotice, { VersionFooter } from "../../src/components/UpdateNotice.jsx";

afterEach(async () => {
  await cleanup();
  mock.timers.reset();
  localStorage.clear();
});

/** Moves the dashboard's 5-second check on by one round. */
async function nextCheck() {
  await interact(() => mock.timers.tick(5_000));
}

test("the offline notice waits for a second failed check, then says mining continues while only the database is down", async () => {
  mock.timers.enable({ apis: ["setInterval"] });
  let answer = /** @type {unknown} */ ({ status: 503, body: { error: "database_unavailable" } });
  fakeApi({ "/api/v1/events?limit=1": () => answer });
  const view = await render(h(OfflineNotice));
  assert.equal(view.text(), "", "one missed check is not an outage");
  await nextCheck();
  assert.match(view.text(), /Dashboard offline: the database is not reachable\./);
  assert.match(view.text(), /Mining continues\./);
  assert.match(view.text(), /\(since /);

  answer = { events: [] };
  await nextCheck();
  assert.equal(view.text(), "", "it goes away by itself when the data is back");
});

test("an unreachable server is told apart from a database outage, and claims nothing about mining", async () => {
  mock.timers.enable({ apis: ["setInterval"] });
  fakeApi({ "/api/v1/events?limit=1": "offline" });
  const view = await render(h(OfflineNotice));
  await nextCheck();
  assert.match(view.text(), /cannot reach the xelDash server/);
  assert.doesNotMatch(view.text(), /Mining continues/);
});

test("a gateway error from the web server counts as the server being down; other errors do not", async () => {
  mock.timers.enable({ apis: ["setInterval"] });
  let status = 502;
  fakeApi({ "/api/v1/events?limit=1": () => ({ status, body: {} }) });
  const view = await render(h(OfflineNotice));
  await nextCheck();
  assert.match(view.text(), /cannot reach the xelDash server/);

  status = 401;
  await nextCheck();
  assert.equal(view.text(), "", "a refusal is an answer, not an outage");
});

test("while everything answers, the offline check waits half a minute instead of asking every 5 seconds", async () => {
  mock.timers.enable({ apis: ["setInterval", "Date"] });
  const calls = fakeApi({ "/api/v1/events?limit=1": { events: [] } });
  await render(h(OfflineNotice));
  assert.equal(calls.length, 1);
  for (let i = 0; i < 5; i++) await nextCheck();
  assert.equal(calls.length, 1, "25 seconds: no new check");
  await nextCheck();
  assert.equal(calls.length, 2, "30 seconds: checked again");
});

const release = { current: "0.2.0", latest: "0.3.0", available: true, url: "https://github.com/pitanu/xelDash/releases/tag/v0.3.0" };

test("a newer release is announced with the command to update and a link to what changed", async () => {
  fakeApi({ "/api/v1/version": release });
  const view = await render(h(UpdateNotice));
  assert.match(view.text(), /xelDash 0\.3\.0 is available \(you have 0\.2\.0\)/);
  assert.match(view.text(), /xeldash update/);
  const link = /** @type {HTMLAnchorElement} */ (getByText(view.container, "What changed"));
  assert.equal(link.getAttribute("href"), release.url);
  assert.equal(link.getAttribute("rel"), "noopener noreferrer");
});

test("dismissing hides that release for good, but not the next one", async () => {
  fakeApi({ "/api/v1/version": release });
  const first = await render(h(UpdateNotice));
  await interact(() => getByText(first.container, "Dismiss").click());
  assert.equal(first.text(), "");
  await first.unmount();

  const again = await render(h(UpdateNotice));
  assert.equal(again.text(), "", "still hidden after a reload");
  await again.unmount();

  fakeApi({ "/api/v1/version": { ...release, latest: "0.4.0" } });
  const newer = await render(h(UpdateNotice));
  assert.match(newer.text(), /xelDash 0\.4\.0 is available/);
});

test("no notice when up to date, or when the release list cannot be read", async () => {
  fakeApi({ "/api/v1/version": { current: "0.2.0", latest: "0.2.0", available: false } });
  assert.equal((await render(h(UpdateNotice))).text(), "");
  fakeApi({ "/api/v1/version": { status: 502, body: {} } });
  assert.equal((await render(h(UpdateNotice))).text(), "");
});

test("the footer shows the running version, and nothing until it is known", async () => {
  fakeApi({ "/api/v1/version": { current: "0.2.0", latest: null, available: false } });
  assert.equal((await render(h(VersionFooter))).text(), "xelDash 0.2.0");
  fakeApi({});
  assert.equal((await render(h(VersionFooter))).container.innerHTML, "");
});
