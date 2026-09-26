import { formatAgo, formatHashrate, formatInteger, formatTime, formatXel, shorten } from "../format.js";

/** @param {{ title: string, subtitle?: string, action?: React.ReactNode, children: React.ReactNode }} props */
export function Card({ title, subtitle, action, children }) {
  return (
    <section className="min-w-0 rounded-lg border border-line bg-surface p-4 sm:p-5">
      <header className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold text-ink">{title}</h2>
          {subtitle && <p className="text-xs text-muted">{subtitle}</p>}
        </div>
        {action}
      </header>
      {children}
    </section>
  );
}

/** @param {{ label: string, value: React.ReactNode, detail?: React.ReactNode, hero?: boolean }} props */
export function StatTile({ label, value, detail, hero = false }) {
  return (
    <div className="min-w-0 rounded-lg border border-line bg-surface p-3 sm:p-4">
      <div className="text-xs text-ink-2">{label}</div>
      <div className={`mt-1 font-semibold text-ink ${hero ? "text-5xl leading-tight" : "text-2xl"}`}>{value}</div>
      {detail && <div className="mt-1 text-xs text-muted">{detail}</div>}
    </div>
  );
}

// Status colors are reserved for block state and always ship with an icon and a label.
const STATUS = {
  "main-chain": { label: "Main chain", color: "var(--good)", icon: "M3 8.5l3 3 7-7" },
  side: { label: "Side block", color: "var(--warning)", icon: "M4 8h8" },
  orphaned: { label: "Orphaned", color: "var(--critical)", icon: "M4 4l8 8M12 4l-8 8" },
  rejected: { label: "Rejected", color: "var(--critical)", icon: "M4 4l8 8M12 4l-8 8" },
  submitted: { label: "Pending", color: "var(--muted)", icon: "M8 4v4l2.5 2.5" },
};

/** @param {{ status: string }} props */
export function StatusBadge({ status }) {
  const s = STATUS[/** @type {keyof typeof STATUS} */ (status)] ?? { label: status, color: "var(--muted)", icon: "M8 5v4M8 11v.5" };
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-ink-2">
      <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
        <circle cx="8" cy="8" r="7.5" fill={s.color} fillOpacity="0.16" />
        <path d={s.icon} fill="none" stroke={s.color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      {s.label}
    </span>
  );
}

/** @param {{ value: string, options: string[], onChange: (value: string) => void, label: string }} props */
export function Segmented({ value, options, onChange, label }) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex rounded-md border border-line p-0.5 text-xs">
      {options.map((option) => (
        <button key={option} type="button" role="radio" aria-checked={value === option} onClick={() => onChange(option)}
          className={`rounded px-2.5 py-1 ${value === option ? "bg-wash font-semibold text-ink" : "text-ink-2 hover:bg-wash"}`}>
          {option}
        </button>
      ))}
    </div>
  );
}

/** @param {{ children: React.ReactNode }} props */
function Table({ children }) {
  return (
    <div className="-mx-4 overflow-x-auto sm:-mx-5">
      <table className="w-full min-w-[32rem] text-sm">{children}</table>
    </div>
  );
}

const th = "whitespace-nowrap px-4 py-2 text-left text-xs font-medium text-muted sm:px-5";
const td = "whitespace-nowrap px-4 py-2 sm:px-5";

