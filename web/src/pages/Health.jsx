import { usePolled } from "../api.js";
import { Card, EventsList, HealthBadge } from "../components/ui.jsx";
import { formatAgo, formatCompact, formatDuration, formatInteger, formatTime } from "../format.js";
import ProblemsCard from "../components/ProblemsCard.jsx";

/** @param {{ label: string, children: React.ReactNode, detail?: React.ReactNode }} props */
function ServiceTile({ label, children, detail }) {
  return (
    <div className="min-w-0 rounded-lg border border-line bg-surface p-3 sm:p-4">
      <div className="text-xs text-ink-2">{label}</div>
      <div className="mt-2">{children}</div>
      {detail && <div className="mt-1 text-xs text-muted">{detail}</div>}
    </div>
  );
}

/** @param {any} node */
function syncState(node) {
  if (!node || node.peers === null) return { level: /** @type {const} */ ("unknown"), label: "Unknown" };
  if (node.peers === 0) return { level: /** @type {const} */ ("warning"), label: "No peers" };
  if (node.syncing) return { level: /** @type {const} */ ("warning"), label: "Syncing" };
  return { level: /** @type {const} */ ("good"), label: "In sync" };
}

/** @param {any} n */
function nodeState(n) {
  if (!n.ok) return { level: /** @type {const} */ ("critical"), label: "Not responding" };
  return syncState(n);
}

/** Every configured node, with the one Stratum mines through marked. @param {{ nodes: any[] }} props */
function NodesList({ nodes }) {
  return (
    <ul className="divide-y divide-line text-sm">
      {nodes.map((n) => {
        const state = nodeState(n);
        return (
          <li key={n.label} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 py-2">
            <span className="flex items-center gap-2">
              <span className="font-medium text-ink">{n.label}</span>
              {n.fallback && <span className="rounded bg-wash px-1.5 py-0.5 text-xs text-ink-2" title="Mined through only while none of your own nodes can issue work">Official fallback</span>}
              {n.active && <span className="rounded bg-wash px-1.5 py-0.5 text-xs text-ink-2">Mining</span>}
              {n.updateAvailable && <span className="rounded bg-wash px-1.5 py-0.5 text-xs text-ink-2" title="A newer XELIS release is out">Update available</span>}
            </span>
            <span className="flex flex-wrap items-center gap-x-4 gap-y-1">
              <HealthBadge level={state.level} label={state.label} />
              <span className="tabular text-xs text-muted">
                {n.ok ? `${n.version} · topo ${formatInteger(n.topoheight)} · ${formatInteger(n.peers ?? 0)} peers` : n.error}
              </span>
            </span>
          </li>
        );
      })}
    </ul>
  );
}

