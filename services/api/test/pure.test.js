import test from "node:test";
import assert from "node:assert/strict";
import { atomicToXel, csvCell, toCsv } from "../src/csv.js";
import { compareVersions, parseVersion } from "../src/release.js";
import { isNewer, newestStable } from "../src/update.js";
import { computePauses } from "../src/uptime.js";

test("CSV: quoting, and no spreadsheet formulas from miner-chosen names", () => {
  assert.equal(csvCell("plain"), "plain");
  assert.equal(csvCell(null), "");
  assert.equal(csvCell(undefined), "");
  assert.equal(csvCell(12), "12");
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(csvCell("a,b"), '"a,b"');
  assert.equal(csvCell("line\nbreak"), '"line\nbreak"');
  for (const bad of ["=HYPERLINK(1)", "+1", "-1", "@SUM(A1)", "\tx", "\rx"]) assert.ok(csvCell(bad).replace(/^"/, "").startsWith("'"), bad);
  assert.equal(toCsv([["a", "b"], [1, "=x"]]), "a,b\r\n1,'=x\r\n");
});

test("atomic units become exact decimal XEL strings", () => {
  assert.equal(atomicToXel("100000000"), "1.00000000");
  assert.equal(atomicToXel("1"), "0.00000001");
  assert.equal(atomicToXel("123456789012"), "1234.56789012");
  assert.equal(atomicToXel("0"), "0.00000000");
  assert.equal(atomicToXel(null), "");
  assert.equal(atomicToXel(""), "");
});

test("versions are parsed and compared", () => {
  assert.deepEqual(parseVersion("1.25.0-db59b5c2"), [1, 25, 0]);
  assert.deepEqual(parseVersion("v0.1.0"), [0, 1, 0]);
  assert.equal(parseVersion("latest"), null);
  assert.equal(parseVersion(null), null);
  assert.ok(compareVersions([1, 24, 9], [1, 25, 0]) < 0);
  assert.ok(compareVersions([2, 0, 0], [1, 99, 99]) > 0);
  assert.equal(compareVersions([1, 2, 3], [1, 2, 3]), 0);
});

test("an update is offered only for a newer version; a release candidate is older than its release", () => {
  assert.ok(isNewer("0.1.0", "0.2.0"));
  assert.ok(!isNewer("0.2.0", "0.1.0"));
  assert.ok(!isNewer("0.2.0", "0.2.0"));
  assert.ok(isNewer("0.1.0-rc.4", "0.1.0"));
  assert.ok(!isNewer("unknown", "0.1.0"));
  assert.ok(!isNewer("0.1.0", "garbage"));
});

test("the newest stable tag ignores pre-releases and junk", () => {
  const tags = [{ name: "v0.1.0-rc.4" }, { name: "v0.1.0" }, { name: "v0.10.0" }, { name: "v0.9.9" }, { name: "latest" }, { name: "v1.0.0-beta" }, null, {}];
  assert.equal(newestStable(tags), "0.10.0");
  assert.equal(newestStable([{ name: "v0.1.0-rc.1" }]), null);
  assert.equal(newestStable("nope"), null);
});

const at = (minutes) => new Date(Date.UTC(2026, 0, 1, 0, minutes));
const START = at(0);
const END = at(600);

test("uptime: a pause runs from the node going away to it being ready again", () => {
  const r = computePauses([{ type: "node_unreachable", at: at(10) }, { type: "node_ready", at: at(25) }], { paused: false, reason: null }, START, END);
  assert.equal(r.pauses.length, 1);
  assert.equal(r.pausedMs, 15 * 60_000);
  assert.equal(r.restarts, 0);
});

test("uptime: a pause open at the window's start or end is counted to the edge", () => {
  const open = computePauses([{ type: "node_ready", at: at(30) }], { paused: true, reason: "node_syncing" }, START, END);
  assert.equal(open.pausedMs, 30 * 60_000);
  assert.equal(open.pauses[0].reason, "node_syncing");
  const tail = computePauses([{ type: "node_syncing", at: at(500) }], { paused: false, reason: null }, START, END);
  assert.equal(tail.pausedMs, 100 * 60_000);
  assert.equal(tail.pauses[0].to, null);
});

test("uptime: a Stratum restart ends an open pause and is counted, a repeated start changes nothing", () => {
  const events = [
    { type: "node_unreachable", at: at(10) }, { type: "node_syncing", at: at(12) }, { type: "stratum_started", at: at(20) },
    { type: "node_ready", at: at(21) }, { type: "stratum_started", at: at(100) },
  ];
  const r = computePauses(events, { paused: false, reason: null }, START, END);
  assert.equal(r.pauses.length, 1);
  assert.equal(r.pausedMs, 10 * 60_000, "from the first start of the pause to the restart");
  assert.equal(r.restarts, 2);
  assert.equal(r.pauses[0].reason, "node_unreachable");
});
