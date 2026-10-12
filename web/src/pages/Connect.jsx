import { usePolled } from "../api.js";
import { Card } from "../components/ui.jsx";
import { ConnectPanel } from "./Setup.jsx";

/** How to mine on this server, for anyone: the settings for each miner, with your own address. The public view's "Mine here" page. */
export default function Connect() {
  const info = usePolled("/api/v1/connect", { intervalMs: 60_000 }).data;
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-ink">Mine here</h1>
        <p className="mt-1 text-sm text-ink-2">
          Solo mining with your own XELIS address: when one of your rigs finds a block, its reward goes straight to that address. This
          server holds no coins and takes no fee. Use your own address as the user name, with a worker name after a dot
          (<code>{info?.network === "mainnet" || !info ? "xel" : "xet"}:YOUR_ADDRESS.rig1</code>); a login without an address is refused.
        </p>
      </div>
      {info ? <ConnectPanel info={info} /> : <Card title="Loading">Fetching this server's settings…</Card>}
    </div>
  );
}
