import { useState } from "react";
import { usePolled } from "../api.js";
import { useCoin } from "../coin.js";
import { Card, MinersTable, StatTile } from "../components/ui.jsx";
import WorkersCard from "../components/WorkersCard.jsx";
import { XEL_DECIMALS, formatAgo, formatEffort, formatHashrate, formatInteger, shorten } from "../format.js";
import Miner from "./Miner.jsx";

const ACTIVE_MS = 7 * 86_400_000;
// Seen this recently counts as connected now.
const NOW_MS = 2 * 60_000;
// Up to this many active addresses, their workers are shown right away.
const WORKERS_UP_TO = 10;

/** @param {number} fraction */
function formatShare(fraction) {
  const pct = fraction * 100;
  return `${pct.toLocaleString(undefined, { maximumFractionDigits: pct < 10 ? 2 : 1 })}%`;
}

/** The first letter of an address after its prefix, for the card's badge. @param {string} address */
const initial = (address) => (address.split(":")[1] ?? address).charAt(0).toUpperCase();

/** One address: its figures, then its workers. @param {{ m: any }} props */
function MinerCard({ m }) {
  const coin = useCoin();
  const encoded = encodeURIComponent(m.address);
  const miner = usePolled(`/api/v1/miners/${encoded}`);
  const rewards = usePolled(`/api/v1/rewards?range=30d&address=${encoded}`);
  // Time on in the last day, so a rig that mines a few hours a day is not read as a slow one (see ActivityCard).
  const activity = usePolled(`/api/v1/activity?address=${encoded}&range=24h`, { intervalMs: 60_000 });
  const earned = (rewards.data?.points ?? []).reduce((/** @type {bigint} */ sum, /** @type {any} */ d) => sum + BigInt(d.reward ?? 0), 0n);
  const workers = Number(m.workers ?? 0);
  return (
    <WorkersCard address={m.address} workers={miner.data?.workers} onChanged={miner.reload} hidden={miner.data?.workersHidden ? miner.data.workerTotals : null}
      subtitle={`${formatInteger(workers)} worker${workers === 1 ? "" : "s"} · last seen ${formatAgo(m.lastSeen)}. Workers without shares for 7 days are left out.`}
      title={
        <span className="flex min-w-0 items-center gap-3">
          <span aria-hidden="true" className="grid h-9 w-9 shrink-0 place-items-center rounded-[10px] bg-accent-soft font-semibold text-accent">{initial(m.address)}</span>
          <a href={`#/miner/${encoded}`} className="mono min-w-0 truncate text-ink hover:underline" title={m.address}>{shorten(m.address, 12)}</a>
        </span>
      }
      summary={
        <dl className="m-0 mb-4 flex flex-wrap gap-x-10 gap-y-3">
          <div><dt className="label">Hashrate · 1 h</dt><dd className="mono m-0 text-lg font-medium text-ink">{formatHashrate(m.hashrate1h)}</dd></div>
          <div>
            <dt className="label">On · 24 h</dt>
            <dd className="mono m-0 text-lg font-medium text-ink">{activity.data?.dutyCycle != null ? formatEffort(activity.data.dutyCycle) : "—"}</dd>
          </div>
          <div><dt className="label">Blocks</dt><dd className="mono m-0 text-lg font-medium text-ink">{formatInteger(m.blocks)}</dd></div>
          <div>
            <dt className="label">Earned · 30 d</dt>
            <dd className="mono m-0 text-lg font-medium text-ink">
              {rewards.data ? `${(Number(earned) / 10 ** XEL_DECIMALS).toLocaleString(undefined, { maximumFractionDigits: 2 })} ${coin}` : "—"}
            </dd>
          </div>
        </dl>
      } />
  );
}

/**
 * The miners on this server. With one active address, its page; with a few, a card per address with its workers; with many, the
 * list of addresses. A search box narrows any of them to an address or worker.
 */
export default function Miners() {
  const miners = usePolled("/api/v1/miners");
  const [find, setFind] = useState("");
  if (!miners.data) return miners.error ? <p className="text-sm text-danger">Unable to reach the xelDash API.</p> : null;
  const active = miners.data.miners.filter((/** @type {any} */ m) => Date.now() - Date.parse(m.lastSeen) < ACTIVE_MS);
  if (active.length === 0) return <Card title="Miners">
    <p className="text-sm text-muted">No miner has connected in the last 7 days.</p>
    <p className="mt-2 text-sm"><a href="#/connect" className="text-ink underline decoration-line underline-offset-2">How to connect a miner</a></p>
  </Card>;
  if (active.length === 1) return <Miner address={active[0].address} back={false} />;

  const sum = (/** @type {string} */ key) => active.reduce((/** @type {number} */ total, /** @type {any} */ m) => total + Number(m[key] ?? 0), 0);
  const now = active.filter((/** @type {any} */ m) => Date.now() - Date.parse(m.lastSeen) < NOW_MS).length;
  const accepted = sum("accepted1h");
  const rejected = sum("rejected1h");
  const query = find.trim().toLowerCase();
  // Addresses match on any part; worker names are known for the cards, which filter their own tables.
  const shown = query ? active.filter((/** @type {any} */ m) => m.address.toLowerCase().includes(query)) : active;

  return (
    <div className="flex flex-col gap-5">
      <div className="page-head">
        <div><h1>Miners</h1><p>Every address mining on this server, and its rigs.</p></div>
        <div className="flex items-center gap-2">
          <label htmlFor="find-miner" className="hide-sm text-[13px] text-ink-2">Find</label>
          <input id="find-miner" className="field w-64 max-w-full" type="search" placeholder="Address" value={find} onChange={(e) => setFind(e.target.value)} />
        </div>
      </div>
      <div className="tiles">
        <StatTile label="Miners" value={formatInteger(active.length)} detail={`${formatInteger(now)} seen in the last 2 minutes`} />
        <StatTile label="Workers" value={formatInteger(sum("workers"))} detail="with shares in the last 7 days" />
        <StatTile label="Total hashrate · 1 h" value={formatHashrate(sum("hashrate1h"))} detail={`${formatInteger(active.length)} addresses`} />
        <StatTile label="Rejected · 1 h" value={accepted + rejected > 0 ? formatShare(rejected / (accepted + rejected)) : "—"}
          detail={`${formatInteger(rejected)} of ${formatInteger(accepted + rejected)} shares`} />
      </div>
      {shown.length === 0 && <p className="text-sm text-muted">No address matches “{find}”.</p>}
      {active.length > WORKERS_UP_TO
        ? shown.length > 0 && <Card title={`${shown.length} active addresses`} subtitle="Seen in the last 7 days"><MinersTable miners={shown} /></Card>
        : shown.map((/** @type {any} */ m) => <MinerCard key={m.address} m={m} />)}
    </div>
  );
}
