import { useEffect, useState } from "react";
import { useLive, usePolled } from "./api.js";
import { BlocksTable, Card } from "./components/ui.jsx";
import RewardsChart from "./components/RewardsChart.jsx";
import RewardsSummary from "./components/RewardsSummary.jsx";
import Miner from "./pages/Miner.jsx";
import Miners from "./pages/Miners.jsx";
import Overview from "./pages/Overview.jsx";
import Worker from "./pages/Worker.jsx";
import Health from "./pages/Health.jsx";
import NodeData from "./pages/NodeData.jsx";
import Settings from "./pages/Settings.jsx";
import BlockBanner from "./components/BlockBanner.jsx";
import OfflineNotice from "./components/OfflineNotice.jsx";
import UpdateNotice, { VersionFooter } from "./components/UpdateNotice.jsx";
import { ThemeButton } from "./components/ThemeSetting.jsx";
import { formatMoney, usePrice } from "./price.js";
import { consumeTokenFromUrl } from "./session-token.js";
import Setup from "./pages/Setup.jsx";

const NAV = [["/", "Overview"], ["/miners", "Miners"], ["/blocks", "Blocks"], ["/health", "Health"], ["/nodes", "Nodes"], ["/settings", "Settings"]];

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
      consumeTokenFromUrl();
      setHash(window.location.hash);
      window.scrollTo(0, 0);
    };
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  // A "?..." after the path (the setup link's token) is not part of the route.
  return hash.replace(/^#/, "").split("?")[0] || "/";
}

// Pages that show their own top-level heading; the others get one for screen readers.
const PAGES_WITH_OWN_HEADING = ["/miners", "/miner", "/nodes", "/node-data", "/settings", "/setup"];
const PAGE_NAMES = /** @type {Record<string, string>} */ ({ "/": "Overview", "/blocks": "Blocks", "/health": "Health" });

function Blocks() {
  const blocks = usePolled("/api/v1/blocks?limit=200");
  const overview = usePolled("/api/v1/overview");
  return (
    <div className="space-y-4">
      <a href="#/" className="inline-flex min-h-6 items-center text-xs text-ink-2 hover:text-ink hover:underline">← Overview</a>
      <RewardsSummary totals={blocks.data?.totals} />
      <Card title="Rewards over time" subtitle="Running total found, against what the work done should have found">
        <RewardsChart rewardPerBlock={Number(overview.data?.node?.miner_reward) || null} />
      </Card>
      <Card title="Blocks" subtitle="Most recent 200"
        action={<a href="/api/v1/blocks.csv" download className="inline-flex min-h-6 items-center text-xs text-ink-2 underline decoration-line underline-offset-2 hover:text-ink">Download all as CSV</a>}>{blocks.data && <BlocksTable blocks={blocks.data.blocks} />}</Card>
    </div>
  );
}

/** Decoded path segment, or null for a malformed %-escape (which would otherwise throw). @param {string} segment */
function decode(segment) {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

/** Shown for an address that is not a page, such as a mistyped or very old link. */
function NotFound() {
  return (
    <Card title="Page not found">
      <p className="text-sm text-ink-2">
        There is no page at this address. Try the <a href="#/" className="underline decoration-line underline-offset-2 hover:text-ink">Overview</a>{" "}
        or one of the pages in the menu.
      </p>
    </Card>
  );
}

export default function App() {
  const route = useHashRoute();
  const workerMatch = /^\/miner\/([^/]+)\/worker\/(.+)$/.exec(route);
  const minerMatch = /^\/miner\/([^/]+)$/.exec(route);
  let page = <NotFound />;
  if (route === "/") page = <Overview />;
  else if (workerMatch) {
    const address = decode(workerMatch[1]);
    const name = decode(workerMatch[2]);
    if (address !== null && name !== null) page = <Worker key={route} address={address} name={name} />;
  } else if (minerMatch) {
    const address = decode(minerMatch[1]);
    if (address !== null) page = <Miner key={minerMatch[1]} address={address} />;
  } else if (route === "/setup") page = <Setup />;
  else if (route === "/miners") page = <Miners />;
  else if (route === "/blocks") page = <Blocks />;
  else if (route === "/health") page = <Health />;
  // #/node-data is the page's old address, kept for bookmarks.
  else if (route === "/nodes" || route === "/node-data") page = <NodeData />;
  else if (route === "/settings") page = <Settings />;

  const section = ["/miners", "/blocks", "/health", "/nodes", "/settings"].includes(route) ? route
    : route === "/node-data" ? "/nodes" : route.startsWith("/miner/") ? "/miners" : "/";
  return (
    <div>
      <header className="sticky top-0 z-20 border-b border-line bg-page/85 backdrop-blur supports-[backdrop-filter]:bg-page/70">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-x-3 gap-y-2 px-4 py-3 sm:px-6">
          <div className="flex w-full flex-wrap items-center gap-3 sm:w-auto">
            <a href="#/" className="flex items-center gap-2 text-base font-semibold tracking-tight text-ink">
              <Logo />
              xelDash
            </a>
            <LiveIndicator />
            <PriceChip />
            {/* On phones the theme button sits up here, so the six links have the row to themselves. */}
            <span className="ml-auto sm:hidden"><ThemeButton /></span>
          </div>
          <div className="flex w-full min-w-0 items-center gap-1 sm:w-auto">
            {/* Scrolls sideways on very narrow screens instead of clipping a link. */}
            <nav className="flex min-w-0 gap-0.5 overflow-x-auto text-[13px] sm:gap-1 sm:text-sm">
              {NAV.map(([href, label]) => (
                <a key={href} href={`#${href}`} aria-current={section === href ? "page" : undefined}
                  className={`shrink-0 rounded-md px-1.5 py-1 sm:px-2.5 ${section === href ? "bg-wash font-semibold text-ink" : "text-ink-2 hover:bg-wash hover:text-ink"}`}>
                  {label}
                </a>
              ))}
            </nav>
            <span className="hidden sm:block"><ThemeButton /></span>
          </div>
        </div>
      </header>
      <OfflineNotice />
      <UpdateNotice />
      <BlockBanner />
      <main className="mx-auto max-w-6xl px-4 py-6 sm:px-6">
        {!PAGES_WITH_OWN_HEADING.some((p) => route === p || route.startsWith(`${p}/`)) && <h1 className="sr-only">{PAGE_NAMES[route] ?? "Page not found"}</h1>}
        {page}
      </main>
      <VersionFooter />
    </div>
  );
}
