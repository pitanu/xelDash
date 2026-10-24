import { useEffect, useState } from "react";
import { useLive, usePolled } from "./api.js";
import { Card, HealthBadge, miningState } from "./components/ui.jsx";
import Blocks from "./pages/Blocks.jsx";
import Miner from "./pages/Miner.jsx";
import Miners from "./pages/Miners.jsx";
import Overview from "./pages/Overview.jsx";
import Worker from "./pages/Worker.jsx";
import Health from "./pages/Health.jsx";
import NodeData from "./pages/NodeData.jsx";
import Settings from "./pages/Settings.jsx";
import BlockBanner from "./components/BlockBanner.jsx";
import { ClusterBanner } from "./components/ClusterCard.jsx";
import OfflineNotice from "./components/OfflineNotice.jsx";
import UpdateNotice, { VersionFooter } from "./components/UpdateNotice.jsx";
import { formatMoney, usePrice } from "./price.js";
import { consumeTokenFromUrl } from "./session-token.js";
import Setup from "./pages/Setup.jsx";
import Connect from "./pages/Connect.jsx";
import { useServerMode } from "./server-mode.js";

// Tab icons, drawn on a 20px grid (the phone's tab bar shows them above the names).
const TAB_ICONS = /** @type {Record<string, string>} */ ({
  "/": "M3 10l7-6 7 6v7H3z",
  "/miners": "M7 10a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM2 17c0-3 2.2-5 5-5s5 2 5 5M13.5 4.5a2.5 2.5 0 0 1 0 5M14.5 12c2 .4 3.5 2 3.5 5",
  "/blocks": "M10 2l7 4v8l-7 4-7-4V6zM3 6l7 4 7-4M10 10v8",
  "/health": "M2 10h4l2-5 4 10 2-5h4",
  "/nodes": "M3 3.5h14v5H3zM3 11.5h14v5H3zM6 6h.01M6 14h.01",
  "/connect": "M8 12l4-4M6.5 9.5l-2 2a3 3 0 0 0 4 4l2-2M13.5 10.5l2-2a3 3 0 0 0-4-4l-2 2",
  "/settings": "M10 12.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM10 2v2.5M10 15.5V18M2 10h2.5M15.5 10H18M4.3 4.3l1.8 1.8M13.9 13.9l1.8 1.8M4.3 15.7l1.8-1.8M13.9 6.1l1.8-1.8",
});
const NAV = [["/", "Overview"], ["/miners", "Miners"], ["/blocks", "Blocks"], ["/health", "Health"], ["/nodes", "Nodes"], ["/connect", "Connect"], ["/settings", "Settings"]];
// A public server's visitors: no node administration, a page on how to mine here, and Settings with this browser's appearance only.
const PUBLIC_NAV = [["/", "Overview"], ["/miners", "Miners"], ["/blocks", "Blocks"], ["/health", "Health"], ["/connect", "Mine here"], ["/settings", "Settings"]];
// Pages for the server's operator only (they need node administration, or set the server up).
const OPERATOR_PAGES = ["/setup", "/nodes", "/node-data"];

/** The xelDash mark: an X in the accent on the ink colour. */
function Logo() {
  return (
    <svg width="28" height="28" viewBox="0 0 28 28" aria-hidden="true" className="shrink-0">
      <rect width="28" height="28" rx="8" fill="var(--ink)" />
      <path d="M9 9l10 10M19 9L9 19" stroke="var(--accent)" strokeWidth="2.6" strokeLinecap="round" />
    </svg>
  );
}

/** The running version, next to the name (not on narrower windows, where the top bar needs the room; the footer has it too). */
function VersionChip() {
  const version = usePolled("/api/v1/version", { intervalMs: 30 * 60_000 });
  if (!version.data?.current) return null;
  return <span className="mono hide-md rounded-md border border-line px-1.5 text-[11px] text-muted">{version.data.current}</span>;
}

/** Whether miners are being given work right now: mining, paused (and why) or Stratum down. Refreshed every 30 s. */
function MiningPill() {
  const status = usePolled("/api/v1/status", { intervalMs: 30_000 });
  const state = miningState(status.data?.services?.stratum);
  // On a narrow phone the label can end in "…"; the title has all of it.
  return state ? <span className="flex min-w-0" title={state.label}><HealthBadge level={state.level} label={state.label} /></span> : null;
}

function LiveIndicator() {
  const live = useLive();
  const isLive = live.status === "live";
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-ink-2"
      title={isLive ? "Updates arrive as they happen" : "Live updates unavailable; refreshing every 15 seconds"}>
      <span className={`h-2 w-2 rounded-full ${isLive ? "bg-accent" : "bg-muted"}`} aria-hidden="true" />
      {/* On narrower windows the dot alone; the word stays for screen readers. */}
      <span className="max-[1279px]:sr-only">{isLive ? "Live" : live.status === "connecting" ? "Connecting…" : "Polling"}</span>
    </span>
  );
}

