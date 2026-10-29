// Electricity for cost and profit per rig (src/power.js): a price per kWh in a currency, watts per worker, both checked as they are
// entered, kept on the config volume; nothing on a public server.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PowerSettings, PowerSettingsProblem } from "../src/power.js";

const ADDRESS = `xel:${"a".repeat(59)}`;

async function power(publicMode = false) {
  const dir = await mkdtemp(join(tmpdir(), "power-"));
  return { p: new PowerSettings({ configDir: dir, publicMode: () => publicMode }), dir, done: () => rm(dir, { recursive: true, force: true }) };
}

test("nothing set at first; a price and a rig's watts are kept, and each can be removed again", async () => {
  const { p, dir, done } = await power();
  assert.deepEqual(await p.status(), { available: true, currency: null, pricePerKwh: null, watts: {}, currencies: (await p.status()).currencies });
  await p.setPrice({ currency: "eur", pricePerKwh: 0.25 });
  await p.setWorker({ address: ADDRESS, worker: "rig1", watts: 320.04 });
  await p.setWorker({ address: ADDRESS, worker: "rig/2", watts: 95 });
  const s = await p.status();
  assert.equal(s.currency, "eur");
  assert.equal(s.pricePerKwh, 0.25);
  assert.deepEqual(s.watts, { [`${ADDRESS}/rig1`]: 320, [`${ADDRESS}/rig/2`]: 95 }, "to a tenth of a watt; any worker name");
  assert.equal(JSON.parse(await readFile(join(dir, "power.json"), "utf8")).pricePerKwh, 0.25, "on the config volume, for the API");
  await p.setWorker({ address: ADDRESS, worker: "rig1", watts: null });
  await p.setPrice({ pricePerKwh: null });
  const after = await p.status();
  assert.deepEqual(after.watts, { [`${ADDRESS}/rig/2`]: 95 });
  assert.equal(after.pricePerKwh, null);
  assert.equal(after.currency, null);
  await done();
});

test("what is entered is checked, in words a beginner can act on", async () => {
  const { p, done } = await power();
  for (const bad of [{ currency: "eur", pricePerKwh: -1 }, { currency: "eur", pricePerKwh: "0.25" }, { currency: "btc", pricePerKwh: 0.2 }, { pricePerKwh: 0.2 }]) {
    await assert.rejects(p.setPrice(bad), PowerSettingsProblem, JSON.stringify(bad));
  }
  for (const bad of [{ address: ADDRESS, worker: "rig1", watts: 0 }, { address: ADDRESS, worker: "rig1", watts: 200_000 },
    { address: "not-an-address", worker: "rig1", watts: 100 }, { address: ADDRESS, worker: "", watts: 100 }]) {
    await assert.rejects(p.setWorker(bad), PowerSettingsProblem, JSON.stringify(bad));
  }
  await assert.rejects(p.setPrice({ currency: "eur", pricePerKwh: 120 }), /a number such as 0\.25/);
  await done();
});

test("a public server has no electricity to set: its rigs are other people's", async () => {
  const { p, done } = await power(true);
  assert.equal((await p.status()).available, false);
  await assert.rejects(p.setPrice({ currency: "eur", pricePerKwh: 0.25 }), /public server/);
  await assert.rejects(p.setWorker({ address: ADDRESS, worker: "rig1", watts: 100 }), /public server/);
  await done();
});
