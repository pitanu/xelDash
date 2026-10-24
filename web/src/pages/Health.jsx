import { usePolled } from "../api.js";
import { Card, EventsList, HealthBadge } from "../components/ui.jsx";
import { formatAgo, formatCompact, formatDiskBytes, formatDuration, formatInteger, formatTime } from "../format.js";
import ClusterCard from "../components/ClusterCard.jsx";
import FrontDoorCard from "../components/FrontDoorCard.jsx";
import DiskWarning from "../components/DiskWarning.jsx";
import ProblemsCard from "../components/ProblemsCard.jsx";
import UptimeCard from "../components/UptimeCard.jsx";
import { useOperatorView } from "../server-mode.js";

/** @param {{ label: string, children: React.ReactNode, detail?: React.ReactNode }} props */
function ServiceTile({ label, children, detail }) {
  return (
    <div className="card tile">
      <div className="label">{label}</div>
      <div className="mt-2">{children}</div>
      {detail && <div className="label mt-1.5">{detail}</div>}
    </div>
  );
}

/**
 * One node: its state, height, peers and version, what it is used for, and (for the operator) a way to manage it on the Nodes page.
 * @param {{ n: any, operator: boolean }} props
 */
function NodeCard({ n, operator }) {
  const state = nodeState(n);
  return (
    <section className="card pad flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-semibold text-ink">{n.label}</h2>
        <HealthBadge level={state.level} label={state.label} />
      </div>
      <div className="flex flex-wrap gap-1.5">
        {n.active && <span className="pill pill-final">Mining</span>}
        {n.fallback && <span className="pill pill-pending" title="Mined through only while none of your own nodes can issue work">Official fallback</span>}
        {n.updateAvailable && <span className="pill pill-side" title="A newer XELIS release is out">Update available</span>}
      </div>
      {n.ok ? (
        <dl className="m-0 grid grid-cols-2 gap-x-4 gap-y-3">
          <div><dt className="label">Height</dt><dd className="mono m-0 text-ink">{formatInteger(n.height)}</dd></div>
          <div><dt className="label">Peers</dt><dd className="mono m-0 text-ink">{n.peers === null ? "—" : formatInteger(n.peers)}</dd></div>
          <div><dt className="label">Version</dt><dd className="mono m-0 break-all text-ink">{n.version}</dd></div>
          <div><dt className="label">Topoheight</dt><dd className="mono m-0 text-ink">{formatInteger(n.topoheight)}</dd></div>
        </dl>
      ) : <p className="text-sm text-ink-2">{n.error ?? "Not responding."}</p>}
      {operator && !n.fallback && <div><a href="#/nodes" className="btn btn-sm">Manage: restart, versions, snapshots</a></div>}
    </section>
  );
}

/** The disk the nodes use, for the operator: how full it is, and the warning level. */
function DiskCard() {
  const disk = usePolled("/api/v1/node/disk", { intervalMs: 60_000 });
  const disks = /** @type {{ nodes: string[], free: number, total: number, level: string, source?: string }[]} */ (disk.data?.disks ?? []);
  if (disks.length === 0) return null;
  return (
    <section className="card pad flex flex-col gap-4">
      <h2 className="text-base font-semibold text-ink">Disk</h2>
      {disks.map((d) => {
        const used = d.total > 0 ? 1 - d.free / d.total : 0;
        const level = d.level === "critical" ? "critical" : d.level === "low" ? "warning" : "good";
        return (
          <div key={d.nodes.join(",")}>
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="mono text-xl font-medium text-ink">{formatDiskBytes(d.free)} <span className="text-sm font-normal text-muted">free of {formatDiskBytes(d.total)}</span></span>
              <HealthBadge level={level} label={`${Math.round(used * 100)}% full`} />
            </div>
            <div className="mt-2 h-2 rounded-full bg-panel-2" role="meter" aria-label="Disk used" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(used * 100)}>
              <div className={`h-full rounded-full ${level === "good" ? "bg-accent" : level === "warning" ? "bg-gold" : "bg-danger"}`} style={{ width: `${Math.min(100, used * 100)}%` }} />
            </div>
            <div className="label mt-2">Used by {d.nodes.join(" and ")}.{d.source === "computer" ? " Measured on this computer's drive." : ""} A full disk stops the node.</div>
          </div>
        );
      })}
    </section>
  );
}