/** The XEL price in the currency chosen under Settings → Display; nothing while it is off. */
function PriceChip() {
  const { price } = usePrice();
  if (!price) return null;
  const change = price.change24h;
  return (
    <a href="#/settings" className="mono inline-flex items-center gap-1.5 whitespace-nowrap rounded-md px-1.5 py-0.5 text-xs text-ink-2 hover:bg-panel-2 hover:text-ink"
      title={`1 XEL in ${price.currency.toUpperCase()}${change !== null ? `, ${change >= 0 ? "up" : "down"} ${Math.abs(change).toFixed(1)}% in 24 h` : ""}, from ${price.source}${price.updatedAt ? `, updated ${new Date(price.updatedAt).toLocaleTimeString()}` : ""}`}>
      <span className="font-medium text-ink">XEL {formatMoney(price.price, price.currency)}</span>
      {change !== null && <span className="hide-lg">{change >= 0 ? "▲" : "▼"} {Math.abs(change).toFixed(1)}% 24h</span>}
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
const PAGES_WITH_OWN_HEADING = ["/miners", "/miner", "/blocks", "/nodes", "/node-data", "/settings", "/setup", "/connect"];
const PAGE_NAMES = /** @type {Record<string, string>} */ ({ "/": "Overview", "/health": "Health" });

/** Decoded path segment, or null for a malformed %-escape (which would otherwise throw). @param {string} segment */
function decode(segment) {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

/** An operator-only page opened on a public server's public view. */
function OperatorOnly() {
  return (
    <Card title="Not available here">
      <p className="text-sm text-ink-2">
        This is a public mining server: its administration is only open to its operator. To mine here, see{" "}
        <a href="#/connect" className="underline decoration-line underline-offset-2 hover:text-ink">Mine here</a>.
      </p>
    </Card>
  );
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
  const mode = useServerMode();
  const operator = mode.known && !mode.publicView;
  // Until the mode is known, the operator's links stay hidden (they flash up for nobody on a public server).
  // Settings and Connect differ between the two views, so they wait for the view too.
  const nav = mode.publicView ? PUBLIC_NAV : operator ? NAV : NAV.filter(([href]) => !OPERATOR_PAGES.includes(href) && href !== "/settings" && href !== "/connect");
  const workerMatch = /^\/miner\/([^/]+)\/worker\/(.+)$/.exec(route);
  const minerMatch = /^\/miner\/([^/]+)$/.exec(route);
  /** @type {import("react").ReactNode} */
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
  else if (route === "/settings") page = mode.known ? <Settings publicView={!operator} /> : null;
  else if (route === "/connect") page = <Connect />;
  // On a public server's public view the operator's pages are not offered (node-admin is not even reachable from it).
  if (OPERATOR_PAGES.includes(route) && !operator) page = mode.known ? <OperatorOnly /> : null;

  const section = ["/miners", "/blocks", "/health", "/nodes", "/settings", "/connect"].includes(route) ? route
    : route === "/node-data" ? "/nodes" : route.startsWith("/miner/") ? "/miners" : "/";
  return (
    <div>
      <header className="topbar">
        <div className="topbar-in">
          <a href="#/" className="flex shrink-0 items-center gap-2.5 text-ink">
            <Logo />
            <span className="text-[17px] font-bold tracking-tight">xelDash</span>
            <VersionChip />
          </a>
          <nav className="topnav" aria-label="Main">
            {nav.map(([href, label]) => (
              <a key={href} href={`#${href}`} aria-current={section === href ? "page" : undefined}>{label}</a>
            ))}
          </nav>
          <div className="ml-auto flex min-w-0 items-center gap-3">
            <span className="hide-sm"><PriceChip /></span>
            <LiveIndicator />
            <MiningPill />
          </div>
        </div>
      </header>
      <main className="wrap">
        <OfflineNotice />
        {operator && <ClusterBanner />}
        {operator && <UpdateNotice />}
        <BlockBanner />
        {!PAGES_WITH_OWN_HEADING.some((p) => route === p || route.startsWith(`${p}/`)) && <h1 className="sr-only">{PAGE_NAMES[route] ?? "Page not found"}</h1>}
        {page}
      </main>
      <VersionFooter />
      {/* Phones: the same pages as tabs along the bottom. */}
      <nav className="bottomnav" aria-label="Main" style={{ gridTemplateColumns: `repeat(${nav.length}, minmax(0, 1fr))` }}>
        {nav.map(([href, label]) => (
          <a key={href} href={`#${href}`} aria-current={section === href ? "page" : undefined}>
            <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
              <path d={TAB_ICONS[href]} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            {label}
          </a>
        ))}
      </nav>
    </div>
  );
}
