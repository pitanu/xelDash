import { useCallback, useEffect, useState } from "react";
import { Card, HealthBadge } from "./ui.jsx";

/**
 * Switch for mining through the official public XELIS node while none of our own nodes can
 * issue work. Stratum picks the change up within a few seconds; nothing restarts.
 * @param {{ token: string, onUnauthorized: () => void }} props
 */
export default function MiningFallback({ token, onUnauthorized }) {
  const [data, setData] = useState(/** @type {any} */ (null));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(/** @type {string | null} */ (null));

  const load = useCallback(async () => {
    const response = await fetch("/api/v1/node/fallback");
    if (response.ok) setData(await response.json());
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /** @param {boolean} enabled */
  async function toggle(enabled) {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/v1/node/fallback", {
        method: "PUT",
        headers: { "x-admin-token": token, "content-type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      const body = await response.json().catch(() => ({}));
      if (response.status === 401) onUnauthorized();
      if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
      setData((d) => ({ ...d, ...body }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  if (!data?.available) return null;
  const host = new URL(data.url).host;
  const locked = !data.actionsEnabled || !token;
  return (
    <Card title="Official node fallback"
      subtitle={`Keep mining through ${host}, the XELIS team's public node, while none of your own nodes can issue work: during a sync, an upgrade or an outage.`}>
      <div className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <HealthBadge level={data.enabled ? "good" : "unknown"} label={data.enabled ? "On" : "Off"} />
          <button type="button" disabled={locked || busy} onClick={() => void toggle(!data.enabled)}
            className={data.enabled
              ? "rounded-md border border-line px-3 py-1.5 text-sm text-ink hover:bg-wash disabled:opacity-40"
              : "rounded-md bg-series-1 px-3 py-1.5 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-40"}>
            {data.enabled ? "Turn off" : "Turn on"}
          </button>
        </div>
        <p className="text-xs text-ink-2">
          Your own nodes always come first; mining moves back to them as soon as one is in sync. Block rewards still go to
          each miner's address. While the fallback is in use, block templates come from a server you do not run, over the
          internet, so a few more shares may arrive late.
        </p>
        {error && <p className="text-sm text-critical">{error}</p>}
      </div>
    </Card>
  );
}
