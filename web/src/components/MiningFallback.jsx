import { useCallback, useEffect, useState } from "react";
import { SettingBlock, Switch } from "./ui.jsx";

/**
 * Switch for mining through the official public XELIS node while none of our own nodes can
 * issue work. Stratum picks the change up within a few seconds; nothing restarts.
 * @param {{ token: string, onUnauthorized: () => void, row?: boolean }} props
 */
export default function MiningFallback({ token, onUnauthorized, row = false }) {
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
      setData((/** @type {any} */ d) => ({ ...d, ...body }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  if (!data) return null;
  if (!data.available) {
    return (
      <SettingBlock row={row} title="Fall back to the public node">
        <p className="text-[13px] text-ink-2">
          {data.publicMode
            ? "This is a public server: it never mines through the official node, so its miners' load cannot reach the XELIS team's public node."
            : "The XELIS team runs public nodes for mainnet and testnet only, so there is no fallback on this network."}
        </p>
      </SettingBlock>
    );
  }
  const host = new URL(data.url).host;
  const locked = !data.actionsEnabled || !token;
  return (
    <SettingBlock row={row} title="Fall back to the public node"
      subtitle={`Keep rigs mining through ${host}, the XELIS team's public node, while none of your own nodes can issue work: during a sync, an upgrade or an outage.`}
      aside={<Switch checked={Boolean(data.enabled)} disabled={locked || busy} label="Fall back to the public node" onChange={(next) => void toggle(next)} />}>
      <div className="space-y-2">
        {locked && <p className="label">{data.actionsEnabled ? "Unlock changes (above) to switch it." : "Changes from the dashboard are off on this server."}</p>}
        <p className="text-xs text-ink-2">
          Your own nodes always come first; mining moves back to them as soon as one is in sync. Block rewards still go to
          each miner's address. While the fallback is in use, block templates come from a server you do not run, over the
          internet, so a few more shares may arrive late.
        </p>
        {error && <p className="text-sm text-danger">{error}</p>}
      </div>
    </SettingBlock>
  );
}
