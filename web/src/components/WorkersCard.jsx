import { useState } from "react";
import { AdminUnlock, useAdminToken } from "./AdminUnlock.jsx";
import { Card, WorkersTable } from "./ui.jsx";
import { useOperatorView } from "../server-mode.js";

/**
 * A miner's workers. Workers without shares for 7 days drop off by themselves; "Remove workers"
 * hides one now (it comes back if it mines again). Removing needs the admin token.
 * `summary` sits between the title and the table (the Miners page puts the address's figures there).
 * @param {{ address: string, workers: any[] | undefined, onChanged: () => void, title?: React.ReactNode, subtitle?: string, summary?: React.ReactNode }} props
 */
export default function WorkersCard({ address, workers, onChanged, title = "Workers", subtitle = "Workers without shares for 7 days are left out.", summary }) {
  // Removing workers is node administration: the operator's view only.
  const operator = useOperatorView();
  const admin = useAdminToken();
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState(/** @type {string | null} */ (null));

  /** @param {string} name */
  async function remove(name) {
    if (!window.confirm(`Remove ${name} from the list? Its history is kept, and it comes back if it mines again.`)) return;
    setError(null);
    const response = await fetch("/api/v1/node/workers/hide", {
      method: "POST",
      headers: { "x-admin-token": admin.token, "content-type": "application/json" },
      body: JSON.stringify({ address, name }),
    });
    if (response.status === 401) admin.forget();
    if (!response.ok) setError((await response.json().catch(() => ({}))).error ?? `HTTP ${response.status}`);
    onChanged();
  }

  return (
    <Card title={title} subtitle={subtitle}
      action={operator && workers && workers.length > 0 && (
        <button type="button" onClick={() => setEditing((v) => !v)} className="btn btn-sm">
          {editing ? "Done" : "Remove workers"}
        </button>
      )}>
      {summary}
      {editing && !admin.token && <div className="mb-3"><AdminUnlock actionsEnabled admin={admin} /></div>}
      {workers && <WorkersTable workers={workers} address={address} onRemove={editing && admin.token ? (name) => void remove(name) : undefined} />}
      {error && <p className="mt-2 text-sm text-danger">{error}</p>}
    </Card>
  );
}
