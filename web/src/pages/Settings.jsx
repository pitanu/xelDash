import { useEffect, useState } from "react";
import { AdminUnlock, useAdminToken } from "../components/AdminUnlock.jsx";
import DaemonSettings from "../components/DaemonSettings.jsx";
import MiningFallback from "../components/MiningFallback.jsx";
import PriceSetting from "../components/PriceSetting.jsx";
import ThemeSetting from "../components/ThemeSetting.jsx";
import { Card } from "../components/ui.jsx";

/** Everything about the node that can be changed from the dashboard, with what each does. */
export default function Settings() {
  const admin = useAdminToken();
  const [actionsEnabled, setActionsEnabled] = useState(/** @type {boolean | null} */ (null));
  const [error, setError] = useState(/** @type {string | null} */ (null));

  useEffect(() => {
    fetch("/api/v1/node/fallback")
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`))))
      .then((body) => setActionsEnabled(Boolean(body.actionsEnabled)))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  const token = actionsEnabled ? admin.token : "";
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-lg font-semibold text-ink">Settings</h1>
        <p className="text-sm text-ink-2">
          What xelDash shows, how it mines, and how your XELIS node behaves. Each setting says what it does; the defaults suit most setups.
        </p>
      </div>

      <h2 className="text-base font-semibold text-ink">Display</h2>
      <ThemeSetting />
      <PriceSetting />

      {error && <p className="text-sm text-critical">Unable to reach the node admin service ({error}).</p>}
      {actionsEnabled !== null && <AdminUnlock actionsEnabled={actionsEnabled} admin={admin} />}

      <h2 className="pt-2 text-base font-semibold text-ink">Mining</h2>
      <MiningFallback token={token} onUnauthorized={admin.forget} />

      <h2 className="pt-2 text-base font-semibold text-ink">Node</h2>
      <DaemonSettings token={token} onUnauthorized={admin.forget} />

      <Card title="Set in .env">
        <p className="text-sm text-ink-2">
          Ports, share difficulty, connection limits, alerts, backups and the node list are set in
          {" "}<code className="rounded bg-wash px-1">.env</code>, and apply after <code className="rounded bg-wash px-1">docker compose up -d</code>.
          Each is explained in <code className="rounded bg-wash px-1">.env.example</code>. Snapshots are on the
          {" "}<a href="#/node-data" className="underline decoration-line underline-offset-2 hover:text-ink">Snapshots</a> page.
        </p>
      </Card>
    </div>
  );
}
