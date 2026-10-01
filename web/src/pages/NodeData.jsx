import { useCallback, useEffect, useRef, useState } from "react";
import { AdminUnlock, useAdminToken } from "../components/AdminUnlock.jsx";
import { Card, HealthBadge, Segmented } from "../components/ui.jsx";
import { nodeQuery, useNodes } from "../nodes.js";
import UpgradeCard from "../components/UpgradeCard.jsx";
import { formatAgo, formatBytes, formatDiskBytes, formatTime } from "../format.js";

/** Snapshot service status of one node, polled every second while something is running. @param {string} node */
function useSnapshotStatus(node) {
  const [status, setStatus] = useState(/** @type {any} */ (null));
  const [error, setError] = useState(/** @type {string | null} */ (null));
  const load = useCallback(async () => {
    try {
      const response = await fetch(`/api/v1/node/snapshot/status${nodeQuery(node)}`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      setStatus(await response.json());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [node]);
  const busy = status && ["downloading", "uploading", "verifying", "extracting", "copying"].includes(status.state.phase);
  useEffect(() => {
    void load();
    const timer = setInterval(load, busy ? 1_000 : 10_000);
    return () => clearInterval(timer);
  }, [load, busy]);
  return { status, error, reload: load, busy };
}

/** @param {{ bytes: number, total: number | null }} props */
function Progress({ bytes, total }) {
  const pct = total ? Math.min(100, (bytes / total) * 100) : null;
  return (
    <div>
      <div className="h-2 w-full overflow-hidden rounded-full bg-series-1/15" role="progressbar"
        aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct === null ? undefined : Math.round(pct)}>
        <div className={`h-full rounded-full bg-series-1 transition-[width] ${pct === null ? "w-1/3 animate-pulse" : ""}`}
          style={pct === null ? undefined : { width: `${pct}%` }} />
      </div>
      <div className="mt-1 text-xs text-ink-2 tabular">
        {formatBytes(bytes)}{total ? ` of ${formatBytes(total)} · ${pct?.toFixed(1)}%` : ""}
      </div>
    </div>
  );
}

const PHASE_LABELS = {
  idle: "Idle",
  downloading: "Downloading",
  uploading: "Receiving upload",
  verifying: "Checking the checksum",
  extracting: "Unpacking",
  copying: "Copying from the other node",
  ready: "Ready to switch",
  error: "Failed",
};

/** @param {{ className?: string, children: React.ReactNode, onClick: () => void, disabled?: boolean, primary?: boolean }} props */
function Button({ children, onClick, disabled = false, primary = false, className = "" }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled}
      className={`rounded-md px-3 py-1.5 text-sm disabled:opacity-40 ${primary
        ? "bg-action font-semibold text-white hover:opacity-90"
        : "border border-line text-ink hover:bg-wash"} ${className}`}>
      {children}
    </button>
  );
}

/**
 * Snapshots for one node: download, upload, switch and roll back.
 * @param {{ node: string, admin: ReturnType<typeof useAdminToken> }} props
 */
