import { useEffect, useState } from "react";
import { usePolled } from "../api.js";
import { formatDuration } from "../activity.js";
import { powerFigures } from "../power.js";
import { formatMoney } from "../price.js";
import { useOperatorView } from "../server-mode.js";
import { AdminUnlock, useAdminToken } from "./AdminUnlock.jsx";
import { Card, Segmented } from "./ui.jsx";

const RANGES = /** @type {const} */ ([["24h", "24 h"], ["7d", "7 d"], ["30d", "30 d"], ["90d", "90 d"]]);

/**
 * @typedef {{ available: boolean, currency: string | null, pricePerKwh: number | null, watts: Record<string, number>, actionsEnabled: boolean }} Power
 * @typedef {{ onMinutes: number, expectedBlocks: number }} RigActivity
 */

/** Each rig's on-time over the range, fetched together. @param {string} address @param {string[]} rigs @param {string} range */
function useRigActivity(address, rigs, range) {
  const [state, setState] = useState(/** @type {Record<string, RigActivity> | null} */ (null));
  const key = rigs.join("\n");
  useEffect(() => {
    if (!key) {
      setState({});
      return undefined;
    }
    let cancelled = false;
    setState(null);
    Promise.all(key.split("\n").map(async (rig) => {
      const response = await fetch(`/api/v1/activity?address=${encodeURIComponent(address)}&worker=${encodeURIComponent(rig)}&range=${range}`);
      const body = response.ok ? await response.json() : { onMinutes: 0, expectedBlocks: 0 };
      return /** @type {const} */ ([rig, { onMinutes: body.onMinutes, expectedBlocks: body.expectedBlocks }]);
    })).then((rows) => { if (!cancelled) setState(Object.fromEntries(rows)); }).catch(() => { if (!cancelled) setState({}); });
    return () => { cancelled = true; };
  }, [address, key, range]);
  return state;
}

