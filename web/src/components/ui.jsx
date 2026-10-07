import { useCoin } from "../coin.js";
import { XEL_DECIMALS, formatAgo, formatEffort, formatHashrate, formatInteger, formatTime, formatXel, shorten } from "../format.js";
import { useBlockUrl } from "../explorer.js";
import { formatMoney, usePrice } from "../price.js";

/** @param {{ title: React.ReactNode, subtitle?: string, action?: React.ReactNode, children: React.ReactNode, className?: string }} props */
export function Card({ title, subtitle, action, children, className = "" }) {
  return (
    <section className={`min-w-0 rounded-lg border border-line bg-surface p-4 sm:p-5 ${className}`}>
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

/** Small line icons for stat tiles, drawn on a 16px grid. */
export const ICONS = {
  hashrate: "M9 2L4 9h4l-1 5 5-7H8l1-5z",
  clock: "M8 2.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11zM8 5v3l2 1.5",
  block: "M8 2l5 2.75v6.5L8 14l-5-2.75v-6.5L8 2zM3 4.75L8 7.5l5-2.75M8 7.5V14",
  difficulty: "M2.5 12a5.5 5.5 0 0 1 11 0M8 12l2.5-3.5",
  workers: "M5.5 7a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM2 13c0-2 1.6-3.5 3.5-3.5S9 11 9 13M11 7.5a1.75 1.75 0 1 0 0-3.5M11.5 9.5c1.4.3 2.5 1.6 2.5 3.5",
  shares: "M3 8.5l3 3 7-7",
  rejected: "M4.5 4.5l7 7M11.5 4.5l-7 7",
  height: "M3 12.5h10M4.5 10h7M6 7.5h4M7.25 5h1.5",
};

/**
 * A labelled figure. The hero tile (one per view) is larger and lightly tinted with the
 * accent; `aside` sits top-right, for a status badge.
 * @param {{ label: string, value: React.ReactNode, detail?: React.ReactNode, hero?: boolean,
 *   icon?: keyof typeof ICONS, aside?: React.ReactNode }} props
 */
export function StatTile({ label, value, detail, hero = false, icon, aside }) {
  return (
    <div className={`min-w-0 rounded-lg border border-line p-3 sm:p-4 ${hero ? "h-full bg-linear-to-br from-series-1/10 via-surface to-surface" : "bg-surface"}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-1.5 text-xs text-ink-2">
          {icon && (
            <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" className="shrink-0 text-muted">
              <path d={ICONS[icon]} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          )}
          {label}
        </div>
        {aside}
      </div>
      <div className={`mt-1 font-semibold tracking-tight text-ink ${hero ? "text-5xl leading-tight" : "text-2xl"}`}>{value}</div>
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

/**
 * A row of mutually exclusive choices. Options are values, or [value, label] pairs.
 * @template {string} T
 * @param {{ value: T, options: readonly (T | readonly [T, string])[], onChange: (value: T) => void, label: string }} props
 */
export function Segmented({ value, options, onChange, label }) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex rounded-md border border-line p-0.5 text-xs">
      {options.map((option) => {
        const [key, text] = typeof option === "string" ? [option, option] : option;
        return (
          <button key={key} type="button" role="radio" aria-checked={value === key} onClick={() => onChange(key)}
            className={`rounded px-2.5 py-1 ${value === key ? "bg-wash font-semibold text-ink" : "text-ink-2 hover:bg-wash"}`}>
            {text}
          </button>
        );
      })}
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
  const coin = useCoin();
  const blockUrl = useBlockUrl();
  const { price } = usePrice();
  if (blocks.length === 0) return <p className="text-sm text-muted">No blocks found yet.</p>;
  return (
    <Table>
      <thead>
        <tr><th className={th}>Height</th><th className={th}>Status</th>{showMiner && <th className={th}>Miner</th>}
          <th className={`${th} text-right`} title="Work spent on the round this block ended, as a share of the work expected per block">Effort</th>
          <th className={`${th} text-right`}>Reward</th><th className={`${th} text-right`}>Found</th></tr>
      </thead>
      <tbody className="tabular">
        {blocks.map((b) => (
          <tr key={b.hash} className={`border-t border-line ${Date.now() - Date.parse(b.foundAt) < 15_000 ? "block-new" : ""}`}>
            <td className={td}>
              {blockUrl(b.hash)
                ? <a href={blockUrl(b.hash) ?? undefined} target="_blank" rel="noopener noreferrer" title="Open in the XELIS block explorer" className="hover:text-ink hover:underline">{formatInteger(b.height)}</a>
                : <span title={b.hash}>{formatInteger(b.height)}</span>}
            </td>
            <td className={td}><StatusBadge status={b.status} /></td>
            {showMiner && (
              <td className={`${td} text-ink-2`}>
                {b.address ? <a href={`#/miner/${b.address}`} className="hover:text-ink hover:underline">{shorten(b.address)}</a> : "—"}
                {b.worker && <span className="text-muted"> · {b.worker}</span>}
              </td>
            )}
            <td className={`${td} text-right text-ink-2`}>{b.effort === null || b.effort === undefined ? "—" : formatEffort(b.effort)}</td>
            <td className={`${td} text-right`}>
              {formatXel(b.reward, coin)}
              {price && b.reward && (
                <span className="block text-xs text-muted" title="At the current price">
                  ≈ {formatMoney((Number(b.reward) / 10 ** XEL_DECIMALS) * price.price, price.currency, "amount")}
                </span>
              )}
            </td>
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

/** @param {{ workers: any[], address: string, onRemove?: (name: string) => void }} props */
export function WorkersTable({ workers, address, onRemove }) {
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
            {onRemove && (
              <td className={`${td} text-right`}>
                <button type="button" onClick={() => onRemove(w.name)}
                  className="rounded-md border border-line px-2 py-0.5 text-xs text-ink-2 hover:bg-wash hover:text-ink">Remove</button>
              </td>
            )}
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
  block_side: "Block is a side block for now",
  ip_banned: "IP banned",
  stratum_started: "Stratum started",
  node_syncing: "Node syncing, work paused",
  node_unreachable: "Node not responding, work paused",
  node_ready: "Node ready, work resumed",
  node_switched: "Mining switched node",
  node_update_started: "Node version switch started",
  node_update_done: "Node version switch done",
  node_update_failed: "Node version switch failed",
  disk_low: "Disk space is low",
  cluster_active: "This server took over the shared address",
  cluster_standby: "This server is standing by",
  cluster_fault: "This server cannot mine; gave up the shared address",
  backup_downloaded: "Backup downloaded",
  chain_copied: "Chain data copied",
  chain_copy_failed: "Chain data copy failed",
  node_stop_requested: "Node stopped from the dashboard",
  node_start_requested: "Node started from the dashboard",
  node_restart_requested: "Node restarted from the dashboard",
};

const LEVELS = {
  good: { color: "var(--good)", icon: "M3 8.5l3 3 7-7" },
  warning: { color: "var(--warning)", icon: "M8 4v5M8 11.5v.5" },
  critical: { color: "var(--critical)", icon: "M4 4l8 8M12 4l-8 8" },
  unknown: { color: "var(--muted)", icon: "M8 5v4M8 11v.5" },
  info: { color: "var(--muted)", icon: "M5.5 8h5" },
};

// How each event reads at a glance; the label next to the icon always says what happened.
/** @type {Record<string, keyof typeof LEVELS>} */
const EVENT_LEVELS = {
  block_submitted: "info",
  block_rejected: "critical",
  block_final: "good",
  block_side: "warning",
  disk_low: "warning",
  cluster_active: "warning",
  cluster_standby: "info",
  cluster_fault: "critical",
  backup_downloaded: "info",
  ip_banned: "warning",
  stratum_started: "info",
  node_syncing: "warning",
  node_unreachable: "critical",
  node_ready: "good",
  node_switched: "info",
  node_update_started: "info",
  node_update_done: "good",
  node_update_failed: "critical",
  chain_copied: "good",
  chain_copy_failed: "critical",
  node_stop_requested: "warning",
  node_start_requested: "info",
  node_restart_requested: "info",
};

/** @param {{ level: keyof typeof LEVELS, className?: string }} props */
function LevelIcon({ level, className = "" }) {
  const l = LEVELS[level];
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" className={`shrink-0 ${className}`}>
      <circle cx="8" cy="8" r="7.5" fill={l.color} fillOpacity="0.16" />
      <path d={l.icon} fill="none" stroke={l.color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Health state with the reserved status colors; always paired with an icon and a label. @param {{ level: keyof typeof LEVELS, label: string }} props */
export function HealthBadge({ level, label }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-sm text-ink">
      <LevelIcon level={level} />
      {label}
    </span>
  );
}

/** @param {{ events: any[] }} props */
export function EventsList({ events }) {
  const blockUrl = useBlockUrl();
  if (events.length === 0) return <p className="text-sm text-muted">No events yet.</p>;
  return (
    <ul className="divide-y divide-line text-sm">
      {events.map((e) => (
        <li key={e.id} className="flex items-start justify-between gap-x-4 py-2">
          <span className="flex min-w-0 items-start gap-2 text-ink">
            <LevelIcon level={EVENT_LEVELS[e.type] ?? "info"} className="mt-0.5" />
            <span className="min-w-0">
              {EVENT_LABELS[/** @type {keyof typeof EVENT_LABELS} */ (e.type)] ?? e.type}
              {e.payload?.height !== undefined && (
                <span className="text-ink-2 tabular"> · height{" "}
                  {blockUrl(e.payload.hash)
                    ? <a href={blockUrl(e.payload.hash) ?? undefined} target="_blank" rel="noopener noreferrer" title="Open in the XELIS block explorer" className="hover:text-ink hover:underline">{formatInteger(e.payload.height)}</a>
                    : formatInteger(e.payload.height)}
                </span>
              )}
              {e.payload?.status && <span className="text-ink-2"> · {e.payload.status}</span>}
              {e.payload?.ip && <span className="text-ink-2"> · {e.payload.ip}</span>}
              {e.payload?.from && e.payload?.to && <span className="text-ink-2"> · {e.payload.from} → {e.payload.to}</span>}
              {e.payload?.target && <span className="text-ink-2"> · {e.payload.target === "image" ? "image's version" : e.payload.target}{e.payload.trigger && e.payload.trigger !== "dashboard" ? ` (${e.payload.trigger})` : ""}</span>}
              {e.payload?.node && !e.payload?.from && <span className="text-ink-2"> · {e.payload.node}</span>}
              {e.payload?.error && <span className="text-ink-2"> · {e.payload.error}</span>}
            </span>
          </span>
          <span className="shrink-0 pt-0.5 text-xs text-muted" title={formatTime(e.createdAt)}>{formatAgo(e.createdAt)}</span>
        </li>
      ))}
    </ul>
  );
}
