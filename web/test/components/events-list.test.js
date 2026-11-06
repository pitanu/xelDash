// The recent events: a report says where it went and the days it covers (its last day, not the next period's first midnight).
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { createElement as h } from "react";
import { cleanup, render } from "../dom/render.js";
import { EventsList } from "../../src/components/ui.jsx";

afterEach(cleanup);

test("a report sent to channels names them; one from before they were named was only shown on open dashboards", async () => {
  const at = new Date().toISOString();
  const view = await render(h(EventsList, { events: [
    { id: 1, type: "report_sent", createdAt: at, payload: { key: "weekly:2026-10-26", period: "weekly", from: "2026-10-26", to: "2026-11-02", channels: ["Discord", "Telegram"] } },
    { id: 2, type: "report_sent", createdAt: at, payload: { key: "monthly:2026-10", period: "monthly", from: "2026-10-01", to: "2026-11-01" } },
  ] }));
  const text = view.text();
  const day = (/** @type {string} */ iso) => new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "numeric", timeZone: "UTC" });
  assert.ok(text.includes(`Weekly report sent to Discord and Telegram · ${day("2026-10-26")}–${day("2026-11-01")}`), text);
  assert.ok(text.includes(`Monthly report shown on open dashboards only · ${day("2026-10-01")}–${day("2026-10-31")}`), text);
  assert.doesNotMatch(text, /report_sent|→/);
});
