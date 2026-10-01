import { useState } from "react";
import { Card } from "./ui.jsx";

/**
 * Download a copy of the statistics (miners, workers, blocks, events). Needs the admin token, as the
 * file holds miner addresses and IP addresses.
 * @param {{ token: string, onUnauthorized: () => void }} props
 */
export default function BackupCard({ token, onUnauthorized }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(/** @type {{ ok: boolean, text: string } | null} */ (null));

  async function download() {
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch("/api/v1/node/backup", { headers: { "x-admin-token": token } });
      if (response.status === 401) onUnauthorized();
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error ?? `HTTP ${response.status}`);
      }
      const blob = await response.blob();
      const name = /filename="([^"]+)"/.exec(response.headers.get("content-disposition") ?? "")?.[1] ?? "xeldash.dump";
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = name;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      setMessage({ ok: true, text: `Saved ${name} (${(blob.size / 1e6).toFixed(1)} MB). Keep it private and copy it off this computer too.` });
    } catch (e) {
      setMessage({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="Backup"
      subtitle="A copy of your statistics: miners, workers, blocks and events. It does not include the blockchain, which any node can download again, and never a wallet.">
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" disabled={!token || busy} onClick={() => void download()}
          className="rounded-md bg-action px-3 py-1.5 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-40">
          {busy ? "Making the backup..." : "Download a backup"}
        </button>
        {!token && <span className="text-xs text-ink-2">Unlock above to download.</span>}
      </div>
      {message && <p role="alert" className={`mt-3 text-sm ${message.ok ? "text-good" : "text-critical"}`}>{message.text}</p>}
      <p className="mt-3 text-xs text-ink-2">
        The file holds miner addresses and IP addresses, so keep it private. To put a backup back, run{" "}
        <code className="rounded bg-wash px-1">xeldash restore FILE</code> on the computer running xelDash. Daily automatic backups are
        explained in the Operations guide.
      </p>
    </Card>
  );
}
