import { useCallback, useEffect, useRef, useState } from "react";
import DaemonSettings from "../components/DaemonSettings.jsx";
import MiningFallback from "../components/MiningFallback.jsx";
import { Card, HealthBadge } from "../components/ui.jsx";
import { formatAgo, formatTime } from "../format.js";

const TOKEN_KEY = "xeldash.adminToken";

/** @param {number | null | undefined} bytes */
function formatBytes(bytes) {
  if (bytes === null || bytes === undefined) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let n = bytes;
  let unit = 0;
  while (n >= 1000 && unit < units.length - 1) {
    n /= 1000;
    unit += 1;
  }
  return `${n.toLocaleString(undefined, { maximumFractionDigits: unit >= 3 ? 1 : 0 })} ${units[unit]}`;
}

function readToken() {
  try {
    return sessionStorage.getItem(TOKEN_KEY) ?? "";
  } catch {
    return "";
  }
}

/** Snapshot service status, polled every second while something is running. */
function useSnapshotStatus() {
  const [status, setStatus] = useState(/** @type {any} */ (null));
  const [error, setError] = useState(/** @type {string | null} */ (null));
  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/v1/node/snapshot/status");
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      setStatus(await response.json());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);
  const busy = status && ["downloading", "uploading", "verifying", "extracting"].includes(status.state.phase);
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
  ready: "Ready to switch",
  error: "Failed",
};

/** @param {{ className?: string, children: React.ReactNode, onClick: () => void, disabled?: boolean, primary?: boolean }} props */
function Button({ children, onClick, disabled = false, primary = false, className = "" }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled}
      className={`rounded-md px-3 py-1.5 text-sm disabled:opacity-40 ${primary
        ? "bg-series-1 font-semibold text-white hover:opacity-90"
        : "border border-line text-ink hover:bg-wash"} ${className}`}>
      {children}
    </button>
  );
}

export default function NodeData() {
  const { status, error, reload, busy } = useSnapshotStatus();
  const [token, setToken] = useState(readToken);
  const [tokenInput, setTokenInput] = useState("");
  const [tokenError, setTokenError] = useState(/** @type {string | null} */ (null));
  const [actionError, setActionError] = useState(/** @type {string | null} */ (null));
  const [pending, setPending] = useState(/** @type {File | null} */ (null));
  const [upload, setUpload] = useState(/** @type {{ bytes: number, total: number } | null} */ (null));
  const [dragging, setDragging] = useState(false);
  const input = useRef(/** @type {HTMLInputElement | null} */ (null));
  const xhr = useRef(/** @type {XMLHttpRequest | null} */ (null));

  /** @param {string} path */
  async function action(path) {
    setActionError(null);
    const response = await fetch(`/api/v1/node/snapshot/${path}`, { method: "POST", headers: { "x-admin-token": token } });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      if (response.status === 401) forgetToken();
      setActionError(body.error ?? `HTTP ${response.status}`);
    }
    await reload();
  }

  async function saveToken() {
    setTokenError(null);
    try {
      const response = await fetch("/api/v1/node/token/check", { method: "POST", headers: { "x-admin-token": tokenInput } });
      if (!response.ok) {
        setTokenError(response.status === 401 ? "That token is not right. Check XELDASH_ADMIN_TOKEN in .env." : `Could not check the token (HTTP ${response.status}).`);
        return;
      }
    } catch {
      setTokenError("Could not reach the node admin service.");
      return;
    }
    try {
      sessionStorage.setItem(TOKEN_KEY, tokenInput);
    } catch {
      // Private mode: keep it in memory for this page only.
    }
    setToken(tokenInput);
    setTokenInput("");
  }

  /** @param {boolean} [refused] the server turned the token down, rather than the user signing out */
  function forgetToken(refused = true) {
    if (refused) setTokenError("The admin token was refused, so nothing was changed. Enter it again; unsaved settings are kept.");
    try {
      sessionStorage.removeItem(TOKEN_KEY);
    } catch {
      // Nothing stored.
    }
    setToken("");
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
    request.open("PUT", "/api/v1/node/snapshot/upload");
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
      <div>
        <a href="#/health" className="text-xs text-ink-2 hover:text-ink hover:underline">← Health</a>
        <h1 className="mt-1 text-lg font-semibold text-ink">Node</h1>
        <p className="text-sm text-ink-2">
          Change the XELIS daemon's settings, or start its chain data from a snapshot instead of syncing from the network.
        </p>
      </div>

      {!s.actionsEnabled ? (
        <Card title="Changes are off">
          <p className="text-sm text-ink-2">
            Changing the node needs an admin token. Set <code className="rounded bg-wash px-1">XELDASH_ADMIN_TOKEN</code> in
            {" "}<code className="rounded bg-wash px-1">.env</code> and restart xelDash, then enter it here. Until then this page is read-only.
          </p>
        </Card>
      ) : !token && (
        <Card title="Unlock changes" subtitle="Enter the admin token from .env (XELDASH_ADMIN_TOKEN). It is kept for this browser session only.">
          <form className="flex flex-wrap gap-2" onSubmit={(e) => { e.preventDefault(); void saveToken(); }}>
            <input type="password" value={tokenInput} onChange={(e) => setTokenInput(e.target.value)} autoComplete="off"
              aria-label="Admin token" className="min-w-0 flex-1 rounded-md border border-line bg-page px-3 py-1.5 text-sm text-ink" />
            <button type="submit" disabled={!tokenInput}
              className="rounded-md bg-series-1 px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-40">Unlock</button>
          </form>
          {tokenError && <p role="alert" className="mt-2 text-sm text-critical">{tokenError}</p>}
        </Card>
      )}

      <MiningFallback token={s.actionsEnabled ? token : ""} onUnauthorized={forgetToken} />
      <DaemonSettings token={s.actionsEnabled ? token : ""} onUnauthorized={forgetToken} />

      <h2 className="pt-2 text-base font-semibold text-ink">Snapshots</h2>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <div className="min-w-0 rounded-lg border border-line bg-surface p-3 sm:p-4">
          <div className="text-xs text-ink-2">Chain data</div>
          <div className="mt-2"><HealthBadge level={s.dataPresent ? "good" : "warning"} label={s.dataPresent ? "Present" : "None yet"} /></div>
          <div className="mt-1 text-xs text-muted">{s.network}</div>
        </div>
        <div className="min-w-0 rounded-lg border border-line bg-surface p-3 sm:p-4">
          <div className="text-xs text-ink-2">Free disk space</div>
          <div className="mt-1 text-2xl font-semibold text-ink">{formatBytes(s.disk.free)}</div>
          <div className="mt-1 text-xs text-muted">of {formatBytes(s.disk.total)}</div>
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

      {token && s.actionsEnabled && (
        <button type="button" onClick={() => forgetToken(false)} className="text-xs text-ink-2 underline decoration-line underline-offset-2 hover:text-ink">
          Lock snapshot actions
        </button>
      )}
    </div>
  );
}
