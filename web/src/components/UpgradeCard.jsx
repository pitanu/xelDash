import { useEffect, useState } from "react";
import { formatAgo, formatTime } from "../format.js";
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
                className="rounded-md bg-series-1 px-3 py-1.5 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-40">
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
        <p className="text-xs text-muted">
          A node that does not stay up on a new version is switched back automatically. Going back to an older version may
          not work if the new one changed the database; keep a snapshot or the other node's copy at hand.
        </p>
        {error && <p className="text-sm text-critical">{error}</p>}
      </div>
    </Card>
  );
}
