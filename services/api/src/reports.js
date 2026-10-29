// The weekly and monthly reports (alerts.js sends them): for the calendar week (Monday to Monday) or month just ended, in UTC, each rig
// that mined: its on-time, hashrate while on, rejected shares, blocks expected against found and the rewards found; and, where its
// power draw is set (power.json, from the dashboard), the electricity it used, its cost, and the profit on the reward its work was
// expected to find, at today's reward and XEL price, as the Electricity card shows it.
import { readFile } from "node:fs/promises";
import { getActivity } from "./activity.js";

export const REPORT_PERIODS = /** @type {const} */ (["weekly", "monthly"]);
const DAY_MS = 86_400_000;
/** At most this many rigs are in one report (the busiest); the totals cover them all. */
const MAX_RIGS = 50;
/** Discord takes 2,000 characters a message: the rig lines that fit, then how many more. */
const MAX_TEXT = 1_900;
const ATOMIC_PER_XEL = 1e8;

/**
 * One rig in a report. kWh, cost, the expected reward's value and profit are null without a power draw, a price or an XEL price.
 * @typedef {{ address: string, worker: string, onMinutes: number, dutyCycle: number | null, hashrateWhileOn: number | null,
 *   accepted: number, rejected: number, rejectedPercent: number, expectedBlocks: number, foundBlocks: number, rewardAtomic: string,
 *   watts: number | null, kwh: number | null, cost: number | null, expectedValue: number | null, profit: number | null }} ReportRig
 */

/**
 * The last whole week or month before `now`, in UTC: weeks run Monday 00:00 to Monday 00:00.
 * @param {"weekly" | "monthly"} period @param {Date} now
 */
export function lastPeriod(period, now) {
  const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  if (period === "weekly") {
    const daysSinceMonday = (now.getUTCDay() + 6) % 7;
    const to = new Date(midnight - daysSinceMonday * DAY_MS);
    const from = new Date(to.getTime() - 7 * DAY_MS);
    return { period, from, to, key: `weekly:${from.toISOString().slice(0, 10)}` };
  }
  const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const from = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth() - 1, 1));
  return { period, from, to, key: `monthly:${from.toISOString().slice(0, 7)}` };
}

/** The electricity settings saved from the dashboard, or none. @param {string} file */
export async function readPower(file) {
  try {
    const saved = JSON.parse(await readFile(file, "utf8"));
    return {
      currency: typeof saved.currency === "string" ? saved.currency : null,
      pricePerKwh: Number.isFinite(saved.pricePerKwh) ? saved.pricePerKwh : null,
      watts: saved.watts && typeof saved.watts === "object" ? /** @type {Record<string, number>} */ (saved.watts) : {},
    };
  } catch {
    return { currency: null, pricePerKwh: null, watts: {} };
  }
}

/** @param {number} minutes */
function duration(minutes) {
  const d = Math.floor(minutes / 1440);
  const h = Math.round((minutes % 1440) / 60);
  return d > 0 ? `${d} d ${h} h` : `${h} h`;
}

