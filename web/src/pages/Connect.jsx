import { useState } from "react";
import { usePolled } from "../api.js";
import { Card, HealthBadge } from "../components/ui.jsx";
import { useOperatorView } from "../server-mode.js";
import { formatAgo } from "../format.js";
import { ConnectPanel } from "./Setup.jsx";

const WALLET_URL = "https://wallet.xelis.io";
// The shape of an address, as the API checks it (the node checks the rest when a miner logs in).
const ADDRESS = /^(xel|xet):[a-z0-9]{30,120}$/;

/**
 * Whether a miner with this address has connected: its workers once one has, "waiting" until then. Checked every 10 s.
 * @param {{ address: string }} props
 */
function WorkerWatch({ address }) {
  const miner = usePolled(`/api/v1/miners/${encodeURIComponent(address)}`, { intervalMs: 10_000 });
  const workers = /** @type {{ name: string, lastSeen: string }[]} */ (miner.data?.workers ?? []);
  // A server that keeps worker names private sends how many there are, not the list.
  const hiddenCount = miner.data?.workersHidden ? Number(miner.data.workerTotals?.count ?? 0) : null;
  if (hiddenCount !== null && hiddenCount > 0) {
    return <HealthBadge level="good" label={`${hiddenCount} worker${hiddenCount === 1 ? "" : "s"} connected`} />;
  }
  if (workers.length === 0) {
    return (
      <div className="flex items-center gap-2 rounded-[10px] bg-panel-2 px-3 py-2.5 text-[13px] text-ink-2">
        <span className="dot animate-pulse text-gold" aria-hidden="true" />Waiting for a worker on this address…
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      <HealthBadge level="good" label={`${workers.length} worker${workers.length === 1 ? "" : "s"} connected`} />
      <ul className="row-list">
        {workers.map((w) => (
          <li key={w.name} className="justify-between">
            <a href={`#/miner/${encodeURIComponent(address)}/worker/${encodeURIComponent(w.name)}`} className="text-ink hover:underline">{w.name}</a>
            <span className="label">{formatAgo(w.lastSeen)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * How to point a miner at this server, for the operator and a public server's visitors alike: the addresses and settings, a command
 * for each tested miner (with the address typed here), three steps, and whether a miner with that address has connected yet.
 */
export default function Connect() {
  const operator = useOperatorView();
  const info = usePolled("/api/v1/connect", { intervalMs: 60_000 }).data;
  const [typed, setTyped] = useState(/** @type {string | null} */ (null));
  const prefix = info?.network === "mainnet" || !info ? "xel" : "xet";
  // The operator starts from the server's mining address; a visitor starts empty and types their own.
  const raw = (typed ?? (operator ? info?.address : null) ?? "").trim();
  // A pasted "address.worker" (a whole user name) counts as its address: addresses never contain a dot.
  const dot = raw.indexOf(".");
  const address = dot > 0 && ADDRESS.test(raw.slice(0, dot)) ? raw.slice(0, dot) : raw;
  const valid = ADDRESS.test(address) && address.startsWith(`${prefix}:`);
  // The two easy mix-ups: the pool address pasted into the address field, and pointing a miner at this page's port.
  const poolPasted = /:\/\/|^stratum/i.test(raw);
  const pagePort = window.location.port || (window.location.protocol === "https:" ? "443" : "80");

  return (
    <div className="flex flex-col gap-5">
      <div className="page-head">
        <div>
          <h1>{operator ? "Connect a miner" : "Mine here"}</h1>
          <p>
            {operator
              ? "Point any XELIS miner at this server. Blocks it finds pay the address it mines with."
              : "Solo mining with your own XELIS address: a block your rig finds pays that address. This server holds no coins and takes no fee."}
          </p>
        </div>
      </div>
      <div className="split">
        <div className="main flex flex-col gap-5">
          <section className="card pad">
            <label htmlFor="connect-address" className="mb-1.5 block font-semibold text-ink">Your XELIS address</label>
            <input id="connect-address" className="field mono" type="text" spellCheck={false} autoComplete="off"
              placeholder={`${prefix}:…`} value={typed ?? (operator ? info?.address ?? "" : "")} onChange={(e) => setTyped(e.target.value)} />
            <div className="label mt-2">
              {poolPasted
                ? "That is the pool address. Your wallet address goes here; the pool address is below, for the miner."
                : address !== raw && valid
                ? "Only the address is needed here: the part after the dot is a worker name, and the commands below add one."
                : address && !valid
                ? `That does not look like a ${info?.network ?? "XELIS"} address: it starts with ${prefix}: and is copied in full from your wallet.`
                : <>Used in the settings and commands below. No address yet? Make one in the official{" "}
                  <a href={WALLET_URL} target="_blank" rel="noopener noreferrer" className="underline decoration-line underline-offset-2">XELIS web wallet</a>.
                  {!operator && <> A login without an address is refused.</>}</>}
            </div>
          </section>
          {/* A visitor never gets the server's own mining address (the API leaves it out too): only the one they type. */}
          {info ? <ConnectPanel info={operator ? info : { ...info, address: null }} address={valid ? address : null} /> : <Card title="Loading">Fetching this server's settings…</Card>}
        </div>
        <section className="card pad side flex flex-col gap-5">
          <h2 className="text-base font-semibold text-ink">Three steps</h2>
          <ol className="m-0 flex list-none flex-col gap-4 p-0">
            {[
              ["Copy the pool address", `${info?.tlsPort ? "Use the TLS one (stratum+ssl) when mining over the internet." : "The Stratum address, with its port."}${info ? ` Not this page's port (${pagePort}): that is the dashboard, and miners cannot connect to it.` : ""}`],
              ["Log in as address.worker", "Each rig gets its own worker name, so you can tell them apart."],
              ["Watch it appear", "New workers show up below, and on Miners, within a minute."],
            ].map(([title, text], i) => (
              <li key={title} className="flex gap-3">
                <span className="mono grid h-7 w-7 shrink-0 place-items-center rounded-full bg-accent-soft text-[13px] font-medium text-accent">{i + 1}</span>
                <div><b className="font-semibold text-ink">{title}</b><div className="label">{text}</div></div>
              </li>
            ))}
          </ol>
          {valid ? <WorkerWatch address={address} /> : <div className="label">Enter your address above to see your workers here as they connect.</div>}
          {operator && <a href="#/setup" className="text-[13px]">The full setup guide, for a first install</a>}
        </section>
      </div>
    </div>
  );
}
