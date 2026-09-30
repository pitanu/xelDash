import { usePolled } from "../api.js";
import { Card, MinersTable } from "../components/ui.jsx";
import WorkersCard from "../components/WorkersCard.jsx";
import { formatHashrate, shorten } from "../format.js";
import Miner from "./Miner.jsx";

const ACTIVE_MS = 7 * 86_400_000;
// Up to this many active addresses, their workers are shown right away.
const WORKERS_UP_TO = 10;

/** One address and its workers. @param {{ address: string, hashrate: string }} props */
function MinerWorkers({ address, hashrate }) {
  const encoded = encodeURIComponent(address);
  const miner = usePolled(`/api/v1/miners/${encoded}`);
  return (
    <WorkersCard address={address} workers={miner.data?.workers} onChanged={miner.reload}
      title={<a href={`#/miner/${encoded}`} className="hover:underline" title={address}>{shorten(address, 12)} · {formatHashrate(hashrate)}</a>} />
  );
}

/**
 * The miners on this server. With one active address, its page; with a few, each address's
 * workers; with many, the list of addresses.
 */
export default function Miners() {
  const miners = usePolled("/api/v1/miners");
  if (!miners.data) return miners.error ? <p className="text-sm text-critical">Unable to reach the xelDash API.</p> : null;
  const active = miners.data.miners.filter((/** @type {any} */ m) => Date.now() - Date.parse(m.lastSeen) < ACTIVE_MS);
  if (active.length === 0) return <Card title="Miners">
    <p className="text-sm text-muted">No miner has connected in the last 7 days.</p>
    <p className="mt-2 text-sm"><a href="#/setup" className="text-ink underline decoration-line underline-offset-2">How to connect a miner</a></p>
  </Card>;
  if (active.length === 1) return <Miner address={active[0].address} back={false} />;
  return (
    <div className="space-y-6">
      <h1 className="text-lg font-semibold text-ink">Miners</h1>
      {active.length > WORKERS_UP_TO
        ? <Card title={`${active.length} active addresses`} subtitle="Seen in the last 7 days"><MinersTable miners={active} /></Card>
        : active.map((/** @type {any} */ m) => <MinerWorkers key={m.address} address={m.address} hashrate={m.hashrate1h} />)}
    </div>
  );
}
