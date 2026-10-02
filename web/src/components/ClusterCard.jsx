import { usePolled } from "../api.js";
import { formatAgo } from "../format.js";
import { Card } from "./ui.jsx";

const ROLES = /** @type {Record<string, { label: string, level: "good" | "info" | "critical", text: (vip: string) => string }>} */ ({
  MASTER: {
    label: "Active",
    level: "good",
    text: (vip) => `This server holds the shared address ${vip}. Your rigs connect here, and the other server stands by to take over.`,
  },
  BACKUP: {
    label: "Standing by",
    level: "info",
    text: (vip) => `The other server holds the shared address ${vip} and your rigs mine there. This server takes over by itself if the other one stops.`,
  },
  FAULT: {
    label: "Cannot mine",
    level: "critical",
    text: (vip) => `This server cannot give work right now (its node is not ready), so it gave up the shared address ${vip} to the other server. It takes the standby role again once it is healthy.`,
  },
});

/** The address manager's view of this server in a two-server cluster. Shows nothing without one. */
export default function ClusterCard() {
  const cluster = usePolled("/api/v1/node/cluster", { intervalMs: 10_000 });
  const c = cluster.data;
  if (!c?.configured) return null;
  const role = ROLES[c.state] ?? { label: String(c.state), level: "info", text: () => "" };
  const color = role.level === "good" ? "text-good" : role.level === "critical" ? "text-critical" : "text-ink";
  return (
    <Card title="Redundancy" subtitle="Two servers share one address for your miners, so mining carries on if one of them stops or restarts.">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className={`text-lg font-semibold ${color}`}>{role.label}</span>
        <span className="text-xs text-muted">{c.server} · since {formatAgo(c.since)}</span>
      </div>
      <p className="mt-2 text-sm text-ink-2">{role.text(c.vip)}</p>
      <p className="mt-2 text-xs text-muted">
        Point every miner at {c.vip.replace(/\/\d+$/, "")}:3333. A server that is switched off, restarting or cannot mine hands the address to the other one within seconds.
      </p>
    </Card>
  );
}

/** A line at the top of every page while this server is the standby. */
export function ClusterBanner() {
  const cluster = usePolled("/api/v1/node/cluster", { intervalMs: 10_000 });
  const c = cluster.data;
  if (!c?.configured || c.state === "MASTER") return null;
  return (
    <div role="status" className="border-b border-line bg-wash">
      <div className="mx-auto max-w-6xl px-4 py-2 text-sm text-ink sm:px-6">
        {c.state === "FAULT"
          ? <><strong>This server cannot mine right now.</strong> Your rigs are on the other server.</>
          : <><strong>This server is standing by.</strong> Your rigs are mining on the other server; this one takes over automatically if it stops.</>}
      </div>
    </div>
  );
}