function SnapshotsPanel({ node, admin }) {
  const { status, error, reload, busy } = useSnapshotStatus(node);
  const { token, forget: forgetToken } = admin;
  const [actionError, setActionError] = useState(/** @type {string | null} */ (null));
  const [pending, setPending] = useState(/** @type {File | null} */ (null));
  const [upload, setUpload] = useState(/** @type {{ bytes: number, total: number } | null} */ (null));
  const [dragging, setDragging] = useState(false);
  const input = useRef(/** @type {HTMLInputElement | null} */ (null));
  const xhr = useRef(/** @type {XMLHttpRequest | null} */ (null));

  /** @param {string} path */
  async function action(path) {
    setActionError(null);
    const response = await fetch(`/api/v1/node/snapshot/${path}${nodeQuery(node)}`, { method: "POST", headers: { "x-admin-token": token } });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      if (response.status === 401) forgetToken();
      setActionError(body.error ?? `HTTP ${response.status}`);
    }
    await reload();
  }

  /** @param {File | undefined} file */
  function choose(file) {
    setActionError(null);
    if (!file) return;
    if (!file.name.toLowerCase().endsWith(".zip")) {
      setActionError("Choose a .zip snapshot (for example mainnet.zip).");
      return;
    }
    setPending(file);
  }

  function startUpload() {
    const file = pending;
    if (!file) return;
    setPending(null);
    setUpload({ bytes: 0, total: file.size });
    const request = new XMLHttpRequest();
    xhr.current = request;
    request.open("PUT", `/api/v1/node/snapshot/upload${nodeQuery(node)}`);
    request.setRequestHeader("x-admin-token", token);
    request.setRequestHeader("content-type", "application/zip");
    request.upload.onprogress = (event) => setUpload({ bytes: event.loaded, total: event.total || file.size });
    request.onloadend = () => {
      xhr.current = null;
      setUpload(null);
      if (request.status === 401) forgetToken();
      if (request.status && request.status >= 400) {
        try {
          setActionError(JSON.parse(request.responseText).error);
        } catch {
          setActionError(`Upload failed (HTTP ${request.status})`);
        }
      } else if (!request.status) {
        setActionError("Upload stopped before it finished.");
      }
      void reload();
    };
    request.send(file);
  }

  function cancel() {
    xhr.current?.abort();
    void action("cancel");
  }

  if (error && !status) return <p className="text-sm text-critical">Unable to reach the snapshot service ({error}).</p>;
  if (!status) return null;
  const s = status;
  const phase = s.state.phase;
  const locked = !s.actionsEnabled || !token;
  const uploading = upload !== null;

  return (
    <div className="space-y-6">
      <h2 className="pt-2 text-base font-semibold text-ink">Snapshots</h2>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <div className="min-w-0 rounded-lg border border-line bg-surface p-3 sm:p-4">
          <div className="text-xs text-ink-2">Chain data</div>
          <div className="mt-2"><HealthBadge level={s.dataPresent ? "good" : "warning"} label={s.dataPresent ? "Present" : "None yet"} /></div>
          <div className="mt-1 text-xs text-muted">{s.network}</div>
        </div>
        <div className="min-w-0 rounded-lg border border-line bg-surface p-3 sm:p-4">
          <div className="text-xs text-ink-2">Free disk space</div>
          <div className="mt-1 text-2xl font-semibold text-ink">{formatDiskBytes(s.disk.free)}</div>
          <div className="mt-1 text-xs text-muted">
            of {formatDiskBytes(s.disk.total)}
            {s.disk.source === "computer" ? " on your computer's drive" : s.disk.virtualized ? " in Docker's disk (your drive may have less)" : ""}
          </div>
        </div>
        <div className="col-span-2 min-w-0 rounded-lg border border-line bg-surface p-3 sm:p-4">
          <div className="text-xs text-ink-2">Official snapshot</div>
          {s.officialAvailable && s.official?.size ? (
            <>
              <div className="mt-1 text-2xl font-semibold text-ink">{formatBytes(s.official.size)}</div>
              <div className="mt-1 text-xs text-muted">
                Published {s.official.lastModified ? formatAgo(new Date(s.official.lastModified).toISOString()) : "—"} · updated daily by the XELIS team
              </div>
            </>
          ) : (
            <div className="mt-2 text-sm text-ink-2">
              {s.officialAvailable ? "Not reachable right now." : `None is published for ${s.network}; you can still upload one.`}
            </div>
          )}
        </div>
      </div>

      {(phase !== "idle" || uploading) && (
        <Card title={uploading ? "Uploading" : PHASE_LABELS[/** @type {keyof typeof PHASE_LABELS} */ (phase)]}
          subtitle={s.state.startedAt && phase !== "ready" ? `Started ${formatTime(s.state.startedAt)}` : undefined}
          action={(busy || uploading) && !locked ? <Button onClick={cancel}>Cancel</Button> : undefined}>
          <div className="space-y-3 text-sm">
            {uploading && <Progress bytes={upload.bytes} total={upload.total} />}
            {!uploading && busy && <Progress bytes={s.state.bytes} total={s.state.total} />}
            {phase === "error" && <p className="text-critical">{s.state.error}</p>}
            {s.state.note && <p className="text-ink-2">{s.state.note}</p>}
            {s.state.sha256 && (
              <p className="break-all text-xs text-muted">
                SHA-256 {s.state.sha256} · {s.state.checksumMatches === true
                  ? "matches the official checksum"
                  : s.state.checksumMatches === false
                    ? "does not match today's official snapshot (an older or self-made snapshot; the zip's own checks still apply)"
                    : "no official checksum to compare"}
              </p>
            )}
            {phase === "ready" && !locked && (
              <div className="flex flex-wrap gap-2">
                <Button primary onClick={() => void action("restart")}>Restart node now</Button>
                <Button onClick={() => void action("discard-staged")}>Discard</Button>
              </div>
            )}
            {phase === "ready" && (
              <p className="text-xs text-muted">
                Restarting stops the node for a moment. With a second node configured, mining continues on it;
                otherwise mining pauses until this node is back and in sync.
              </p>
            )}
          </div>
        </Card>
      )}

      {!locked && (
        <div className="grid gap-6 lg:grid-cols-2">
          <Card title="Upload a snapshot" subtitle="A zip of a node's database, such as mainnet.zip from the XELIS team or a backup of another node.">
            <div
              role="button" tabIndex={0}
              onClick={() => input.current?.click()}
              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") input.current?.click(); }}
              onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => { e.preventDefault(); setDragging(false); choose(e.dataTransfer.files[0]); }}
              className={`flex min-h-32 cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed p-6 text-center text-sm ${
                dragging ? "border-series-1 bg-series-1/5" : "border-line hover:bg-wash"} ${busy || uploading ? "pointer-events-none opacity-40" : ""}`}>
              <span className="font-medium text-ink">Drop a snapshot .zip here</span>
              <span className="mt-1 text-xs text-ink-2">or click to choose a file</span>
              <input ref={input} type="file" accept=".zip,application/zip" className="hidden"
                onChange={(e) => { choose(e.target.files?.[0]); e.target.value = ""; }} />
            </div>
            {pending && (
              <div className="mt-3 rounded-md border border-line p-3 text-sm">
                <p className="text-ink">
                  Replace the node's {s.network} data with <span className="font-medium">{pending.name}</span> ({formatBytes(pending.size)})?
                </p>
                <p className="mt-1 text-xs text-ink-2">
                  It is checked and unpacked first; the node only switches when you restart it. The current data is kept as a
                  backup until the next switch.
                </p>
                <div className="mt-2 flex gap-2">
                  <Button primary onClick={startUpload}>Upload and check</Button>
                  <Button onClick={() => setPending(null)}>Cancel</Button>
                </div>
              </div>
            )}
          </Card>

          <Card title="Download the official snapshot"
            subtitle={s.officialAvailable ? "Straight from node.xelis.io, verified against the published checksum." : undefined}>
            {s.officialAvailable ? (
              <div className="space-y-2 text-sm">
                <p className="text-ink-2">
                  {s.official?.size ? `About ${formatBytes(s.official.size)} to download and the same again to unpack. ` : ""}
                  A stopped download resumes where it left off.
                </p>
                <Button primary disabled={busy || uploading} onClick={() => void action("download")}>Download and check</Button>
              </div>
            ) : (
              <p className="text-sm text-ink-2">The XELIS team publishes snapshots for mainnet only.</p>
            )}
            {s.auto && <p className="mt-2 text-xs text-muted">Automatic download for a new node is on (XELIS_SNAPSHOT_AUTO).</p>}
          </Card>
        </div>
      )}

      {actionError && <p className="text-sm text-critical">{actionError}</p>}

      {s.previous && (
        <Card title="Previous chain data" subtitle="Kept from before the last switch, for rolling back by hand.">
          <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
            <span className="text-ink-2">Delete it once the node runs well on the new data, to free the disk space.</span>
            {!locked && <Button onClick={() => void action("discard-previous")}>Delete previous data</Button>}
          </div>
        </Card>
      )}

    </div>
  );
}

