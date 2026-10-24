import { useState } from "react";
import { usePolled } from "../api.js";
import { useCoin } from "../coin.js";
import { EarningsText } from "../components/Earnings.jsx";
import HashrateChart from "../components/HashrateChart.jsx";
import SharesChart from "../components/SharesChart.jsx";
import DiskWarning from "../components/DiskWarning.jsx";
import SetupBanner from "../components/SetupBanner.jsx";
import { SupportNudge } from "../components/SupportCard.jsx";
import { useOperatorView } from "../server-mode.js";
import { BlocksTable, Card, CountUp, EventsList, HealthBadge, StatTile, miningState } from "../components/ui.jsx";
import { XEL_DECIMALS, formatAgo, formatBucket, formatCompact, formatDuration, formatEffort, formatHashrate, formatInteger, formatTime } from "../format.js";

/** @param {{ status: string, count: string }[]} rows @param {string} status */
function countOf(rows, status) {
  return Number(rows.find((r) => r.status === status)?.count ?? 0);
}

/** A share of a whole as a percentage, with more digits when it is small. @param {number} fraction */
function formatShare(fraction) {
  const pct = fraction * 100;
  return `${pct.toLocaleString(undefined, { maximumFractionDigits: pct < 0.1 ? 3 : pct < 10 ? 2 : 1 })}%`;
}

/**
 * The round's effort as a bar: the mark is 100%, an average round, and the bar spans at least 200% so the mark sits in the middle.
 * @param {{ effort: number }} props
 */
function EffortBar({ effort }) {
  const span = Math.max(2, Math.ceil(effort));
  return (
    <div className="relative mt-2 h-2 rounded-full bg-accent-soft" role="meter" aria-label="Current round effort"
      aria-valuemin={0} aria-valuemax={span * 100} aria-valuenow={Math.round(effort * 100)}>
      <div className="h-full rounded-full bg-accent" style={{ width: `${Math.min(100, (effort / span) * 100)}%` }} />
      <div className="absolute -top-1 h-4 w-px bg-ink-2" style={{ left: `${100 / span}%` }} aria-hidden="true" />
    </div>
  );
}

/**
 * When the next block may come, and how the current round is going: expected time and earnings at last hour's hashrate, the
 * round's effort, blocks found, luck over 30 days, and the median effort of the rounds that found a block.
 * @param {{ o: any, found: number, foundDetail: string | null, luck30: number | null, blocks30: number }} props
 */
function NextBlockCard({ o, found, foundDetail, luck30, blocks30 }) {
  const luck = o?.luck;
  const effort = luck?.round?.effort ?? 0;
  const median = luck?.medianBlockEffort;
  const hashrate = Number(o?.miningEstimates?.["1h"]?.estimatedHashesPerSecond ?? 0);
  return (
    <section className="card pad side flex flex-col gap-5">
      <h2 className="text-base font-semibold text-ink">Next block</h2>
      <div>
        <div className="label">Expected in about</div>
        <div className="mono mt-1 text-[28px] font-medium text-ink">
          {hashrate > 0 ? <CountUp text={formatDuration(o.miningEstimates["1h"].expectedTimeToBlockSeconds)} /> : "—"}
        </div>
        <div className="label mt-1">
          {hashrate > 0 ? <>At last hour's hashrate and today's network difficulty{o?.node?.miner_reward
            ? <EarningsText prefix=" · " hashrate={hashrate} difficulty={o.network.difficulty} minerReward={o.node.miner_reward} /> : null}</>
            : "Waiting for shares: point a miner at this server."}
        </div>
      </div>
      {luck?.trackedSince ? (
        <div>
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-[13px] text-ink-2">Current round effort</span>
            <span className="mono font-medium text-ink">{formatEffort(effort)}</span>
          </div>
          <EffortBar effort={effort} />
          <div className="label mt-2">
            Under 100% means luckier than average. The mark is 100%, an average round.
            {luck.round.startedAt && <> Started <span title={formatTime(luck.round.startedAt)}>{formatAgo(luck.round.startedAt)}</span>.</>}
          </div>
        </div>
      ) : (
        <p className="label">Round effort appears once shares arrive.</p>
      )}
      <div className="grid grid-cols-2 gap-4 border-t border-line pt-4">
        <div>
          <div className="label">Blocks found</div>
          <div className="mono mt-1 text-xl font-medium text-ink">{formatInteger(found)}</div>
          {foundDetail && <div className="label mt-0.5">{foundDetail}</div>}
        </div>
        <div>
          <div className="label">Luck, 30 days</div>
          <div className="mono mt-1 text-xl font-medium text-ink" title={`${formatInteger(blocks30)} found in 30 days`}>
            {luck30 === null ? "—" : formatEffort(luck30)}
          </div>
        </div>
        <div className="col-span-2">
          <div className="label">Median effort of found blocks</div>
          <div className="text-[13px] text-ink-2">
            {median?.median == null
              ? "No blocks found since effort tracking began."
              : <><span className="mono font-medium text-ink">{formatEffort(median.median)}</span> over {median.blocks} block{median.blocks === 1 ? "" : "s"}
                {median.median < 1 ? ": blocks came quicker than average." : ": blocks took longer than average."}</>}
          </div>
        </div>
      </div>
      {luck?.trackedSince && <div className="label">Tracked since {formatTime(luck.trackedSince)}.</div>}
    </section>
  );
}

