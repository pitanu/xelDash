import { useEffect, useRef, useState } from "react";
import { useCoin } from "../coin.js";
import { easeOut, numberIn, writeLike } from "../count-up.js";
import { motionAllowed } from "../motion.js";
import { XEL_DECIMALS, formatAgo, formatEffort, formatHashrate, formatInteger, formatTime, formatXel, shorten } from "../format.js";
import { useBlockUrl } from "../explorer.js";
import { formatMoney, usePrice } from "../price.js";

/** @param {{ title: React.ReactNode, subtitle?: string, action?: React.ReactNode, children: React.ReactNode, className?: string }} props */
export function Card({ title, subtitle, action, children, className = "" }) {
  return (
    <section className={`card pad ${className}`}>
      <header className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-ink">{title}</h2>
          {subtitle && <p className="mt-0.5 text-[13px] text-muted">{subtitle}</p>}
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

const COUNT_UP_MS = 1000;
const COUNT_CHANGE_MS = 600;

/**
 * A tile's number, counted up from zero when it first shows and moved to its new value when a refresh changes it (only the
 * number moves; the unit and the rest of the text stay). Screen readers get the final value. Without animation (turned off in
 * Settings, or the system asks for less motion) it is the plain text.
 * @param {{ text: string }} props
 */
function CountUp({ text }) {
  // The first frame already shows zero, so the final number does not flash before the count starts.
  const [shown, setShown] = useState(() => {
    const target = numberIn(text);
    return target && motionAllowed() ? writeLike(0, target) : text;
  });
  const from = useRef(/** @type {ReturnType<typeof numberIn>} */ (null));
  useEffect(() => {
    const target = numberIn(text);
    const previous = from.current;
    from.current = target;
    if (!target || !motionAllowed()) {
      setShown(text);
      return undefined;
    }
    // A unit that changed (KH/s to MH/s) is not counted through; the first value counts up from zero.
    const same = previous && previous.before === target.before && previous.after === target.after;
    if (previous && (!same || previous.value === target.value)) {
      setShown(text);
      return undefined;
    }
    const start = previous ? previous.value : 0;
    const duration = previous ? COUNT_CHANGE_MS : COUNT_UP_MS;
    const began = performance.now();
    let frame = 0;
    const step = (/** @type {number} */ now) => {
      const t = Math.min(1, (now - began) / duration);
      setShown(t < 1 ? writeLike(start + (target.value - start) * easeOut(t), target) : text);
      if (t < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [text]);
  if (shown === text) return <>{text}</>;
  return (
    <>
      <span className="sr-only">{text}</span>
      <span aria-hidden="true" className="tabular">{shown}</span>
    </>
  );
}

/**
 * A labelled figure. The hero tile (one per view) is larger and lightly tinted with the
 * accent; `aside` sits top-right, for a status badge.
 * @param {{ label: string, value: React.ReactNode, detail?: React.ReactNode, hero?: boolean,
 *   icon?: keyof typeof ICONS, aside?: React.ReactNode }} props
 */
export function StatTile({ label, value, detail, hero = false, icon, aside }) {
  return (
    <div className={`card ${hero ? "pad h-full" : "tile"}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="label flex items-center gap-1.5">
          {icon && (
            <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" className="shrink-0">
              <path d={ICONS[icon]} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          )}
          {label}
        </div>
        {aside}
      </div>
      <div className={`mono text-ink ${hero ? "hero-num mt-3" : "v"}`}>
        {typeof value === "string" ? <CountUp text={value} /> : value}
      </div>
      {detail && <div className="label mt-1">{detail}</div>}
    </div>
  );
}

// Block states as pills: final on the main chain in the accent, pending neutral, side in the highlight, orphaned or rejected in
// danger. Each has an icon and its name, so colour is never the only sign.
const STATUS = {
  "main-chain": { label: "Main chain", pill: "pill-final", icon: "M3 8.5l3 3 7-7" },
  side: { label: "Side block", pill: "pill-side", icon: "M4 8h8" },
  orphaned: { label: "Orphaned", pill: "pill-orphan", icon: "M4 4l8 8M12 4l-8 8" },
  rejected: { label: "Rejected", pill: "pill-orphan", icon: "M4 4l8 8M12 4l-8 8" },
  submitted: { label: "Pending", pill: "pill-pending", icon: "M8 4v4l2.5 2.5" },
};

/** A small icon for a pill, in its text colour. @param {{ d: string }} props */
function PillIcon({ d }) {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true" className="shrink-0">
      <path d={d} fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** @param {{ status: string }} props */
export function StatusBadge({ status }) {
  const s = STATUS[/** @type {keyof typeof STATUS} */ (status)] ?? { label: status, pill: "pill-pending", icon: "M8 5v4M8 11v.5" };
  return <span className={`pill ${s.pill}`}><PillIcon d={s.icon} />{s.label}</span>;
}

/**
 * A row of mutually exclusive choices. Options are values, or [value, label] pairs. Each is a button that says whether it is the
 * chosen one (aria-pressed).
 * @template {string} T
 * @param {{ value: T, options: readonly (T | readonly [T, string])[], onChange: (value: T) => void, label: string }} props
 */
export function Segmented({ value, options, onChange, label }) {
  return (
    <div role="group" aria-label={label} className="seg">
      {options.map((option) => {
        const [key, text] = typeof option === "string" ? [option, option] : option;
        return (
          <button key={key} type="button" aria-pressed={value === key} onClick={() => onChange(key)}>
            {text}
          </button>
        );
      })}
    </div>
  );
}

/** A table that scrolls sideways on its own when the page is narrow, edge to edge in its card. @param {{ children: React.ReactNode }} props */
function Table({ children }) {
  return (
    <div className="scroll-x -mx-6 max-[720px]:-mx-[18px]">
      <table className="tbl min-w-[32rem]">{children}</table>
    </div>
  );
}

/** @param {{ blocks: any[], showMiner?: boolean }} props */
export function BlocksTable({ blocks, showMiner = true }) {
  const coin = useCoin();
  const blockUrl = useBlockUrl();
  const { price } = usePrice();
  if (blocks.length === 0) return <p className="text-sm text-muted">No blocks found yet.</p>;
  return (
    <Table>
      <thead>
        <tr><th>Height</th><th>Status</th>{showMiner && <th>Miner</th>}
          <th className="r" title="Work spent on the round this block ended, as a share of the work expected per block">Effort</th>
          <th className="r">Reward</th><th className="r">Found</th></tr>
      </thead>
      <tbody className="mono">
        {blocks.map((b) => (
          <tr key={b.hash} className={`${Date.now() - Date.parse(b.foundAt) < 15_000 ? "block-new" : ""}`}>
            <td>
              {blockUrl(b.hash)
                ? <a href={blockUrl(b.hash) ?? undefined} target="_blank" rel="noopener noreferrer" title="Open in the XELIS block explorer" className="hover:text-ink hover:underline">{formatInteger(b.height)}</a>
                : <span title={b.hash}>{formatInteger(b.height)}</span>}
            </td>
            <td><StatusBadge status={b.status} /></td>
            {showMiner && (
              <td className="text-ink-2">
                {b.address ? <a href={`#/miner/${b.address}`} className="hover:text-ink hover:underline">{shorten(b.address)}</a> : "—"}
                {b.worker && <span className="text-muted"> · {b.worker}</span>}
              </td>
            )}
            <td className="r text-ink-2">{b.effort === null || b.effort === undefined ? "—" : formatEffort(b.effort)}</td>
            <td className="r">
              {formatXel(b.reward, coin)}
              {price && b.reward && (
                <span className="block text-xs text-muted" title="At the current price">
                  ≈ {formatMoney((Number(b.reward) / 10 ** XEL_DECIMALS) * price.price, price.currency, "amount")}
                </span>
              )}
            </td>
            <td className="r text-ink-2" title={formatTime(b.foundAt)}>{formatAgo(b.foundAt)}</td>
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
        <tr><th>Address</th><th className="r">Hashrate (1 h)</th>
          <th className="r">Workers</th><th className="r">Blocks</th><th className="r">Last seen</th></tr>
      </thead>
      <tbody className="mono">
        {miners.map((m) => (
          <tr key={m.address}>
            <td><a href={`#/miner/${m.address}`} className="text-ink hover:underline" title={m.address}>{shorten(m.address, 10)}</a></td>
            <td className="r">{formatHashrate(m.hashrate1h)}</td>
            <td className="r">{formatInteger(m.workers)}</td>
            <td className="r">{formatInteger(m.blocks)}</td>
            <td className="r text-ink-2">{formatAgo(m.lastSeen)}</td>
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
        <tr><th>Worker</th><th className="r">Hashrate (5 min)</th><th className="r">Hashrate (1 h)</th>
          <th className="r" title="What the miner reports about itself">Reported</th>
          <th className="r">Accepted (1 h)</th><th className="r">Rejected (1 h)</th><th className="r">Last seen</th></tr>
      </thead>
      <tbody className="mono">
        {workers.map((w) => (
          <tr key={w.name}>
            <td>
              <a href={`#/miner/${address}/worker/${encodeURIComponent(w.name)}`} className="text-ink hover:underline">{w.name}</a>
            </td>
            <td className="r">{formatHashrate(w.hashrate5m)}</td>
            <td className="r">{formatHashrate(w.hashrate1h)}</td>
            <td className="r text-ink-2">{formatHashrate(w.reportedHashrate)}</td>
            <td className="r">{formatInteger(w.accepted1h)}</td>
            <td className="r">{formatInteger(w.rejected1h)}</td>
            <td className="r text-ink-2">{formatAgo(w.lastSeen)}</td>
            {onRemove && (
              <td className="r">
                <button type="button" onClick={() => onRemove(w.name)}
                  className="btn btn-sm">Remove</button>
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
  node_no_peers: "Node has no peers",
  node_peers_back: "Node has peers again",
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

// Health levels: good in the accent, warning in the highlight, critical in danger; always with an icon and words.
const LEVELS = {
  good: { color: "var(--accent)", pill: "pill-final", icon: "M3 8.5l3 3 7-7" },
  warning: { color: "var(--gold)", pill: "pill-side", icon: "M8 4v5M8 11.5v.5" },
  critical: { color: "var(--danger)", pill: "pill-orphan", icon: "M4 4l8 8M12 4l-8 8" },
  unknown: { color: "var(--muted)", pill: "pill-pending", icon: "M8 5v4M8 11v.5" },
  info: { color: "var(--muted)", pill: "pill-pending", icon: "M5.5 8h5" },
};

// How each event reads at a glance; the label next to the icon always says what happened.
/** @type {Record<string, keyof typeof LEVELS>} */
const EVENT_LEVELS = {
  block_submitted: "info",
  block_rejected: "critical",
  block_final: "good",
  block_side: "warning",
  disk_low: "warning",
  node_no_peers: "critical",
  node_peers_back: "good",
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

/** The level icon on its own, for a note in small text. @param {{ level: keyof typeof LEVELS, className?: string }} props */
export function LevelIcon({ level, className = "" }) {
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
  return <span className={`pill ${LEVELS[level].pill}`}><PillIcon d={LEVELS[level].icon} />{label}</span>;
}

/**
 * Whether miners are given work, from Stratum's status: mining (and through which node), paused (and why), or Stratum down.
 * Null until the status is known.
 * @param {{ ok?: boolean, paused?: string | null, node?: string | null } | null | undefined} stratum
 * @returns {{ level: keyof typeof LEVELS, label: string } | null}
 */
export function miningState(stratum) {
  if (!stratum) return null;
  if (stratum.paused) return { level: "warning", label: stratum.paused === "syncing" ? "Paused: node syncing" : "Paused: node down" };
  if (stratum.ok) return { level: "good", label: stratum.node ? `Mining via ${stratum.node}` : "Mining" };
  return { level: "critical", label: "Stratum down" };
}

/** @param {{ events: any[] }} props */
export function EventsList({ events }) {
  const blockUrl = useBlockUrl();
  if (events.length === 0) return <p className="text-sm text-muted">No events yet.</p>;
  return (
    <ul className="row-list">
      {events.map((e) => (
        <li key={e.id} className="items-start! justify-between">
          <span className="flex min-w-0 items-start gap-2 text-ink">
            <LevelIcon level={EVENT_LEVELS[e.type] ?? "info"} className="mt-0.5" />
            <span className="min-w-0">
              {EVENT_LABELS[/** @type {keyof typeof EVENT_LABELS} */ (e.type)] ?? e.type}
              {e.payload?.height !== undefined && (
                <span className="mono text-ink-2"> · height{" "}
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
          <span className="label shrink-0 pt-0.5" title={formatTime(e.createdAt)}>{formatAgo(e.createdAt)}</span>
        </li>
      ))}
    </ul>
  );
}