const STATE_BADGES = {
  running: { level: /** @type {const} */ ("good"), label: "Running" },
  stopping: { level: /** @type {const} */ ("warning"), label: "Stopping…" },
  stopped: { level: /** @type {const} */ ("unknown"), label: "Stopped" },
};

/**
 * Restart, stop or start one node. Stopping keeps it stopped, across restarts of the stack,
 * until it is started again here.
 * @param {{ node: import("../nodes.js").ManagedNode, others: import("../nodes.js").ManagedNode[], token: string,
 *   locked: boolean, onUnauthorized: () => void }} props
 */
function NodeControls({ node, others, token, locked, onUnauthorized }) {
  const [error, setError] = useState(/** @type {string | null} */ (null));
  const [busy, setBusy] = useState(false);
  const badge = STATE_BADGES[node.state];
  const other = others.find((n) => n.state === "running");

  /** @param {"stop" | "start" | "restart"} action */
  async function control(action) {
    if (action === "stop" && !window.confirm(
      `Stop ${node.id}? It stays stopped until you start it here. `
      + (other ? `Mining continues on ${other.id} if it is in sync, ` : "")
      + "else through the official node fallback if it is on, else mining pauses.",
    )) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/v1/node/control/${action}${nodeQuery(node.id)}`, { method: "POST", headers: { "x-admin-token": token } });
      if (response.status === 401) onUnauthorized();
      if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error ?? `HTTP ${response.status}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title={`Node ${node.id}`} subtitle="Restart the node, or stop it for maintenance. The node's settings are on the Settings page.">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <HealthBadge level={badge.level} label={badge.label} />
        {!locked && (
          <span className="flex gap-2">
            {node.state === "running" && <Button disabled={busy} onClick={() => void control("restart")}>Restart</Button>}
            {node.state === "running"
              ? <Button disabled={busy} onClick={() => void control("stop")}>Stop</Button>
              : <Button primary disabled={busy} onClick={() => void control("start")}>Start</Button>}
          </span>
        )}
      </div>
      {error && <p className="mt-2 text-sm text-critical">{error}</p>}
    </Card>
  );
}