/** @param {any} node */
function syncState(node) {
  if (!node || node.peers === null) return { level: /** @type {const} */ ("unknown"), label: "Unknown" };
  if (node.peers === 0) {
    // A private devnet has no other nodes to find; on mainnet and testnet no peers means found blocks reach no one.
    const shared = node.network === "mainnet" || node.network === "testnet";
    return shared ? { level: /** @type {const} */ ("warning"), label: "No peers" } : { level: /** @type {const} */ ("info"), label: "No peers (devnet)" };
  }
  if (node.syncing) return { level: /** @type {const} */ ("warning"), label: "Syncing" };
  return { level: /** @type {const} */ ("good"), label: "In sync" };
}

/** @param {any} n */
function nodeState(n) {
  if (!n.ok) return { level: /** @type {const} */ ("critical"), label: "Not responding" };
  return syncState(n);
}

export default function Health() {
  // Disk, cluster, front door and connection problems (with miners' IP addresses) are for the operator only.
  const operator = useOperatorView();
  const status = usePolled("/api/v1/status", { everyBlock: true });
  const events = usePolled("/api/v1/events?limit=30");
  const connect = usePolled("/api/v1/connect", { intervalMs: 5 * 60_000 });
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

  // What needs a look: nodes not in sync (a private devnet without peers is fine), Stratum not giving work, the database down.
  const issues = !s ? null : s.nodes.filter((/** @type {any} */ n) => !["good", "info"].includes(nodeState(n).level)).length
    + (!s.services.stratum.ok || s.services.stratum.paused ? 1 : 0) + (s.services.database.ok ? 0 : 1);
  const c = connect.data;
  const ports = c ? [`${c.stratumPort}`, c.tlsPort ? `${c.tlsPort} TLS` : null, c.getworkPort ? `${c.getworkPort} getwork` : null].filter(Boolean).join(" · ") : null;

  return (
    <div className="flex flex-col gap-5">
      <div className="page-head">
        <div><h1>Health</h1><p>Your nodes, the mining server and this machine.</p></div>
        {issues !== null && (issues === 0
          ? <HealthBadge level="good" label="All good" />
          : <HealthBadge level="warning" label={`${issues} thing${issues === 1 ? "" : "s"} to check`} />)}
      </div>
      {status.error && !s && <p className="text-sm text-danger">Unable to reach the xelDash API.</p>}
      <div className="tiles">
        <ServiceTile label={s && s.nodes.length > 1 ? "Nodes" : "Node"}
          detail={!s ? undefined : s.nodes.length > 1
            ? `${s.nodes.filter((/** @type {{ ok: boolean }} */ n) => n.ok).length} of ${s.nodes.length} responding`
            : s.services.daemon.ok ? node?.version : s.services.daemon.error}>
          {s && (s.nodes.length > 1 && s.services.daemon.ok && s.nodes.some((/** @type {{ ok: boolean }} */ n) => !n.ok)
            ? <HealthBadge level="warning" label="Degraded" />
            : <HealthBadge level={s.services.daemon.ok ? "good" : "critical"} label={s.services.daemon.ok ? "Running" : "Not responding"} />)}
        </ServiceTile>
        <ServiceTile label="Network sync"
          detail={sync.label === "No peers" ? "Found blocks cannot reach other nodes" : sync.label === "No peers (devnet)" ? "Normal on a private devnet"
            : sync.label === "Syncing" ? `At ${formatInteger(node.topoheight)} of ${formatInteger(node.networkTopoheight)}` : undefined}>
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

      {s && (
        <div>
          {s.nodes.length > 1 && <p className="label mb-2">Nodes in priority order. Mining uses the first node that is in sync.</p>}
          <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
            {s.nodes.map((/** @type {any} */ n) => <NodeCard key={n.label} n={n} operator={operator} />)}
          </div>
        </div>
      )}

      <div className="grid gap-5 md:grid-cols-2">
        {s && (
          <section className="card pad flex flex-col gap-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-base font-semibold text-ink">Stratum</h2>
              {!s.services.stratum.ok ? <HealthBadge level="critical" label="Not reachable" />
                : s.services.stratum.paused ? <HealthBadge level="warning" label="Paused" /> : <HealthBadge level="good" label="Listening" />}
            </div>
            <dl className="m-0 grid grid-cols-2 gap-x-4 gap-y-3">
              <div><dt className="label">Ports</dt><dd className="mono m-0 text-ink">{ports ?? "—"}</dd></div>
              <div><dt className="label">Mining through</dt><dd className="m-0 text-ink">{s.services.stratum.node ?? "—"}</dd></div>
              <div><dt className="label">Started</dt><dd className="m-0 text-ink" title={s.services.stratum.startedAt ? formatTime(s.services.stratum.startedAt) : undefined}>{s.services.stratum.startedAt ? formatAgo(s.services.stratum.startedAt) : "—"}</dd></div>
              <div><dt className="label">Database</dt><dd className="m-0 text-ink">{s.services.database.ok ? "Connected" : "Not responding"}</dd></div>
            </dl>
          </section>
        )}
        {operator && <DiskCard />}
      </div>

      {operator && <DiskWarning />}
      {operator && <ClusterCard />}
      {operator && <FrontDoorCard />}
      {operator && <ProblemsCard network={node?.network ?? "mainnet"} />}
      <UptimeCard />

      <div className="grid gap-5 lg:grid-cols-2">
        <Card title={node && s && s.nodes.length > 1 ? `Node ${node.label}` : "Node"} subtitle="The node Stratum mines through.">
          {node ? (
            <dl className="m-0">
              {rows.map(([label, value]) => (
                <div key={label} className="flex justify-between gap-4 border-t border-line py-2.5 first:border-t-0">
                  <dt className="text-ink-2">{label}</dt>
                  <dd className="mono m-0 text-right text-ink">{value}</dd>
                </div>
              ))}
            </dl>
          ) : s && <p className="text-sm text-muted">Node details are unavailable while the daemon is not responding.</p>}
        </Card>
        {/* On wide screens this column takes the node card's height; recent events fill the rest and scroll. */}
        <div className="lg:relative">
          <div className="space-y-5 lg:absolute lg:inset-0 lg:flex lg:flex-col lg:gap-5 lg:space-y-0">
            <Card title="Active bans" className="lg:shrink-0" subtitle="Stratum IPs banned for invalid submissions">
              {s && (s.bans.length === 0 ? <p className="text-sm text-muted">No active bans.</p> : (
                <ul className="row-list">
                  {s.bans.map((/** @type {{ ip: string, until: string, reason: string }} */ b) => (
                    <li key={b.ip} className="flex-col items-stretch! gap-1!">
                      <div className="flex justify-between gap-4">
                        <span className="mono text-ink">{b.ip}</span>
                        <span className="text-xs text-muted" title={formatTime(b.until)}>until {formatTime(b.until)}</span>
                      </div>
                      <div className="text-xs text-ink-2">{b.reason}</div>
                    </li>
                  ))}
                </ul>
              ))}
            </Card>
            {operator && (
              <Card title="Recent events" className="flex flex-col lg:min-h-0 lg:flex-1">
                <div className="-mr-2 max-h-96 overflow-y-auto pr-2 lg:max-h-none lg:min-h-0 lg:flex-1">
                  {events.data && <EventsList events={events.data.events} />}
                </div>
              </Card>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
