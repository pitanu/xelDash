// The latest XELIS daemon release, from GitHub, so the Health page can tell when a node is
// behind. Cached for six hours; XELDASH_VERSION_CHECK=off keeps the server from asking.

const RELEASES_URL = "https://api.github.com/repos/xelis-project/xelis-blockchain/releases/latest";
const CACHE_MS = 6 * 60 * 60_000;
const RETRY_MS = 10 * 60_000;
const enabled = (process.env.XELDASH_VERSION_CHECK ?? "on").toLowerCase() !== "off";

/** @type {{ version: string, url: string, publishedAt: string | null } | null} */
let cached = null;
let checkedAt = 0;
/** @type {Promise<void> | null} */
let inFlight = null;

/** "1.25.0-db59b5c2" or "v1.25.0" to [1, 25, 0]; null if it is not a version. @param {string | null | undefined} text */
export function parseVersion(text) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(text ?? "");
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

/** @param {number[]} a @param {number[]} b */
export function compareVersions(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

async function refresh() {
  const response = await fetch(RELEASES_URL, {
    headers: { accept: "application/vnd.github+json", "user-agent": "xelDash" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`GitHub returned HTTP ${response.status}`);
  const body = /** @type {{ tag_name?: string, html_url?: string, published_at?: string }} */ (await response.json());
  if (!parseVersion(body.tag_name)) throw new Error("GitHub returned no release version");
  cached = {
    version: String(body.tag_name).replace(/^v/, ""),
    url: typeof body.html_url === "string" ? body.html_url : "https://github.com/xelis-project/xelis-blockchain/releases",
    publishedAt: body.published_at ?? null,
  };
}

/** The latest release, or null while unknown or switched off. */
export async function latestRelease() {
  if (!enabled) return null;
  const age = Date.now() - checkedAt;
  if ((!cached && age > RETRY_MS) || age > CACHE_MS) {
    checkedAt = Date.now();
    inFlight ??= refresh()
      .catch((error) => console.warn("XELIS release check failed:", error instanceof Error ? error.message : String(error)))
      .finally(() => {
        inFlight = null;
      });
    await inFlight;
  }
  return cached;
}