/**
 * Seed this node with another node's chain data, instead of syncing it from the network.
 * @param {{ node: import("../nodes.js").ManagedNode, source: import("../nodes.js").ManagedNode, token: string,
 *   locked: boolean, onUnauthorized: () => void }} props
 */
function CopyCard({ node, source, token, locked, onUnauthorized }) {
  const [error, setError] = useState(/** @type {string | null} */ (null));
  const [started, setStarted] = useState(false);

  async function copy() {
    if (!window.confirm(
      `Copy the chain data of ${source.id} into ${node.id}? ${source.id} stops while it is copied (about a minute per 10 GB), `
      + `then starts again; ${node.id} restarts with the copy and keeps its current data as a backup.`,
    )) return;
    setError(null);
    const response = await fetch(`/api/v1/node/copy${nodeQuery(node.id)}&from=${encodeURIComponent(source.id)}`, {
      method: "POST", headers: { "x-admin-token": token },
    });
    if (response.status === 401) onUnauthorized();
    if (!response.ok) setError((await response.json().catch(() => ({}))).error ?? `HTTP ${response.status}`);
    else setStarted(true);
  }

  return (
    <Card title={`Copy chain data from ${source.id}`}
      subtitle={`The quickest way to bring ${node.id} up to date: minutes instead of a full sync. Mining continues on ${node.id} meanwhile if it is in sync, else through the official node fallback if it is on.`}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-ink-2">
          {started ? "Copy started; progress shows under Snapshots below." : `${source.id} stops for the copy and starts again when it is done.`}
        </p>
        {!locked && <Button disabled={source.state !== "running" || node.phase !== "idle"} onClick={() => void copy()}>Copy from {source.id}</Button>}
      </div>
      {error && <p className="mt-2 text-sm text-critical">{error}</p>}
    </Card>
  );
}

