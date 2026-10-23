import { useEffect, useState } from "react";
import { AdminUnlock, useAdminToken } from "../components/AdminUnlock.jsx";
import AlertSettings from "../components/AlertSettings.jsx";
import BackupCard from "../components/BackupCard.jsx";
import BlockSoundSetting from "../components/BlockSoundSetting.jsx";
import DaemonSettings from "../components/DaemonSettings.jsx";
import MotionSetting from "../components/MotionSetting.jsx";
import MiningFallback from "../components/MiningFallback.jsx";
import PriceSetting from "../components/PriceSetting.jsx";
import SupportCard from "../components/SupportCard.jsx";
import ThemeSetting from "../components/ThemeSetting.jsx";
import { Card, Segmented, SettingBlock } from "../components/ui.jsx";
import { AutoUpdateSetting } from "../components/UpgradeCard.jsx";
import { AddressForm } from "./Setup.jsx";
import { usePolled } from "../api.js";
import { useNodes } from "../nodes.js";

/** Light, dark or system, and the colour theme: this browser's, never the server's. */
function Appearance() {
  return (
    <Card title="Appearance" subtitle="Saved in this browser only.">
      <ThemeSetting />
    </Card>
  );
}

/**
 * On a public server's public view, only what each visitor chooses for their own browser: no node administration is asked anything.
 */
function VisitorSettings() {
  return (
    <div className="space-y-5">
      <div className="page-head">
        <div><h1>Settings</h1><p>How this dashboard looks and sounds for you. Saved in this browser only.</p></div>
      </div>
      <Appearance />
      <MotionSetting />
      <BlockSoundSetting visitor />
    </div>
  );
}

/** @param {{ publicView?: boolean }} props */
export default function Settings({ publicView = false }) {
  return publicView ? <VisitorSettings /> : <OperatorSettings />;
}

/** Everything about the node that can be changed from the dashboard, with what each does. */
function OperatorSettings() {
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
  const managed = useNodes();
  const network = usePolled("/api/v1/status").data?.node?.network;
  const nodeIds = managed?.nodes.map((n) => n.id) ?? ["daemon"];
  const [node, setNode] = useState("daemon");
  const connect = usePolled("/api/v1/connect", { intervalMs: 5 * 60_000 });
  return (
    <div className="flex flex-col gap-5">
      <div className="page-head">
        <div>
          <h1>Settings</h1>
          <p>Saved on this server, except Appearance, prices, sound and animations, which are saved in this browser. Each setting says what it does; the defaults suit most setups.</p>
        </div>
      </div>

      {error && <p className="text-sm text-danger">Unable to reach the node admin service ({error}).</p>}
      {actionsEnabled !== null && <AdminUnlock actionsEnabled={actionsEnabled} admin={admin} />}

      <Appearance />

      <section className="card pad">
        <h2 className="mb-1 text-base font-semibold text-ink">Mining</h2>
        <div className="settings-row">
          <div className="txt"><b>Default payout address</b><span>Used by miners that connect without an address, checked by your node before it is saved.</span></div>
          <div className="min-w-0 basis-full">
            <AddressForm current={connect.data?.address ?? null} network={connect.data?.network ?? network ?? "mainnet"} onSaved={connect.reload} />
          </div>
        </div>
        <MiningFallback row token={token} onUnauthorized={admin.forget} />
        <div className="settings-row block!">
          <AutoUpdateSetting token={token} locked={!token} onUnauthorized={admin.forget} />
        </div>
      </section>

      <section className="card pad">
        <h2 className="mb-1 text-base font-semibold text-ink">Notifications and display</h2>
        <BlockSoundSetting row />
        <SettingBlock row title="Alerts" subtitle="Discord, Telegram or a webhook: blocks found, mining paused, workers offline, node updates, low disk."
          aside={<button type="button" className="btn" onClick={() => document.getElementById("alerts")?.scrollIntoView({ behavior: "smooth", block: "start" })}>Set up alerts</button>} />
        <PriceSetting row />
        <MotionSetting row />
      </section>

      <div id="alerts" className="scroll-mt-24">
        <AlertSettings token={token} onUnauthorized={admin.forget} />
      </div>

      <BackupCard token={token} onUnauthorized={admin.forget} />

      <div className="flex flex-wrap items-center justify-between gap-3 pt-2">
        <h2 className="text-base font-semibold text-ink">Node</h2>
        {nodeIds.length > 1 && <Segmented label="Node" value={node} options={nodeIds} onChange={setNode} />}
      </div>
      {nodeIds.length > 1 && (
        <p className="-mt-3 text-xs text-ink-2">Each node has its own settings. Change them one node at a time, so the other keeps mining.</p>
      )}
      <DaemonSettings key={node} node={node} token={token} onUnauthorized={admin.forget} />

      <SupportCard network={network} />

      <Card title="Set in .env">
        <p className="text-sm text-ink-2">
          Ports, share difficulty, connection limits, backups and the node list are set in
          {" "}<code className="rounded bg-wash px-1">.env</code>, and apply after <code className="rounded bg-wash px-1">docker compose up -d</code>.
          Each is explained in <code className="rounded bg-wash px-1">.env.example</code>. Restarting nodes, copying chain data and snapshots are on the
          {" "}<a href="#/nodes" className="underline decoration-line underline-offset-2 hover:text-ink">Nodes</a> page.
        </p>
      </Card>
    </div>
  );
}
