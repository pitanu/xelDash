import { useEffect, useState } from "react";
import { useLive, usePolled } from "./api.js";
import { BlocksTable, Card } from "./components/ui.jsx";
import Miner from "./pages/Miner.jsx";
import Overview from "./pages/Overview.jsx";
import Worker from "./pages/Worker.jsx";
import Health from "./pages/Health.jsx";
import NodeData from "./pages/NodeData.jsx";
import Settings from "./pages/Settings.jsx";
import { ThemeButton } from "./components/ThemeSetting.jsx";
import { formatMoney, usePrice } from "./price.js";

const NAV = [["/", "Overview"], ["/blocks", "Blocks"], ["/health", "Health"], ["/nodes", "Nodes"], ["/settings", "Settings"]];

/** The xelDash mark: a pickaxe-like X on the accent color. */
function Logo() {
  return (
    <svg width="22" height="22" viewBox="0 0 22 22" aria-hidden="true" className="shrink-0">
      <rect width="22" height="22" rx="6" fill="var(--series-1)" />
      <path d="M6.5 6.5l9 9M15.5 6.5l-9 9" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" />
      <circle cx="11" cy="11" r="1.6" fill="var(--series-1)" stroke="#fff" strokeWidth="1.4" />
    </svg>
  );
}

function LiveIndicator() {
  const live = useLive();
  const isLive = live.status === "live";
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-ink-2"
      title={isLive ? "Updates arrive as they happen" : "Live updates unavailable; refreshing every 15 seconds"}>
      <span className={`h-2 w-2 rounded-full ${isLive ? "bg-good" : "bg-muted"}`} aria-hidden="true" />
      {isLive ? "Live" : live.status === "connecting" ? "Connecting…" : "Polling"}
    </span>
  );
}

/** The XEL price in the currency chosen under Settings → Display; nothing while it is off. */
function PriceChip() {
  const { price } = usePrice();
  if (!price) return null;
  const change = price.change24h;
  return (
    <a href="#/settings" className="tabular inline-flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-xs text-ink-2 hover:bg-wash hover:text-ink"
      title={`1 XEL in ${price.currency.toUpperCase()}, from ${price.source}${price.updatedAt ? `, updated ${new Date(price.updatedAt).toLocaleTimeString()}` : ""}`}>
      <span className="font-medium text-ink">XEL {formatMoney(price.price, price.currency)}</span>
      {change !== null && <span>{change >= 0 ? "▲" : "▼"} {Math.abs(change).toFixed(1)}% 24h</span>}
    </a>
  );
}

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
  // #/node-data is the page's old address, kept for bookmarks.
  else if (route === "/nodes" || route === "/node-data") page = <NodeData />;
  else if (route === "/settings") page = <Settings />;

  const section = ["/blocks", "/health", "/nodes", "/settings"].includes(route) ? route : route === "/node-data" ? "/nodes" : "/";
  return (
    <div>
      <header className="sticky top-0 z-20 border-b border-line bg-page/85 backdrop-blur supports-[backdrop-filter]:bg-page/70">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-x-3 gap-y-2 px-4 py-3 sm:px-6">
          <div className="flex flex-wrap items-center gap-3">
            <a href="#/" className="flex items-center gap-2 text-base font-semibold tracking-tight text-ink">
              <Logo />
              xelDash
            </a>
            <LiveIndicator />
            <PriceChip />
          </div>
          <div className="flex items-center gap-1">
            <nav className="flex gap-1 text-sm">
              {NAV.map(([href, label]) => (
                <a key={href} href={`#${href}`} aria-current={section === href ? "page" : undefined}
                  className={`rounded-md px-2.5 py-1 ${section === href ? "bg-wash font-semibold text-ink" : "text-ink-2 hover:bg-wash hover:text-ink"}`}>
                  {label}
                </a>
              ))}
            </nav>
            <ThemeButton />
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-6 sm:px-6">{page}</main>
    </div>
  );
}