/** @param {{ blocks: any[], showMiner?: boolean }} props */
export function BlocksTable({ blocks, showMiner = true }) {
  if (blocks.length === 0) return <p className="text-sm text-muted">No blocks found yet.</p>;
  return (
    <Table>
      <thead>
        <tr><th className={th}>Height</th><th className={th}>Status</th>{showMiner && <th className={th}>Miner</th>}
          <th className={`${th} text-right`}>Reward</th><th className={`${th} text-right`}>Found</th></tr>
      </thead>
      <tbody className="tabular">
        {blocks.map((b) => (
          <tr key={b.hash} className="border-t border-line">
            <td className={td}><span title={b.hash}>{formatInteger(b.height)}</span></td>
            <td className={td}><StatusBadge status={b.status} /></td>
            {showMiner && (
              <td className={`${td} text-ink-2`}>
                {b.address ? <a href={`#/miner/${b.address}`} className="hover:text-ink hover:underline">{shorten(b.address)}</a> : "—"}
                {b.worker && <span className="text-muted"> · {b.worker}</span>}
              </td>
            )}
            <td className={`${td} text-right`}>{formatXel(b.reward)}</td>
            <td className={`${td} text-right text-ink-2`} title={formatTime(b.foundAt)}>{formatAgo(b.foundAt)}</td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

/** @param {{ miners: any[] }} props */
export function MinersTable({ miners }) {
  if (miners.length === 0) return <p className="text-sm text-muted">No miners have connected yet.</p>;
  return (
    <Table>
      <thead>
        <tr><th className={th}>Address</th><th className={`${th} text-right`}>Hashrate (1 h)</th>
          <th className={`${th} text-right`}>Workers</th><th className={`${th} text-right`}>Blocks</th><th className={`${th} text-right`}>Last seen</th></tr>
      </thead>
      <tbody className="tabular">
        {miners.map((m) => (
          <tr key={m.address} className="border-t border-line">
            <td className={td}><a href={`#/miner/${m.address}`} className="text-ink hover:underline" title={m.address}>{shorten(m.address, 10)}</a></td>
            <td className={`${td} text-right`}>{formatHashrate(m.hashrate1h)}</td>
            <td className={`${td} text-right`}>{formatInteger(m.workers)}</td>
            <td className={`${td} text-right`}>{formatInteger(m.blocks)}</td>
            <td className={`${td} text-right text-ink-2`}>{formatAgo(m.lastSeen)}</td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

/** @param {{ workers: any[], address: string }} props */
export function WorkersTable({ workers, address }) {
  if (workers.length === 0) return <p className="text-sm text-muted">No workers.</p>;
  return (
    <Table>
      <thead>
        <tr><th className={th}>Worker</th><th className={`${th} text-right`}>Hashrate (5 min)</th><th className={`${th} text-right`}>Hashrate (1 h)</th>
          <th className={`${th} text-right`} title="What the miner reports about itself">Reported</th>
          <th className={`${th} text-right`}>Accepted (1 h)</th><th className={`${th} text-right`}>Rejected (1 h)</th><th className={`${th} text-right`}>Last seen</th></tr>
      </thead>
      <tbody className="tabular">
        {workers.map((w) => (
          <tr key={w.name} className="border-t border-line">
            <td className={td}>
              <a href={`#/miner/${address}/worker/${encodeURIComponent(w.name)}`} className="text-ink hover:underline">{w.name}</a>
            </td>
            <td className={`${td} text-right`}>{formatHashrate(w.hashrate5m)}</td>
            <td className={`${td} text-right`}>{formatHashrate(w.hashrate1h)}</td>
            <td className={`${td} text-right text-ink-2`}>{formatHashrate(w.reportedHashrate)}</td>
            <td className={`${td} text-right`}>{formatInteger(w.accepted1h)}</td>
            <td className={`${td} text-right`}>{formatInteger(w.rejected1h)}</td>
            <td className={`${td} text-right text-ink-2`}>{formatAgo(w.lastSeen)}</td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

const EVENT_LABELS = {
  block_submitted: "Block submitted",
  block_rejected: "Block rejected by daemon",
  block_final: "Block final",
  ip_banned: "IP banned",
  stratum_started: "Stratum started",
  node_syncing: "Node syncing, work paused",
  node_unreachable: "Node not responding, work paused",
  node_ready: "Node ready, work resumed",
  node_switched: "Mining switched node",
};

const LEVELS = {
  good: { color: "var(--good)", icon: "M3 8.5l3 3 7-7" },
  warning: { color: "var(--warning)", icon: "M8 4v5M8 11.5v.5" },
  critical: { color: "var(--critical)", icon: "M4 4l8 8M12 4l-8 8" },
  unknown: { color: "var(--muted)", icon: "M8 5v4M8 11v.5" },
};

/** Health state with the reserved status colors; always paired with an icon and a label. @param {{ level: keyof typeof LEVELS, label: string }} props */
export function HealthBadge({ level, label }) {
  const l = LEVELS[level];
  return (
    <span className="inline-flex items-center gap-1.5 text-sm text-ink">
      <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
        <circle cx="8" cy="8" r="7.5" fill={l.color} fillOpacity="0.16" />
        <path d={l.icon} fill="none" stroke={l.color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      {label}
    </span>
  );
}

/** @param {{ events: any[] }} props */
export function EventsList({ events }) {
  if (events.length === 0) return <p className="text-sm text-muted">No events yet.</p>;
  return (
    <ul className="divide-y divide-line text-sm">
      {events.map((e) => (
        <li key={e.id} className="flex flex-wrap items-baseline justify-between gap-x-4 py-2">
          <span className="text-ink">
            {EVENT_LABELS[/** @type {keyof typeof EVENT_LABELS} */ (e.type)] ?? e.type}
            {e.payload?.height !== undefined && <span className="text-ink-2 tabular"> · height {formatInteger(e.payload.height)}</span>}
            {e.payload?.status && <span className="text-ink-2"> · {e.payload.status}</span>}
            {e.payload?.ip && <span className="text-ink-2"> · {e.payload.ip}</span>}
            {e.payload?.from && e.payload?.to && <span className="text-ink-2"> · {e.payload.from} → {e.payload.to}</span>}
          </span>
          <span className="text-xs text-muted" title={formatTime(e.createdAt)}>{formatAgo(e.createdAt)}</span>
        </li>
      ))}
    </ul>
  );
}
