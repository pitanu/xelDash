import { useEffect, useState } from "react";
import { usePolled } from "./api.js";
import { BlocksTable, Card } from "./components/ui.jsx";
import Miner from "./pages/Miner.jsx";
import Overview from "./pages/Overview.jsx";
import Worker from "./pages/Worker.jsx";
import Health from "./pages/Health.jsx";

const NAV = [["/", "Overview"], ["/blocks", "Blocks"], ["/health", "Health"]];

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
  else if (route === "/health") page = <Health />;

  const section = route === "/blocks" || route === "/health" ? route : "/";
  return (
    <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6">
      <header className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <a href="#/" className="text-base font-semibold text-ink">xelDash</a>
        <nav className="flex gap-1 text-sm">
          {NAV.map(([href, label]) => (
            <a key={href} href={`#${href}`} aria-current={section === href ? "page" : undefined}
              className={`rounded-md px-2.5 py-1 ${section === href ? "bg-wash font-semibold text-ink" : "text-ink-2 hover:bg-wash hover:text-ink"}`}>
              {label}
            </a>
          ))}
        </nav>
      </header>
      <main>{page}</main>
    </div>
  );
}
