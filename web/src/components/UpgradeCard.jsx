import { useEffect, useState } from "react";
import { formatAgo, formatDuration, formatInteger, formatTime } from "../format.js";
import { Card, HealthBadge } from "./ui.jsx";

const STEP_BADGES = {
  waiting: { level: /** @type {const} */ ("unknown"), label: "Waiting" },
  downloading: { level: /** @type {const} */ ("unknown"), label: "Downloading" },
  restarting: { level: /** @type {const} */ ("warning"), label: "Restarting" },
  syncing: { level: /** @type {const} */ ("warning"), label: "Catching up" },
  done: { level: /** @type {const} */ ("good"), label: "Done" },
  skipped: { level: /** @type {const} */ ("good"), label: "Already there" },
  failed: { level: /** @type {const} */ ("critical"), label: "Failed" },
};

/** "1.25.0-db59b5c2" to "1.25.0". @param {string | null | undefined} version */
function base(version) {
  return /^(\d+\.\d+\.\d+)/.exec(version ?? "")?.[1] ?? null;
}

/** @param {string} a @param {string} b */
function newer(a, b) {
  const x = a.split(".").map(Number);
  const y = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}

const SCHEDULE_BADGES = {
  preparing: { level: /** @type {const} */ ("unknown"), label: "Preparing" },
  ready: { level: /** @type {const} */ ("good"), label: "Scheduled" },
  started: { level: /** @type {const} */ ("warning"), label: "Switching" },
  done: { level: /** @type {const} */ ("good"), label: "Done" },
  failed: { level: /** @type {const} */ ("critical"), label: "Failed" },
};

/**
 * A switch at a block height, for network upgrades that require a version from a height on.
 * @param {{ releases: any[], token: string, locked: boolean, onUnauthorized: () => void }} props
 */
