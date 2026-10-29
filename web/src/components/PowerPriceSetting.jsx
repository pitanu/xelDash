import { useEffect, useState } from "react";
import { usePolled } from "../api.js";
import { CURRENCY_NAMES } from "../price.js";
import { SettingBlock } from "./ui.jsx";

/**
 * The price of a kilowatt-hour, for each rig's electricity cost and profit (PowerCard.jsx; the power draw is entered on each
 * worker's page). Saved on this server, for the reports too.
 * @param {{ token: string, onUnauthorized: () => void, row?: boolean }} props
 */
export default function PowerPriceSetting({ token, onUnauthorized, row = false }) {
  const power = usePolled("/api/v1/node/power");
  const p = /** @type {{ available: boolean, currency: string | null, pricePerKwh: number | null, currencies: string[], actionsEnabled: boolean } | null} */ (power.data);
  const [currency, setCurrency] = useState("eur");
  const [price, setPrice] = useState("");
  const [error, setError] = useState(/** @type {string | null} */ (null));
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!p) return;
    if (p.currency) setCurrency(p.currency);
    setPrice(p.pricePerKwh === null ? "" : String(p.pricePerKwh));
  }, [p]);

  /** @param {number | null} next */
  async function save(next) {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/v1/node/power", {
        method: "PUT", headers: { "x-admin-token": token, "content-type": "application/json" }, body: JSON.stringify({ currency, pricePerKwh: next }),
      });
      const body = await response.json().catch(() => ({}));
      if (response.status === 401) onUnauthorized();
      if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
      power.reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  if (!p?.available) return null;
  const locked = !p.actionsEnabled || !token;
  return (
    <SettingBlock row={row} title="Electricity price"
      subtitle="For each rig's power cost and profit, beside its on-time. Enter each rig's power draw on its own page. Saved on this server.">
      <form className="flex flex-wrap items-end gap-3" onSubmit={(e) => { e.preventDefault(); void save(Number(price)); }}>
        <label className="text-sm">
          <span className="label block">Price per kWh</span>
          <input type="number" min="0" step="any" inputMode="decimal" value={price} disabled={locked} onChange={(e) => setPrice(e.target.value)}
            className="field mt-1 w-32" aria-label="Price per kWh" />
        </label>
        <label className="text-sm">
          <span className="label block">Currency</span>
          <select value={currency} disabled={locked} onChange={(e) => setCurrency(e.target.value)} aria-label="Electricity currency" className="field mt-1 w-48">
            {p.currencies.map((c) => <option key={c} value={c}>{CURRENCY_NAMES[c] ?? c.toUpperCase()}</option>)}
          </select>
        </label>
        <button type="submit" className="btn btn-sm btn-primary" disabled={locked || busy || price === ""}>Save</button>
        {p.pricePerKwh !== null && <button type="button" className="btn btn-sm" disabled={locked || busy} onClick={() => void save(null)}>Remove</button>}
      </form>
      {locked && <p className="mt-2 text-xs text-ink-2">Unlock with the admin token above to change it.</p>}
      {error && <p role="alert" className="mt-2 text-sm text-danger">{error}</p>}
    </SettingBlock>
  );
}