/**
 * Old chain data kept after a snapshot or copy, for every node at once, so it is easy to
 * find and delete once the nodes run well on their new data.
 * @param {{ nodes: import("../nodes.js").ManagedNode[], token: string, locked: boolean, onUnauthorized: () => void }} props
 */
function OldDataCard({ nodes, token, locked, onUnauthorized }) {
  const [error, setError] = useState(/** @type {string | null} */ (null));
  const [deleting, setDeleting] = useState(/** @type {string | null} */ (null));
  const withOld = nodes.filter((n) => n.previousBytes > 0);
  if (withOld.length === 0) return null;
  const total = withOld.reduce((sum, n) => sum + n.previousBytes, 0);

  /** @param {string} node */
  async function remove(node) {
    if (!window.confirm(`Delete the old chain data of ${node}? It is the database from before the last snapshot or copy, kept for rolling back by hand. This cannot be undone.`)) return;
    setError(null);
    setDeleting(node);
    try {
      const response = await fetch(`/api/v1/node/snapshot/discard-previous${nodeQuery(node)}`, { method: "POST", headers: { "x-admin-token": token } });
      if (response.status === 401) onUnauthorized();
      if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error ?? `HTTP ${response.status}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setDeleting(null);
    }
  }

  return (
    <Card title="Free up disk space"
      subtitle={`${formatBytes(total)} of old chain data is kept from before the last snapshot or copy. Delete it once the node runs well on its new data.`}>
      <ul className="divide-y divide-line text-sm">
        {withOld.map((n) => (
          <li key={n.id} className="flex flex-wrap items-center justify-between gap-3 py-2">
            <span><span className="font-medium text-ink">{n.id}</span> <span className="text-ink-2">· {formatBytes(n.previousBytes)} old chain data</span></span>
            {!locked && (
              <Button disabled={deleting !== null} onClick={() => void remove(n.id)}>{deleting === n.id ? "Deleting…" : "Delete"}</Button>
            )}
          </li>
        ))}
      </ul>
      {locked && <p className="mt-2 text-xs text-muted">Unlock changes above to delete it.</p>}
      {error && <p className="mt-2 text-sm text-critical">{error}</p>}
    </Card>
  );
}

/** Managing the nodes in this stack: start and stop, copying chain data, and snapshots. */
export default function NodeData() {
  const admin = useAdminToken();
  const managed = useNodes();
  const [selected, setSelected] = useState("daemon");
  const list = managed?.nodes ?? [];
  const node = list.find((n) => n.id === selected) ?? list[0];
  const others = list.filter((n) => n !== node);
  const actionsEnabled = managed?.actionsEnabled ?? false;
  const token = actionsEnabled ? admin.token : "";
  const locked = !token;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-ink">{list.length > 1 ? "Nodes" : "Node"}</h1>
          <p className="text-sm text-ink-2">
            Restart or stop a node, bring its chain data up to date, or start it from a snapshot. Node settings are on
            the <a href="#/settings" className="underline decoration-line underline-offset-2 hover:text-ink">Settings</a> page.
          </p>
        </div>
        {list.length > 1 && <Segmented label="Node" value={node?.id ?? selected} options={list.map((n) => n.id)} onChange={setSelected} />}
      </div>

      {managed && <AdminUnlock actionsEnabled={actionsEnabled} admin={admin} />}

      <OldDataCard nodes={list} token={token} locked={locked} onUnauthorized={admin.forget} />

      {managed && list.length > 0 && (
        <UpgradeCard nodes={list} upgrade={managed.upgrade} token={token} locked={locked} onUnauthorized={admin.forget} />
      )}

      {node && <NodeControls node={node} others={others} token={token} locked={locked} onUnauthorized={admin.forget} />}
      {node && others.map((source) => (
        <CopyCard key={source.id} node={node} source={source} token={token} locked={locked} onUnauthorized={admin.forget} />
      ))}

      {node && <SnapshotsPanel key={node.id} node={node.id} admin={admin} />}
    </div>
  );
}
