// XEL price from CoinGecko's free API, fetched by the server so viewers' browsers never contact
// a third party. One request covers every currency, cached for 5 minutes, and only made
// while someone has the price switched on in their browser.

/** The largest currencies by trading volume, in the order the dashboard offers them. */
export const CURRENCIES = ["usd", "eur", "jpy", "gbp", "cny", "aud", "cad", "chf", "krw", "inr", "btc"];
const SOURCE_URL = `https://api.coingecko.com/api/v3/simple/price?ids=xelis&vs_currencies=${CURRENCIES.join(",")}&include_24hr_change=true&include_last_updated_at=true`;
const CACHE_MS = 5 * 60_000;
// After a failure, wait before asking again, so a CoinGecko outage costs one request a minute.
const RETRY_MS = 60_000;

/** @type {{ at: number, prices: Record<string, { price: number, change24h: number | null }>, updatedAt: string | null } | null} */
let cached = null;
let failedAt = 0;
/** @type {Promise<void> | null} */
let inFlight = null;

async function refresh() {
  const response = await fetch(SOURCE_URL, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`CoinGecko returned HTTP ${response.status}`);
  const body = /** @type {{ xelis?: Record<string, number> }} */ (await response.json());
  const x = body.xelis;
  if (!x) throw new Error("CoinGecko has no XEL price");
  /** @type {Record<string, { price: number, change24h: number | null }>} */
  const prices = {};
  for (const currency of CURRENCIES) {
    const price = x[currency];
    const change = x[`${currency}_24h_change`];
    if (typeof price === "number" && Number.isFinite(price) && price >= 0) {
      prices[currency] = { price, change24h: typeof change === "number" && Number.isFinite(change) ? change : null };
    }
  }
  if (Object.keys(prices).length === 0) throw new Error("CoinGecko returned no usable prices");
  cached = { at: Date.now(), prices, updatedAt: typeof x.last_updated_at === "number" ? new Date(x.last_updated_at * 1000).toISOString() : null };
}

/**
 * The XEL price in one currency. Serves a stale price (marked by its updatedAt) rather than
 * nothing while CoinGecko cannot be reached.
 * @param {string} currency
 */
export async function getPrice(currency) {
  const now = Date.now();
  if ((!cached || now - cached.at > CACHE_MS) && now - failedAt > RETRY_MS) {
    inFlight ??= refresh()
      .catch((error) => {
        failedAt = Date.now();
        console.warn("XEL price unavailable:", error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        inFlight = null;
      });
    await inFlight;
  }
  const entry = cached?.prices[currency];
  if (!entry) return null;
  return { currency, ...entry, updatedAt: cached?.updatedAt ?? null, source: "CoinGecko" };
}
