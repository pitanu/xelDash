import { usePolled } from "../api.js";
import { formatAgo, shorten } from "../format.js";
import { Card } from "./ui.jsx";

/**
 * A rejected connection or login in words a beginner can act on. `network` is "mainnet",
 * "testnet" or "devnet"; the address prefix (xel: or xet:) tells the two kinds of network apart.
 * @param {{ kind: string, reason: string, address: string | null, detail: string | null, ip: string | null, masked: boolean }} p
 * @param {string} network
 */
export function explainProblem(p, network) {
  const wanted = network === "mainnet" ? "xel:" : "xet:";
  const other = network === "mainnet" ? "xet:" : "xel:";
  const from = p.masked || !p.ip ? "A computer on your network (or this one)" : `A computer at ${p.ip}`;
  const address = p.address ? shorten(p.address, 10) : "";
  switch (p.reason) {
    case "not on your local network":
      return { what: `${from} tried to connect and was turned away.`, fix: "xelDash only accepts miners on your own network. If this is one of your computers, check it is on the same network, or allow more networks with XELDASH_ALLOWED_NETWORKS in the .env file." };
    case "banned":
      return { what: `${from} was blocked for a while after sending a lot of invalid data.`, fix: "Check the mining program's settings (algorithm xelishashv3, the right pool address). It can connect again after the block ends." };
    case "too many connections":
      return { what: `${from} opened too many connections at once.`, fix: "Run one mining program per computer. Each one should use a different worker name." };
    case "invalid_address":
      if (p.address?.toLowerCase().startsWith(other)) {
        return { what: `${from} logged in with ${address}, which looks like a ${network === "mainnet" ? "test-network" : "mainnet"} address.`, fix: `This server is on ${network}, which needs an address starting with ${wanted} Use the address from your wallet (see step 2).` };
      }
      return { what: `${from} logged in with the address ${address || "(none)"}, which was refused.`, fix: `Addresses on ${network} start with ${wanted} and are always exactly as your wallet shows them. Copy it again in full; one missing letter makes it invalid.` };
    case "no_address":
      return { what: `${from} logged in without a wallet address.`, fix: "Add your address in step 2 of the setup guide, or put it in the mining program's settings (the user or wallet field)." };
    case "node_not_ready":
      return { what: `${from} tried to connect while the XELIS node was still catching up.`, fix: "This is normal on a new install. Wait until step 1 shows a green check; most mining programs retry by themselves." };
    case "bad_login":
    case "bad_request":
      return { what: `${from} connected but sent something xelDash could not understand.`, fix: "Check the mining program is set up for XELIS (algorithm xelishashv3) and the pool address is a stratum address, not the dashboard's." };
    case "second_address":
      return { what: `${from} tried to use two different wallet addresses on one connection.`, fix: "Use one address per mining program." };
    case "too_many_workers":
      return { what: `${from} tried to log in too many workers on one connection.`, fix: "Use a separate connection for each computer." };
    default:
      return { what: `${from} could not connect (${p.reason}).`, fix: null };
  }
}

/**
 * Connections and logins turned away in the last day, with what they mean and what to try. Shows
 * nothing when all is well.
 * @param {{ network: string }} props
 */
export default function ProblemsCard({ network }) {
  const problems = usePolled("/api/v1/problems", { intervalMs: 10_000 });
  // Problems that read the same (for example two kinds of unreadable login) are shown once.
  /** @type {Map<string, { what: string, fix: string | null, count: number, lastSeen: string }>} */
  const merged = new Map();
  for (const p of problems.data?.problems ?? []) {
    const { what, fix } = explainProblem(p, network);
    const seen = merged.get(what);
    if (seen) {
      seen.count += p.count;
      if (p.lastSeen > seen.lastSeen) seen.lastSeen = p.lastSeen;
    } else {
      merged.set(what, { what, fix, count: p.count, lastSeen: p.lastSeen });
    }
  }
  const list = [...merged.values()];
  if (list.length === 0) return null;
  return (
    <Card title="Connection problems" subtitle="Miners that tried to connect in the last day and were turned away. If you are trying to connect a miner, the reason is here.">
      <ul className="divide-y divide-line text-sm">
        {list.map(({ what, fix, ...p }) => {
          return (
            <li key={what} className="py-3 first:pt-0 last:pb-0">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="text-ink">{what}</span>
                <span className="text-xs text-muted">{p.count > 1 ? `${p.count} times, ` : ""}last {formatAgo(p.lastSeen)}</span>
              </div>
              {fix && <p className="mt-1 text-xs text-ink-2">{fix}</p>}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