export default function Health() {
  const status = usePolled("/api/v1/status");
  const events = usePolled("/api/v1/events?limit=30");
  const s = status.data;
  const node = s?.node;
  const sync = syncState(node);

  /** @type {[string, React.ReactNode][]} */
  const rows = node ? [
    ["Version", s?.latestRelease
      ? `${node.version}${node.updateAvailable ? ` · ${s.latestRelease.version} available` : " · latest"}`
      : node.version],
    ["Network", node.network],
    ["Height", formatInteger(node.height)],
    ["Topoheight", formatInteger(node.topoheight)],
    ["Stable height", formatInteger(node.stableheight)],
    ["Block version", node.blockVersion],
    ["Difficulty", formatCompact(node.difficulty)],
    ["Average block time", `${formatDuration(node.averageBlockTimeMs / 1000)} (target ${formatDuration(node.blockTimeTargetMs / 1000)})`],
    ["Mempool", `${formatInteger(node.mempoolSize)} transactions`],
    ["Peers", node.peers === null ? "—" : `${formatInteger(node.peers)} of ${formatInteger(node.maxPeers)}`],
    ["Peers' median topoheight", node.peers ? formatInteger(node.networkTopoheight) : "—"],
  ] : [];

  return (
    <div className="space-y-6">
      {status.error && !s && <p className="text-sm text-critical">Unable to reach the xelDash API.</p>}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <ServiceTile label={s && s.nodes.length > 1 ? "Nodes" : "Node"}
          detail={!s ? undefined : s.nodes.length > 1
            ? `${s.nodes.filter((n) => n.ok).length} of ${s.nodes.length} responding`
            : s.services.daemon.ok ? node?.version : s.services.daemon.error}>
          {s && (s.nodes.length > 1 && s.services.daemon.ok && s.nodes.some((n) => !n.ok)
            ? <HealthBadge level="warning" label="Degraded" />
            : <HealthBadge level={s.services.daemon.ok ? "good" : "critical"} label={s.services.daemon.ok ? "Running" : "Not responding"} />)}
        </ServiceTile>
        <ServiceTile label="Network sync"
          detail={sync.label === "No peers" ? "Found blocks cannot reach other nodes" : sync.label === "Syncing" ? `At ${formatInteger(node.topoheight)} of ${formatInteger(node.networkTopoheight)}` : undefined}>
          {s && <HealthBadge level={sync.level} label={sync.label} />}
        </ServiceTile>
        <ServiceTile label="Stratum"
          detail={s?.services.stratum.paused
            ? `Work paused: node ${s.services.stratum.paused === "syncing" ? "is syncing" : "is not responding"}`
            : s?.services.stratum.node && s.nodes.length > 1 ? `Mining through ${s.services.stratum.node}`
              : s?.services.stratum.startedAt ? `Started ${formatAgo(s.services.stratum.startedAt)}` : undefined}>
          {s && (!s.services.stratum.ok
            ? <HealthBadge level="critical" label="Not reachable" />
            : s.services.stratum.paused
              ? <HealthBadge level="warning" label="Paused" />
              : <HealthBadge level="good" label="Accepting miners" />)}
        </ServiceTile>
        <ServiceTile label="Database" detail={s?.services.database.ok ? undefined : s?.services.database.error}>
          {s && <HealthBadge level={s.services.database.ok ? "good" : "critical"} label={s.services.database.ok ? "Connected" : "Not responding"} />}
        </ServiceTile>
      </div>

      {s && s.nodes.length > 1 && (
        <Card title="Nodes" subtitle="In priority order. Mining uses the first node that is in sync.">
          <NodesList nodes={s.nodes} />
        </Card>
      )}

      <ProblemsCard network={node?.network ?? "mainnet"} />

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title={node && s && s.nodes.length > 1 ? `Node ${node.label}` : "Node"}>
          {node ? (
            <dl className="divide-y divide-line text-sm">
              {rows.map(([label, value]) => (
                <div key={label} className="flex justify-between gap-4 py-2">
                  <dt className="text-ink-2">{label}</dt>
                  <dd className="tabular text-right text-ink">{value}</dd>
                </div>
              ))}
            </dl>
          ) : s && <p className="text-sm text-muted">Node details are unavailable while the daemon is not responding.</p>}
        </Card>
        {/* On wide screens this column takes the node card's height; recent events fill the rest and scroll. */}
        <div className="lg:relative">
          <div className="space-y-6 lg:absolute lg:inset-0 lg:flex lg:flex-col lg:gap-6 lg:space-y-0">
            <Card title="Active bans" className="lg:shrink-0" subtitle="Stratum IPs banned for invalid submissions">
              {s && (s.bans.length === 0 ? <p className="text-sm text-muted">No active bans.</p> : (
                <ul className="divide-y divide-line text-sm">
                  {s.bans.map((b) => (
                    <li key={b.ip} className="py-2">
                      <div className="flex justify-between gap-4">
                        <span className="tabular text-ink">{b.ip}</span>
                        <span className="text-xs text-muted" title={formatTime(b.until)}>until {formatTime(b.until)}</span>
                      </div>
                      <div className="text-xs text-ink-2">{b.reason}</div>
                    </li>
                  ))}
                </ul>
              ))}
            </Card>
            <Card title="Recent events" className="flex flex-col lg:min-h-0 lg:flex-1">
              <div className="-mr-2 max-h-96 overflow-y-auto pr-2 lg:max-h-none lg:min-h-0 lg:flex-1">
                {events.data && <EventsList events={events.data.events} />}
              </div>
            </Card>
          </div>
        </div>
      </div>
    </div>
  );
}
