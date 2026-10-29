// A public server's visitor sees no electricity at all, and the dashboard does not even ask for it (its own file: the server mode
// is learned once per test process).
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { createElement as h } from "react";
import { cleanup, fakeApi, render, settle } from "../dom/render.js";
import PowerCard from "../../src/components/PowerCard.jsx";

afterEach(cleanup);

test("a public server's visitor sees no electricity at all", async () => {
  const calls = fakeApi({ "/api/v1/connect": { address: null, network: "mainnet", publicMode: true, view: "public" } });
  const view = await render(h(PowerCard, { address: `xel:${"a".repeat(59)}`, worker: "rig1" }));
  await settle();
  assert.equal(view.text(), "");
  assert.equal(calls.some((c) => c.path.startsWith("/api/v1/node/")), false, "not even asked");
});
