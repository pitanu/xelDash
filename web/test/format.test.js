import test from "node:test";
import assert from "node:assert/strict";
import { formatAgo, formatBucket, formatBytes, formatCompact, formatDiskBytes, formatDuration, formatEffort, formatHashrate, formatInteger, formatXel, shorten } from "../src/format.js";

// Numbers are shown in the viewer's language (1,234 or 1 234), so expectations are built the same way.
const n = (value, options) => value.toLocaleString(undefined, options);
const sep = n(0.5).charAt(1); // the decimal separator

test("missing values show a dash, everywhere", () => {
  for (const f of [formatHashrate, formatCompact, formatInteger, formatXel, formatDuration, formatDiskBytes, formatBytes]) {
    assert.equal(f(null), "—", f.name);
    assert.equal(f(undefined), "—", f.name);
  }
});

test("hashrate climbs through H, KH, MH, GH, TH", () => {
  assert.equal(formatHashrate(0), "0 H/s");
  assert.equal(formatHashrate(999), `${n(999)} H/s`);
  assert.equal(formatHashrate(8700), `${n(8.7)} KH/s`);
  assert.equal(formatHashrate("12500000"), `${n(12.5)} MH/s`);
  assert.equal(formatHashrate(2_500_000_000_000), `${n(2.5)} TH/s`);
  assert.match(formatHashrate(5e15), /TH\/s$/, "there is nothing above TH");
});

test("compact numbers use K, M, G, T, P", () => {
  assert.equal(formatCompact(0), "0");
  assert.equal(formatCompact(999), "999");
  assert.equal(formatCompact(10_000), "10K");
  assert.equal(formatCompact(1_500_000), `${n(1.5)}M`);
  assert.equal(formatCompact("2000000000"), "2G");
});

test("XEL amounts are exact, from atomic units, with no trailing zeros", () => {
  assert.equal(formatXel("100000000"), "1 XEL");
  assert.equal(formatXel("150000000"), `1${sep}5 XEL`);
  assert.equal(formatXel("1"), `0${sep}00000001 XEL`);
  assert.equal(formatXel("0"), "0 XEL");
  assert.equal(formatXel("123456789012345678"), `${n(1234567890)}${sep}12345678 XEL`);
});

test("durations switch units at sensible points", () => {
  assert.equal(formatDuration(45), "45 s");
  assert.equal(formatDuration(89), "89 s");
  assert.equal(formatDuration(120), "2 min");
  assert.equal(formatDuration(3 * 3600), "3.0 h");
  assert.equal(formatDuration(3 * 86400), "3.0 days");
});

test("'ago' counts minutes, hours and days, and never goes negative", () => {
  const ago = (seconds) => new Date(Date.now() - seconds * 1000).toISOString();
  assert.equal(formatAgo(ago(5)), "just now");
  assert.equal(formatAgo(ago(-500)), "just now", "a clock slightly ahead");
  assert.equal(formatAgo(ago(5 * 60 + 1)), "5 min ago");
  assert.equal(formatAgo(ago(3 * 3600 + 1)), "3 h ago");
  assert.equal(formatAgo(ago(86400 + 1)), "1 day ago");
  assert.equal(formatAgo(ago(5 * 86400 + 1)), "5 days ago");
});

test("long values are shortened in the middle, short ones are left alone", () => {
  assert.equal(shorten("abcdef"), "abcdef");
  assert.equal(shorten("a".repeat(17)), "a".repeat(17));
  assert.equal(shorten("0123456789abcdefghij"), "01234567…cdefghij");
  assert.equal(shorten("0123456789", 2), "01…89");
});

test("chart bucket names, effort, and integers", () => {
  assert.equal(formatBucket(300), "5-minute");
  assert.equal(formatBucket(3600), "1-hour");
  assert.equal(formatBucket(7200), "2-hour");
  assert.equal(formatBucket(86400), "1-day");
  assert.equal(formatEffort(0.0512), `${(5.12).toFixed(1)}%`);
  assert.equal(formatEffort(1), "100%");
  assert.equal(formatEffort(2.5), "250%");
  assert.equal(formatInteger("1234567"), n(1234567));
});

test("disk sizes: the operating system's 1024s for space, decimal for downloads", () => {
  assert.equal(formatDiskBytes(0), "0 B");
  assert.equal(formatDiskBytes(1023), `${n(1023)} B`);
  assert.equal(formatDiskBytes(1024 ** 3), "1 GB");
  assert.equal(formatDiskBytes(201 * 1024 ** 3), `${n(201)} GB`);
  assert.equal(formatDiskBytes(1.5 * 1024 ** 4), `${n(1.5)} TB`);
  assert.equal(formatBytes(1000), "1 KB");
  assert.equal(formatBytes(9_200_000_000), `${n(9.2, { maximumFractionDigits: 1 })} GB`);
});
