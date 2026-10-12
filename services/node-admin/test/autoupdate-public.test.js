// Automatic node updates on a public server: only while .env allows them (XELIS_AUTO_UPDATE=true), never switched on from the
// dashboard otherwise, and a release waits at least 36 hours.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AutoUpdate, PUBLIC_MIN_DELAY_HOURS } from "../src/autoupdate.js";

const quiet = { info() {}, warn() {} };

/** @param {{ env?: Record<string, string>, publicMode?: () => boolean }} options */
async function make({ env = {}, publicMode } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "autoupdate-"));
  const twoNodes = [{ present: true, state: "running", snapshots: { busy: false } }, { present: true, state: "running", snapshots: { busy: false } }];
  const auto = new AutoUpdate({
    configDir: dir,
    releases: /** @type {any} */ ({ latest: async () => null, list: async () => [] }),
    upgrade: /** @type {any} */ ({ state: {}, running: false }),
    nodes: () => /** @type {any} */ (twoNodes),
    order: () => /** @type {any} */ (twoNodes),
    scheduled: async () => false,
    env,
    ...(publicMode ? { publicMode } : {}),
    logger: quiet,
  });
  return { auto, dir, done: () => rm(dir, { recursive: true, force: true }) };
}

test("a normal server: the dashboard switch works as before, and the delay is the setting", async () => {
  const { auto, done } = await make({ env: { XELIS_AUTO_UPDATE_DELAY_HOURS: "12" } });
  assert.equal(auto.delayHours, 12);
  assert.equal((await auto.setEnabled(true)).enabled, true);
  assert.equal((await auto.status()).publicMode, false);
  await done();
});

test("a public server without XELIS_AUTO_UPDATE=true: the dashboard cannot switch automatic updates on", async () => {
  const { auto, dir, done } = await make({ publicMode: () => true });
  await assert.rejects(auto.setEnabled(true), /public server.*XELIS_AUTO_UPDATE=true/);
  // An "on" saved earlier from the dashboard (before public mode) does not count.
  await writeFile(join(dir, "auto-update.json"), JSON.stringify({ enabled: true }));
  const status = await auto.status();
  assert.equal(status.enabled, false);
  assert.equal(status.allowedByEnv, false);
  assert.match(String(await auto.checkOnce()), /Off on a public server/);
  assert.equal((await auto.setEnabled(false)).enabled, false, "switching off is always allowed");
  await done();
});

test("a public server with XELIS_AUTO_UPDATE=true: on, can be switched off and on again, and waits at least 36 hours", async () => {
  for (const [setting, expected] of [["", PUBLIC_MIN_DELAY_HOURS], ["24", 36], ["12", 36], ["48", 48]]) {
    const { auto, done } = await make({ env: { XELIS_AUTO_UPDATE: "true", XELIS_AUTO_UPDATE_DELAY_HOURS: setting }, publicMode: () => true });
    assert.equal(auto.delayHours, expected, `setting "${setting}"`);
    assert.equal((await auto.status()).enabled, true, ".env allows it and nothing else was chosen");
    assert.equal((await auto.setEnabled(false)).enabled, false);
    assert.equal((await auto.setEnabled(true)).enabled, true, "back on, because .env allows it");
    await done();
  }
});

test("a standby that learns its main server is public follows it at once", async () => {
  let mainPublic = false;
  const { auto, done } = await make({ env: { XELIS_AUTO_UPDATE_DELAY_HOURS: "24" }, publicMode: () => mainPublic });
  assert.equal((await auto.setEnabled(true)).enabled, true);
  mainPublic = true;
  assert.equal((await auto.status()).enabled, false, "no longer allowed: its .env does not say XELIS_AUTO_UPDATE=true");
  assert.equal(auto.delayHours, 36);
  await done();
});