/** Nodes, mining and the database at a glance, from the status the Health page shows in full. @param {{ status: any }} props */
function HealthSummary({ status }) {
  if (!status) return null;
  const stratum = miningState(status.services?.stratum);
  const own = (status.nodes ?? []).filter((/** @type {any} */ n) => !n.fallback);
  /** @type {{ key: string, level: "good" | "warning" | "critical" | "info", state: string, name: string, detail: string }[]} */
  const rows = own.map((/** @type {any} */ n) => ({
    key: n.label,
    level: !n.ok ? "critical" : n.syncing ? "warning" : "good",
    state: !n.ok ? "Down" : n.syncing ? "Syncing" : "In sync",
    name: `Node ${n.label}`,
    detail: n.ok ? `${formatInteger(n.peers)} peers${n.active ? " · mining" : ""}` : "not responding",
  }));
  if (stratum) rows.push({ key: "stratum", level: stratum.level === "good" ? "good" : stratum.level === "warning" ? "warning" : "critical",
    state: stratum.level === "good" ? "Mining" : stratum.level === "warning" ? "Paused" : "Down", name: "Stratum", detail: stratum.label });
  if (status.services?.database) rows.push({ key: "database", level: status.services.database.ok ? "good" : "critical",
    state: status.services.database.ok ? "OK" : "Down", name: "Database", detail: status.services.database.ok ? "connected" : "not reachable" });
  return (
    <section className="card pad side">
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <h2 className="text-base font-semibold text-ink">Health</h2>
        <a href="#/health" className="text-[13px]">Details</a>
      </div>
      <ul className="row-list">
        {rows.map((r) => (
          <li key={r.key}>
            <HealthBadge level={r.level} label={r.state} />
            <span className="min-w-0 flex-1 text-ink">{r.name}</span>
            <span className="label truncate">{r.detail}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

export default function Overview() {
  // The setup guide, disk warning and "you found a block" note are for the server's operator, not a public server's visitors.
  const operator = useOperatorView();
  const coin = useCoin();
  const [range, setRange] = useState("24h");
  const overview = usePolled("/api/v1/overview", { everyBlock: true });
  const history = usePolled(`/api/v1/hashrate?range=${range}`);
  const blocks = usePolled("/api/v1/blocks?limit=12");
  const events = usePolled("/api/v1/events?limit=5");
  const status = usePolled("/api/v1/status", { everyBlock: true });
  const rewards = usePolled("/api/v1/rewards?range=30d");

  const o = overview.data;
  const blockRows = o?.blocks ?? [];
  const found = blockRows.reduce((/** @type {number} */ sum, /** @type {{ status: string, count: string }} */ r) => sum + (r.status === "rejected" ? 0 : Number(r.count)), 0);
  const foundToday = blockRows.reduce((/** @type {number} */ sum, /** @type {{ status: string, last_24h?: string }} */ r) =>
    sum + (r.status === "rejected" ? 0 : Number(r.last_24h ?? 0)), 0);
  // Said only while there is one, so the detail fits on one line.
  const pending = countOf(blockRows, "submitted");
  const workers = Number(o?.miners?.active_workers ?? 0);

  // The last 30 days, from the rewards history: XEL earned (main-chain and side blocks), and luck (blocks found per block expected).
  const days = /** @type {{ blocks: number, reward: string, expectedBlocks: number }[]} */ (rewards.data?.points ?? []);
  const earned30 = days.reduce((sum, d) => sum + BigInt(d.reward ?? 0), 0n);
  const blocks30 = days.reduce((sum, d) => sum + d.blocks, 0);
  const expected30 = days.reduce((sum, d) => sum + d.expectedBlocks, 0);
  const luck30 = expected30 > 0 ? blocks30 / expected30 : null;

  const hashrate = Number(o?.miningEstimates?.["1h"]?.estimatedHashesPerSecond ?? 0);
  const networkHashrate = Number(o?.network?.hashrate ?? 0);
  const [heroValue, heroUnit] = splitUnit(formatHashrate(o?.miningEstimates?.["1h"]?.estimatedHashesPerSecond));
  const accepted = Number(o?.shares?.accepted_1h ?? 0);
  const rejected = Number(o?.shares?.rejected_1h ?? 0);
  const activeNode = (status.data?.nodes ?? []).find((/** @type {any} */ n) => n.active) ?? status.data?.node;

  return (
    <div className="flex flex-col gap-5">
      {operator && <SetupBanner />}
      {operator && <DiskWarning />}
      {overview.error && !o && (/** @type {any} */ (overview.error).code === "node_unavailable"
        ? <p className="text-sm text-ink-2">The XELIS node is not answering yet. On a first start that takes a while: the blockchain is
          downloaded and then caught up with the network. <a href="#/health" className="underline decoration-line underline-offset-2 hover:text-ink">Health</a> shows how it is going.</p>
        : <p className="text-sm text-danger">Unable to reach the xelDash API.</p>)}

      <div className="split">
        <section className="card pad main">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 className="text-[13px] font-medium text-ink-2">Hashrate · last hour</h2>
              <div className="mt-2 flex flex-wrap items-baseline gap-x-3 gap-y-2">
                <span className="mono hero-num text-ink"><CountUp text={heroValue} /></span>
                {heroUnit && <span className="text-lg text-ink-2">{heroUnit}</span>}
                {o && <HealthBadge level={workers > 0 ? "good" : "info"} label={`${formatInteger(workers)} worker${workers === 1 ? "" : "s"} online`} />}
              </div>
              <div className="label mt-2">
                {o && !hashrate ? "Waiting for shares: point a miner at this server."
                  : `Last 5 min: ${formatHashrate(o?.miningEstimates?.["5m"]?.estimatedHashesPerSecond)} · ${formatInteger(o?.miners?.active_miners)} miner address${o?.miners?.active_miners === "1" ? "" : "es"}`}
              </div>
            </div>
          </div>
          <div className="mt-5">
            <div className="label mb-2">{history.data ? `Accepted share difficulty per second, ${formatBucket(history.data.bucketSeconds)} buckets` : " "}</div>
            <HashrateChart points={history.data?.points ?? null} dimmed={history.loading} range={range} onRangeChange={setRange} />
          </div>
        </section>
        <NextBlockCard o={o} found={found} luck30={luck30} blocks30={blocks30}
          foundDetail={o ? `${formatInteger(foundToday)} in 24 h${pending ? ` · ${pending} pending` : ""}` : null} />
      </div>

      <div className="tiles">
        <StatTile label="Shares accepted · 1 h" value={formatInteger(o?.shares?.accepted_1h)}
          detail={o ? `${formatInteger(rejected)} rejected${accepted + rejected > 0 ? ` (${formatShare(rejected / (accepted + rejected))})` : ""}` : undefined} />
        <StatTile label="Earned · 30 days" value={rewards.data ? `${(Number(earned30) / 10 ** XEL_DECIMALS).toLocaleString(undefined, { maximumFractionDigits: 2 })} ${coin}` : "—"}
          detail={rewards.data ? `${formatInteger(blocks30)} block${blocks30 === 1 ? "" : "s"} · no pool fees` : undefined} />
        <StatTile label="Network hashrate" value={networkHashrate ? formatHashrate(networkHashrate) : "—"}
          detail={o ? `${networkHashrate && hashrate ? `your share ${formatShare(hashrate / networkHashrate)} · ` : ""}difficulty ${formatCompact(o.network.difficulty)}` : undefined} />
        <StatTile label="Block height" value={formatInteger(o?.node?.height)}
          detail={o ? [o.node?.network, o.node?.version, activeNode?.peers !== undefined ? `${formatInteger(activeNode.peers)} peers` : null].filter(Boolean).join(" · ") || undefined : undefined} />
      </div>

      {operator && <SupportNudge network={o?.node?.network} blocks={countOf(blockRows, "main-chain")} />}

      <Card title="Shares" subtitle="Accepted, stale and invalid shares per bucket, for the range chosen above">
        <SharesChart points={history.data?.points ?? null} dimmed={history.loading} />
      </Card>

      <div className="split">
        <section className="card pad main">
          <div className="mb-4 flex items-baseline justify-between gap-2">
            <h2 className="text-base font-semibold text-ink">Recent blocks</h2>
            <a href="#/blocks" className="text-[13px]">All blocks</a>
          </div>
          {blocks.data && <BlocksTable blocks={blocks.data.blocks} />}
        </section>
        <div className="side flex flex-col gap-5">
          <HealthSummary status={status.data} />
          {/* Recent events are the operator's (a public server's visitors do not get them). The latest few, so the column stays about as
              tall as the blocks beside it; Health lists more. */}
          {operator && (
            <Card title="Recent events" action={<a href="#/health" className="text-[13px]">All events</a>}>
              {events.data && <EventsList events={events.data.events} />}
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}

/** "8.24 KH/s" as ["8.24", "KH/s"], so the number can be large and the unit small. @param {string} text */
function splitUnit(text) {
  const i = text.lastIndexOf(" ");
  return i > 0 ? [text.slice(0, i), text.slice(i + 1)] : [text, ""];
}
