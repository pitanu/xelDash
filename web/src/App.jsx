import { useEffect, useState } from "react";
import { usePolled } from "./api.js";
import { BlocksTable, Card } from "./components/ui.jsx";
import Miner from "./pages/Miner.jsx";
import Overview from "./pages/Overview.jsx";
import Worker from "./pages/Worker.jsx";

function useHashRoute() {
  const [hash, setHash] = useState(window.location.hash);
  useEffect(() => {
    const onChange = () => {
      setHash(window.location.hash);
      window.scrollTo(0, 0);
    };
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return hash.replace(/^#/, "") || "/";
}

function Blocks() {
  const blocks = usePolled("/api/v1/blocks?limit=200");
  return (
    <div className="space-y-4">
      <a href="#/" className="text-xs text-ink-2 hover:text-ink hover:underline">← Overview</a>
      <Card title="Blocks" subtitle="Most recent 200">{blocks.data && <BlocksTable blocks={blocks.data.blocks} />}</Card>
    </div>
  );
}

export default function App() {
  const route = useHashRoute();
  const workerMatch = /^\/miner\/([^/]+)\/worker\/(.+)$/.exec(route);
  const minerMatch = /^\/miner\/([^/]+)$/.exec(route);
  let page = <Overview />;
  if (workerMatch) {
    const address = decodeURIComponent(workerMatch[1]);
    const name = decodeURIComponent(workerMatch[2]);
    page = <Worker key={route} address={address} name={name} />;
  } else if (minerMatch) page = <Miner key={minerMatch[1]} address={decodeURIComponent(minerMatch[1])} />;
  else if (route === "/blocks") page = <Blocks />;

  return (
    <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6">
      <header className="mb-6 flex items-center justify-between">
        <a href="#/" className="text-base font-semibold text-ink">xelDash</a>
        <span className="text-xs text-muted">Solo mining dashboard</span>
      </header>
      <main>{page}</main>
    </div>
  );
}
