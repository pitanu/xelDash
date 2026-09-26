import { usePolled } from "../api.js";
import { Card, EventsList, HealthBadge } from "../components/ui.jsx";
import { formatAgo, formatCompact, formatDuration, formatInteger, formatTime } from "../format.js";

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

export default function Health() {
  const status = usePolled("/api/v1/status");
  const events = usePolled("/api/v1/events?limit=30");
  const s = status.data;
  const node = s?.node;
  const sync = syncState(node);

  /** @type {[string, React.ReactNode][]} */
  const rows = node ? [
    ["Version", node.version],
    ["Network", node.network],
    ["Height", formatInteger(node.height)],
    ["Topoheight", formatInteger(node.topoheight)],
    ["Stable height", formatInteger(node.stableheight)],
    ["Block version", node.blockVersion],
    ["Difficulty", formatCompact(node.difficulty)],
    ["Average block time", `${formatDuration(node.averageBlockTimeMs / 1000)} (target ${formatDuration(node.blockTimeTargetMs / 1000)})`],
    ["Mempool", `${formatInteger(node.mempoolSize)} transactions`],
    ["Peers", node.peers === null ? "—" : `${formatInteger(node.peers)} of ${formatInteger(node.maxPeers)}`],
    ["Best peer topoheight", node.peers ? formatInteger(node.bestTopoheight) : "—"],
  ] : [];

  return (
    <div className="space-y-6">
      {status.error && !s && <p className="text-sm text-critical">Unable to reach the xelDash API.</p>}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <ServiceTile label="Node" detail={s?.services.daemon.ok ? node?.version : s?.services.daemon.error}>
          {s && <HealthBadge level={s.services.daemon.ok ? "good" : "critical"} label={s.services.daemon.ok ? "Running" : "Not responding"} />}
        </ServiceTile>
        <ServiceTile label="Network sync"
          detail={sync.label === "No peers" ? "Found blocks cannot reach other nodes" : sync.label === "Syncing" ? `At ${formatInteger(node.topoheight)} of ${formatInteger(node.bestTopoheight)}` : undefined}>
          {s && <HealthBadge level={sync.level} label={sync.label} />}
        </ServiceTile>
        <ServiceTile label="Stratum" detail={s?.services.stratum.startedAt ? `Started ${formatAgo(s.services.stratum.startedAt)}` : undefined}>
          {s && <HealthBadge level={s.services.stratum.ok ? "good" : "critical"} label={s.services.stratum.ok ? "Accepting miners" : "Not reachable"} />}
        </ServiceTile>
        <ServiceTile label="Database" detail={s?.services.database.ok ? undefined : s?.services.database.error}>
          {s && <HealthBadge level={s.services.database.ok ? "good" : "critical"} label={s.services.database.ok ? "Connected" : "Not responding"} />}
        </ServiceTile>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Node">
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
        <div className="space-y-6">
          <Card title="Active bans" subtitle="Stratum IPs banned for invalid submissions">
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
          <Card title="Recent events">{events.data && <EventsList events={events.data.events} />}</Card>
        </div>
      </div>
    </div>
  );
}