/** @param {number | null} hs */
function hashrate(hs) {
  if (hs === null) return "—";
  const units = ["H/s", "kH/s", "MH/s", "GH/s"];
  let v = hs;
  let i = 0;
  while (v >= 1000 && i < units.length - 1) { v /= 1000; i++; }
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`;
}

/** @param {number} n */
const blocks = (n) => String(Number(n >= 1 ? n.toFixed(2) : n.toPrecision(2)));
/** @param {number} value @param {string} currency */
const money = (value, currency) => `${value.toFixed(2)} ${currency.toUpperCase()}`;
/** @param {string} address */
const short = (address) => (address.length > 24 ? `${address.slice(0, 12)}…${address.slice(-6)}` : address);
/** @param {Date} d */
const day = (d) => d.toISOString().slice(0, 10);

/**
 * The report for one period: every rig that sent shares in it, busiest first.
 * @param {import("pg").Pool} pool
 * @param {{ period: "weekly" | "monthly", from: Date, to: Date, power: Awaited<ReturnType<typeof readPower>>,
 *   rewardAtomic: number | null, xelPrice: number | null, coin: string }} options
 *   rewardAtomic: the reward per block now; xelPrice: one XEL in the electricity's currency (null without a price)
 */
export async function buildReport(pool, { period, from, to, power, rewardAtomic, xelPrice, coin }) {
  const minutes = Math.round((to.getTime() - from.getTime()) / 60_000);
  const [shares, found] = await Promise.all([
    pool.query(
      `SELECT m.address, w.name, sum(s.accepted)::bigint::text AS accepted, sum(s.rejected)::bigint::text AS rejected
       FROM worker_stats_1m s JOIN workers w ON w.id = s.worker_id JOIN miners m ON m.id = w.miner_id
       WHERE s.bucket >= $1 AND s.bucket < $2
       GROUP BY m.address, w.name
       HAVING sum(s.accepted) + sum(s.rejected) > 0
       ORDER BY sum(s.sum_difficulty) DESC`,
      [from, to],
    ),
    pool.query(
      `SELECT m.address, w.name, count(*)::int AS blocks, COALESCE(sum(b.reward), 0)::text AS reward
       FROM blocks b JOIN workers w ON w.id = b.worker_id JOIN miners m ON m.id = w.miner_id
       WHERE b.found_at >= $1 AND b.found_at < $2 AND b.status <> 'rejected'
       GROUP BY m.address, w.name`,
      [from, to],
    ),
  ]);
  const foundBy = new Map(found.rows.map((r) => [`${r.address}/${r.name}`, r]));
  /** @type {ReportRig[]} */
  const rigs = [];
  for (const row of shares.rows.slice(0, MAX_RIGS)) {
    const key = `${row.address}/${row.name}`;
    const a = await getActivity(pool, { address: row.address, worker: row.name, now: to, minutes });
    const accepted = Number(row.accepted);
    const rejected = Number(row.rejected);
    const watts = Number(power.watts[key]) || null;
    const kwh = watts === null ? null : (watts * a.onMinutes) / 60 / 1000;
    const cost = kwh === null || power.pricePerKwh === null ? null : kwh * power.pricePerKwh;
    const expectedValue = rewardAtomic === null || xelPrice === null ? null : ((a.expectedBlocks * rewardAtomic) / ATOMIC_PER_XEL) * xelPrice;
    rigs.push({
      address: row.address, worker: row.name, onMinutes: a.onMinutes, dutyCycle: a.dutyCycle, hashrateWhileOn: a.hashrateWhileOn,
      accepted, rejected, rejectedPercent: accepted + rejected > 0 ? Math.round((rejected / (accepted + rejected)) * 1000) / 10 : 0,
      expectedBlocks: a.expectedBlocks, foundBlocks: foundBy.get(key)?.blocks ?? 0, rewardAtomic: foundBy.get(key)?.reward ?? "0",
      watts, kwh, cost, expectedValue, profit: cost === null || expectedValue === null ? null : expectedValue - cost,
    });
  }
  const sum = (/** @type {(r: ReportRig) => number | null} */ f) => {
    const values = rigs.map(f).filter((v) => v !== null);
    return values.length ? values.reduce((t, v) => t + /** @type {number} */ (v), 0) : null;
  };
  const totals = {
    rigs: shares.rows.length,
    foundBlocks: found.rows.reduce((t, r) => t + r.blocks, 0),
    expectedBlocks: sum((r) => r.expectedBlocks) ?? 0,
    rewardAtomic: found.rows.reduce((t, r) => t + BigInt(r.reward), 0n).toString(),
    kwh: sum((r) => r.kwh),
    cost: sum((r) => r.cost),
    // Only over the rigs with a power draw, so the profit is not set against a cost left out.
    profit: sum((r) => r.profit),
  };
  return { period, from: from.toISOString(), to: to.toISOString(), currency: power.currency, rigs, totals, text: reportText(period, from, to, rigs, totals, power.currency, coin) };
}

/**
 * @param {string} period @param {Date} from @param {Date} to @param {ReportRig[]} rigs @param {any} totals @param {string | null} currency
 * @param {string} coin
 */
function reportText(period, from, to, rigs, totals, currency, coin) {
  const last = new Date(to.getTime() - DAY_MS);
  const title = `${period === "weekly" ? "Weekly" : "Monthly"} report, ${day(from)} to ${day(last)} (UTC)`;
  if (rigs.length === 0) return `${title}: no rig sent shares.`;
  const rewards = `${(Number(BigInt(totals.rewardAtomic) / 1_000_000n) / 100).toLocaleString("en", { maximumFractionDigits: 2 })} ${coin}`;
  const lines = [
    title,
    `${totals.rigs} rig${totals.rigs === 1 ? "" : "s"} mined: ${totals.foundBlocks} block${totals.foundBlocks === 1 ? "" : "s"} found of ${blocks(totals.expectedBlocks)} expected, ${rewards} found.`,
  ];
  if (currency && totals.cost !== null) {
    lines.push(`Electricity: ${totals.kwh.toFixed(1)} kWh, ${money(totals.cost, currency)}${totals.profit !== null ? `; profit on the expected reward ${money(totals.profit, currency)}` : ""}.`);
  }
  const rigLines = rigs.map((r) => {
    const parts = [
      `on ${duration(r.onMinutes)}${r.dutyCycle !== null ? ` (${Math.round(r.dutyCycle * 100)}%)` : ""}`,
      `${hashrate(r.hashrateWhileOn)} while on`,
      `${r.rejectedPercent}% rejected`,
      `${r.foundBlocks} of ${blocks(r.expectedBlocks)} blocks`,
    ];
    if (currency && r.cost !== null) parts.push(`${money(r.cost, currency)} power`);
    return `- ${r.worker} (${short(r.address)}): ${parts.join(", ")}`;
  });
  let text = lines.join("\n");
  for (let i = 0; i < rigLines.length; i++) {
    const more = rigLines.length - i;
    if (text.length + rigLines[i].length + 30 > MAX_TEXT) {
      text += `\n…and ${more} more rig${more === 1 ? "" : "s"} (on the dashboard).`;
      break;
    }
    text += `\n${rigLines[i]}`;
  }
  return text;
}