/** One XEL in the electricity's currency, or null (no price on this network, or the server has the price off). @param {string | null} currency */
function useXelPrice(currency) {
  const [price, setPrice] = useState(/** @type {number | null} */ (null));
  useEffect(() => {
    if (!currency) return undefined;
    let cancelled = false;
    fetch(`/api/v1/price?currency=${encodeURIComponent(currency)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((body) => { if (!cancelled) setPrice(typeof body?.price?.price === "number" ? body.price.price : null); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [currency]);
  return price;
}

/**
 * Electricity: what each rig's mining cost in power and what its work was expected to earn, over the range. On a worker's page
 * (`worker`) its power draw is entered here; on a miner's page every rig of the address with a power draw is listed, with a total.
 * The operator's only: a public server's rigs are other people's.
 * @param {{ address: string, worker?: string }} props
 */
export default function PowerCard({ address, worker }) {
  const operator = useOperatorView();
  const power = usePolled(operator ? "/api/v1/node/power" : null);
  const overview = usePolled(operator ? "/api/v1/overview" : null);
  const [range, setRange] = useState(/** @type {string} */ ("7d"));
  const p = /** @type {Power | null} */ (power.data);
  const prefix = `${address}/`;
  const rigs = worker ? [worker] : Object.keys(p?.watts ?? {}).filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length)).sort();
  const activity = useRigActivity(address, p && rigs.every((r) => p.watts[`${prefix}${r}`]) ? rigs : [], range);
  const xelPrice = useXelPrice(p?.currency ?? null);
  if (!operator || !p?.available) return null;

  const rewardAtomic = Number(overview.data?.node?.miner_reward) || null;
  const money = (/** @type {number | null} */ v) => (v === null || !p.currency ? "—" : formatMoney(v, p.currency, "amount"));
  const rows = rigs.filter((r) => p.watts[`${prefix}${r}`] && activity?.[r]).map((r) => ({
    rig: r, watts: p.watts[`${prefix}${r}`], on: activity?.[r].onMinutes ?? 0,
    ...powerFigures({ ...(/** @type {RigActivity} */ (activity?.[r])), watts: p.watts[`${prefix}${r}`], pricePerKwh: p.pricePerKwh, rewardAtomic, xelPrice }),
  }));
  const sum = (/** @type {"kwh" | "cost" | "value" | "profit"} */ k) => (rows.some((r) => r[k] === null) ? null : rows.reduce((t, r) => t + /** @type {number} */ (r[k]), 0));
  const single = worker ? rows[0] : null;

  return (
    <Card title="Electricity" subtitle="Power used while mining, its cost, and what the work was expected to earn at today's reward and XEL price."
      action={<Segmented label="Range" value={range} options={RANGES} onChange={setRange} />}>
      {p.pricePerKwh === null && (
        <p className="mb-3 text-sm text-ink-2">Set the price of electricity in <a href="#/settings">Settings</a> to see the cost.</p>
      )}
      {worker && <WattsEditor address={address} worker={worker} watts={p.watts[`${prefix}${worker}`] ?? null} actionsEnabled={p.actionsEnabled} onSaved={power.reload} />}
      {!worker && rigs.length === 0 && (
        <p className="text-sm text-ink-2">Enter each rig&apos;s power draw on its own page (open it from Workers below) to see its cost here.</p>
      )}
      {single && (
        <div className="mt-4 grid grid-cols-2 gap-4 lg:grid-cols-4">
          <Figure label="Energy" value={`${single.kwh.toLocaleString(undefined, { maximumFractionDigits: 1 })} kWh`} detail={`${formatDuration(single.on)} on at ${single.watts} W`} />
          <Figure label="Cost" value={money(single.cost)} detail={single.perHour?.cost != null ? `${money(single.perHour.cost)} an hour on` : undefined} />
          <Figure label="Expected reward" value={money(single.value)}
            detail={single.rewardXel !== null ? `${single.rewardXel.toLocaleString(undefined, { maximumSignificantDigits: 3 })} XEL` : undefined} />
          <Figure label="Profit" value={money(single.profit)}
            detail={single.breakEvenPrice !== null ? `Breaks even at ${money(single.breakEvenPrice)} per XEL` : undefined} />
        </div>
      )}
      {!worker && rows.length > 0 && (
        <div className="overflow-x-auto">
          <table className="tbl">
            <thead><tr><th>Rig</th><th className="r">Power</th><th className="r">On</th><th className="r">Energy</th><th className="r">Cost</th><th className="r">Expected reward</th><th className="r">Profit</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.rig}>
                  <td><a href={`#/miner/${address}/worker/${encodeURIComponent(r.rig)}`}>{r.rig}</a></td>
                  <td className="mono r">{r.watts} W</td>
                  <td className="mono r">{formatDuration(r.on)}</td>
                  <td className="mono r">{r.kwh.toLocaleString(undefined, { maximumFractionDigits: 1 })} kWh</td>
                  <td className="mono r">{money(r.cost)}</td>
                  <td className="mono r">{money(r.value)}</td>
                  <td className="mono r">{money(r.profit)}</td>
                </tr>
              ))}
              {rows.length > 1 && (
                <tr className="font-medium">
                  <td>All</td><td /><td />
                  <td className="mono r">{(sum("kwh") ?? 0).toLocaleString(undefined, { maximumFractionDigits: 1 })} kWh</td>
                  <td className="mono r">{money(sum("cost"))}</td>
                  <td className="mono r">{money(sum("value"))}</td>
                  <td className="mono r">{money(sum("profit"))}</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
      {(rows.length > 0) && p.pricePerKwh !== null && xelPrice === null && (
        <p className="label mt-3">No XEL price here (only mainnet has one, and the server may have it off), so the reward has no value to set against the cost.</p>
      )}
      {rows.length > 0 && <p className="label mt-3">Expected reward: the blocks this work was expected to find, so luck does not move it; the blocks actually found are under On-time.</p>}
    </Card>
  );
}

/** @param {{ label: string, value: string, detail?: string }} props */
function Figure({ label, value, detail }) {
  return (
    <div>
      <div className="label">{label}</div>
      <div className="mono mt-1 text-xl font-medium text-ink">{value}</div>
      {detail && <div className="label mt-0.5">{detail}</div>}
    </div>
  );
}

/**
 * This rig's power draw, as a wall meter shows it: entered with the admin token.
 * @param {{ address: string, worker: string, watts: number | null, actionsEnabled: boolean, onSaved: () => void }} props
 */
function WattsEditor({ address, worker, watts, actionsEnabled, onSaved }) {
  const admin = useAdminToken();
  const [value, setValue] = useState(watts === null ? "" : String(watts));
  const [error, setError] = useState(/** @type {string | null} */ (null));
  const [busy, setBusy] = useState(false);
  useEffect(() => { setValue(watts === null ? "" : String(watts)); }, [watts]);

  /** @param {number | null} next */
  async function save(next) {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/v1/node/power/worker", {
        method: "PUT", headers: { "x-admin-token": admin.token, "content-type": "application/json" }, body: JSON.stringify({ address, worker, watts: next }),
      });
      const body = await response.json().catch(() => ({}));
      if (response.status === 401) admin.forget();
      if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  if (!admin.token) {
    return (
      <div>
        <p className="mb-2 text-sm text-ink-2">{watts === null ? "No power draw entered for this rig yet." : `Power draw: ${watts} W.`} Unlock to change it.</p>
        <AdminUnlock actionsEnabled={actionsEnabled} admin={admin} />
      </div>
    );
  }
  return (
    <form className="flex flex-wrap items-end gap-3" onSubmit={(e) => { e.preventDefault(); void save(Number(value)); }}>
      <label className="text-sm">
        <span className="label block">Power draw (watts, at the wall)</span>
        <input type="number" min="1" step="any" inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} className="field mt-1 w-32" aria-label="Power draw in watts" />
      </label>
      <button type="submit" className="btn btn-sm btn-primary" disabled={busy || value === ""}>Save</button>
      {watts !== null && <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void save(null)}>Remove</button>}
      {error && <p role="alert" className="w-full text-sm text-danger">{error}</p>}
    </form>
  );
}