function ScheduleSetting({ releases, token, locked, onUnauthorized }) {
  const [status, setStatus] = useState(/** @type {any} */ (null));
  const [version, setVersion] = useState("");
  const [height, setHeight] = useState("");
  const [error, setError] = useState(/** @type {string | null} */ (null));

  async function load() {
    const response = await fetch("/api/v1/node/scheduled-upgrade").catch(() => null);
    if (response?.ok) setStatus(await response.json());
  }
  useEffect(() => {
    void load();
    const timer = setInterval(load, 10_000);
    return () => clearInterval(timer);
  }, []);

  /** @param {"POST" | "DELETE"} method @param {unknown} [body] */
  async function send(method, body) {
    setError(null);
    const response = await fetch("/api/v1/node/scheduled-upgrade", {
      method,
      headers: { "x-admin-token": token, "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (response.status === 401) onUnauthorized();
    if (!response.ok) setError((await response.json().catch(() => ({}))).error ?? `HTTP ${response.status}`);
    await load();
  }

  if (!status) return null;
  const schedule = status.schedule;
  const blockMs = status.averageBlockTimeMs;
  const wanted = Number(height);
  const blocksAway = status.height !== null && wanted > 0 ? wanted - status.height : null;
  const active = schedule && ["preparing", "ready", "started"].includes(schedule.status);
  const badge = schedule ? SCHEDULE_BADGES[/** @type {keyof typeof SCHEDULE_BADGES} */ (schedule.status)] : null;

  return (
    <div className="space-y-2 rounded-md border border-line p-3">
      <div>
        <div className="text-sm font-medium text-ink">Switch at a block height</div>
        <p className="text-xs text-ink-2">
          For network upgrades that require a version from a given height. The release is downloaded and checked on every
          node now; at the height, the nodes switch one at a time. Current height: {formatInteger(status.height)}.
        </p>
      </div>

      {schedule && badge && (
        <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <HealthBadge level={badge.level} label={badge.label} />
            <span className="text-ink">{schedule.version} at height {formatInteger(schedule.height)}</span>
            {active && status.etaSeconds !== null && schedule.status !== "started" && (
              <span className="text-xs text-muted">in about {formatDuration(status.etaSeconds)} ({formatInteger(schedule.height - status.height)} blocks)</span>
            )}
          </span>
          {!locked && schedule.status !== "started" && (
            <button type="button" onClick={() => void send("DELETE")}
              className="rounded-md border border-line px-3 py-1.5 text-sm text-ink hover:bg-wash">{active ? "Cancel" : "Clear"}</button>
          )}
        </div>
      )}
      {schedule?.note && <p className="text-xs text-ink-2">{schedule.note}</p>}

      {!locked && !active && releases.length > 0 && (
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <select value={version} onChange={(e) => setVersion(e.target.value)} aria-label="Version for the scheduled switch"
              className="rounded-md border border-line bg-page px-2 py-1.5 text-sm text-ink">
              <option value="">Version…</option>
              {releases.map((/** @type {any} */ r) => <option key={r.version} value={r.version}>{r.version}</option>)}
            </select>
            <input type="number" inputMode="numeric" min={1} value={height} onChange={(e) => setHeight(e.target.value)}
              placeholder="Height" aria-label="Switch at height"
              className="w-36 rounded-md border border-line bg-page px-2 py-1.5 text-sm text-ink" />
            <button type="button" disabled={!version || !(wanted > (status.height ?? 0))}
              onClick={() => void send("POST", { version, height: wanted })}
              className="rounded-md border border-line px-3 py-1.5 text-sm text-ink hover:bg-wash disabled:opacity-40">Schedule</button>
          </div>
          <p className="text-xs text-muted">
            {blocksAway !== null && blocksAway > 0 && blockMs
              ? `${formatInteger(blocksAway)} blocks from now, about ${formatDuration((blocksAway * blockMs) / 1000)}. `
              : ""}
            Pick a height a few hundred blocks before the upgrade's activation height: switching two nodes takes a few minutes.
          </p>
        </div>
      )}
      {error && <p className="text-sm text-critical">{error}</p>}
    </div>
  );
}

/**
 * Optional automatic updates (off by default): only offered with two local nodes.
 * @param {{ token: string, locked: boolean, onUnauthorized: () => void }} props
 */
function AutoUpdateSetting({ token, locked, onUnauthorized }) {
  const [status, setStatus] = useState(/** @type {any} */ (null));
  const [error, setError] = useState(/** @type {string | null} */ (null));

  useEffect(() => {
    let cancelled = false;
    const load = () => fetch("/api/v1/node/auto-update").then((r) => (r.ok ? r.json() : null))
      .then((body) => { if (!cancelled && body) setStatus(body); }).catch(() => {});
    load();
    const timer = setInterval(load, 30_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  /** @param {boolean} enabled */
  async function toggle(enabled) {
    setError(null);
    const response = await fetch("/api/v1/node/auto-update", {
      method: "PUT",
      headers: { "x-admin-token": token, "content-type": "application/json" },
      body: JSON.stringify({ enabled }),
    });
    const body = await response.json().catch(() => ({}));
    if (response.status === 401) onUnauthorized();
    if (!response.ok) setError(body.error ?? `HTTP ${response.status}`);
    else setStatus((s) => ({ ...s, ...body }));
  }

  if (!status) return null;
  return (
    <div className="space-y-2 rounded-md border border-line p-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-medium text-ink">Automatic updates</div>
          <p className="text-xs text-ink-2">
            Install new XELIS releases by themselves, {status.delayHours} h after they come out, one node at a time as above.
            Optional; needs two local nodes, so one always mines. A version that fails on a node is not tried again.
          </p>
        </div>
        <span className="flex items-center gap-3">
          <HealthBadge level={status.enabled ? "good" : "unknown"} label={status.enabled ? "On" : "Off"} />
          {!locked && (
            <button type="button" disabled={!status.enabled && !status.eligible} onClick={() => void toggle(!status.enabled)}
              className="rounded-md border border-line px-3 py-1.5 text-sm text-ink hover:bg-wash disabled:opacity-40">
              {status.enabled ? "Turn off" : "Turn on"}
            </button>
          )}
        </span>
      </div>
      {!status.eligible && <p className="text-xs text-muted">Available once a second local node runs (COMPOSE_PROFILES=redundant).</p>}
      {status.enabled && status.note && <p className="text-xs text-ink-2">{status.note}{status.checkedAt ? ` · checked ${formatAgo(status.checkedAt)}` : ""}</p>}
      {status.failedVersion && <p className="text-xs text-critical">{status.failedVersion} failed on a node and is skipped; a newer release will be tried.</p>}
      {error && <p className="text-sm text-critical">{error}</p>}
    </div>
  );
}

/**
 * Switch daemon versions from the dashboard: every node in turn, the usual mining node last,
 * each one back on the network before the next is touched.
 * @param {{ nodes: any[], upgrade: any, token: string, locked: boolean, onUnauthorized: () => void }} props
 */
export default function UpgradeCard({ nodes, upgrade, token, locked, onUnauthorized }) {
  const [releases, setReleases] = useState(/** @type {any} */ (null));
  const [choice, setChoice] = useState("");
  const [error, setError] = useState(/** @type {string | null} */ (null));

  useEffect(() => {
    fetch("/api/v1/node/releases").then((r) => (r.ok ? r.json() : null)).then(setReleases).catch(() => {});
  }, []);

  const latest = releases?.releases?.[0]?.version ?? null;
  const behind = latest ? nodes.filter((n) => n.running && base(n.running.version) && newer(latest, base(n.running.version) ?? "0.0.0")) : [];
  const running = upgrade?.phase === "running";
  const target = choice || latest || "";

  /** @param {string} version */
  async function start(version) {
    const label = version === "image" ? "the version built into each node's image" : version;
    const order = [...nodes.filter((n) => n.id !== "daemon"), ...nodes.filter((n) => n.id === "daemon")].map((n) => n.id).join(", then ");
    if (!window.confirm(
      `Switch ${nodes.length > 1 ? "every node" : "the node"} to ${label}? Order: ${order}. Each node restarts and must catch up before the next one starts. `
      + (nodes.length > 1 ? "Mining continues on the other node meanwhile." : "With one node, mining pauses while it restarts unless the official node fallback is on."),
    )) return;
    setError(null);
    const response = await fetch("/api/v1/node/upgrade", {
      method: "POST",
      headers: { "x-admin-token": token, "content-type": "application/json" },
      body: JSON.stringify({ version }),
    });
    if (response.status === 401) onUnauthorized();
    if (!response.ok) setError((await response.json().catch(() => ({}))).error ?? `HTTP ${response.status}`);
  }

  return (
    <Card title="Daemon version"
      subtitle={latest ? `Latest XELIS release: ${latest}. Releases come from the XELIS project's GitHub and are checked against their published checksums.` : "Official XELIS releases, from the project's GitHub."}>
      <div className="space-y-4">
        <ul className="divide-y divide-line rounded-md border border-line text-sm">
          {nodes.map((n) => (
            <li key={n.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
              <span className="font-medium text-ink">{n.id}</span>
              <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-2">
                <span className="tabular">{n.running?.version ?? "not answering"}</span>
                <span className="text-muted">{n.binary === "image" ? "from the image" : `downloaded release ${n.binary}`}</span>
                {n.lastResult && n.lastResult.outcome !== "applied" && (
                  <span className="text-critical" title={n.lastResult.message ?? ""}>last switch {n.lastResult.outcome} {formatAgo(n.lastResult.at)}</span>
                )}
              </span>
            </li>
          ))}
        </ul>

        {upgrade && upgrade.phase !== "idle" && (
          <div className="space-y-2 rounded-md border border-line p-3">
            <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
              <span className="font-medium text-ink">
                {running ? "Switching" : upgrade.phase === "done" ? "Switched" : "Stopped while switching"} to {upgrade.target === "image" ? "the image's version" : upgrade.target}
                {upgrade.trigger === "automatic" && <span className="font-normal text-muted"> (automatic update)</span>}
                {upgrade.trigger === "scheduled" && <span className="font-normal text-muted"> (at the scheduled height)</span>}
              </span>
              <span className="text-xs text-muted" title={formatTime(upgrade.startedAt)}>started {formatAgo(upgrade.startedAt)}</span>
            </div>
            <ol className="space-y-1.5">
              {upgrade.steps.map((/** @type {any} */ s) => {
                const badge = STEP_BADGES[/** @type {keyof typeof STEP_BADGES} */ (s.status)] ?? STEP_BADGES.waiting;
                return (
                  <li key={s.node} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                    <span className="w-20 font-medium text-ink">{s.node}</span>
                    <HealthBadge level={badge.level} label={badge.label} />
                    {s.note && <span className="text-xs text-ink-2">{s.note}</span>}
                  </li>
                );
              })}
            </ol>
            {upgrade.error && <p className="text-sm text-critical">{upgrade.error}</p>}
          </div>
        )}

        {releases && !releases.supported && <p className="text-sm text-ink-2">No XELIS release build exists for this machine's processor.</p>}
        {releases && releases.supported && !releases.available && <p className="text-sm text-ink-2">GitHub is not reachable right now, so releases cannot be listed.</p>}

        {!locked && releases?.releases?.length > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            {behind.length > 0 && !choice && (
              <button type="button" disabled={running} onClick={() => void start(/** @type {string} */ (latest))}
                className="rounded-md bg-action px-3 py-1.5 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-40">
                Update {nodes.length > 1 ? "all nodes" : "the node"} to {latest}
              </button>
            )}
            <select value={choice} onChange={(e) => setChoice(e.target.value)} aria-label="Version"
              className="rounded-md border border-line bg-page px-2 py-1.5 text-sm text-ink">
              <option value="">{behind.length > 0 ? "Other version…" : "Choose a version…"}</option>
              {releases.releases.map((/** @type {any} */ r) => <option key={r.version} value={r.version}>{r.version}</option>)}
              <option value="image">Back to the image's version</option>
            </select>
            {choice && (
              <button type="button" disabled={running} onClick={() => void start(target)}
                className="rounded-md border border-line px-3 py-1.5 text-sm text-ink hover:bg-wash disabled:opacity-40">
                Switch to {choice === "image" ? "the image's version" : choice}
              </button>
            )}
          </div>
        )}
        <ScheduleSetting releases={releases?.releases ?? []} token={token} locked={locked} onUnauthorized={onUnauthorized} />
        <AutoUpdateSetting token={token} locked={locked} onUnauthorized={onUnauthorized} />
        <p className="text-xs text-muted">
          A node that does not stay up on a new version is switched back automatically. Going back to an older version may
          not work if the new one changed the database; keep a snapshot or the other node's copy at hand.
        </p>
        {error && <p className="text-sm text-critical">{error}</p>}
      </div>
    </Card>
  );
}
