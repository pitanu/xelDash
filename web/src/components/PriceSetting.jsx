import { CURRENCY_NAMES, formatMoney, setPriceCurrency, usePrice } from "../price.js";
import { SettingBlock } from "./ui.jsx";

/** Per-browser choice of showing the XEL price, and in which currency. @param {{ row?: boolean }} props */
export default function PriceSetting({ row = false }) {
  const { currency, enabled, reason, network, price } = usePrice();
  return (
    <SettingBlock row={row} title="Show prices in"
      subtitle="The current XEL price at the top of every page, and what found blocks are worth. Saved in this browser only."
      aside={
        <select value={currency} onChange={(e) => setPriceCurrency(e.target.value)} aria-label="Price currency" className="field w-64 max-w-full">
          <option value="">Off</option>
          {Object.entries(CURRENCY_NAMES).map(([code, name]) => (
            <option key={code} value={code}>{code.toUpperCase()} · {name}</option>
          ))}
        </select>
      }>
        <div className="space-y-1 text-[13px] text-ink-2">
          <p>
            Prices come from CoinGecko. xelDash fetches them on its server every 5 minutes while the price is on, so your
            browser never contacts CoinGecko. Off makes no requests at all.
          </p>
          {currency && !enabled && (
            <p className="text-danger">
              {reason === "network"
                ? `This dashboard runs on ${network}, whose coins have no market price. The price shows on mainnet only.`
                : "The price is turned off on this server (XELDASH_PRICE=off in .env)."}
            </p>
          )}
          {currency && enabled && price && (
            <p className="text-xs text-muted">
              Now: 1 XEL = {formatMoney(price.price, price.currency)}
              {price.change24h !== null && ` (${price.change24h >= 0 ? "+" : ""}${price.change24h.toFixed(1)}% in 24 h)`}
            </p>
          )}
        </div>
    </SettingBlock>
  );
}
