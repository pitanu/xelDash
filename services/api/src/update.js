import { readFileSync } from "node:fs";
import { compareVersions, parseVersion } from "./release.js";

// Is a newer xelDash available? Asks GitHub for the project's published releases (the release workflow creates
// one per version, after its images are published), at most every six hours. XELDASH_VERSION_CHECK=off keeps the
// server from asking. Pre-releases (0.2.0-rc.1) are ignored while looking for the newest version.

const REPO = process.env.XELDASH_UPDATE_REPO || "pitanu/xelDash";
const CACHE_MS = 6 * 60 * 60_000;
const RETRY_MS = 10 * 60_000;
const enabled = (process.env.XELDASH_VERSION_CHECK ?? "on").toLowerCase() !== "off";

/** The running version: the image's version when released images are used, else this package's. */
export function currentVersion() {
  const fromEnv = (process.env.XELDASH_VERSION ?? "").trim().replace(/^v/, "");
  if (parseVersion(fromEnv)) return fromEnv;
  try {
    return String(JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version);
  } catch {
    return "unknown";
  }
}

/** @type {{ version: string, url: string } | null} */
let cached = null;
let checkedAt = 0;
/** @type {Promise<void> | null} */
let inFlight = null;

/**
 * Whether `latest` is newer than `current`. A pre-release (0.1.0-rc.1) is older than the release it
 * leads up to (0.1.0).
 * @param {string} current @param {string} latest
 */
export function isNewer(current, latest) {
  const a = parseVersion(current);
  const b = parseVersion(latest);
  if (!a || !b) return false;
  const order = compareVersions(a, b);
  if (order !== 0) return order < 0;
  return /^v?\d+\.\d+\.\d+-/.test(current);
}

/** @param {unknown} releases GitHub's list of published releases */
export function newestStable(releases) {
  /** @type {{ version: string, parsed: number[] } | null} */
  let best = null;
  for (const release of Array.isArray(releases) ? releases : []) {
    if (release?.draft || release?.prerelease) continue;
    const name = typeof release?.tag_name === "string" ? release.tag_name : "";
    if (!/^v\d+\.\d+\.\d+$/.test(name)) continue;
    const parsed = parseVersion(name);
    if (parsed && (!best || compareVersions(best.parsed, parsed) < 0)) best = { version: name.replace(/^v/, ""), parsed };
  }
  return best?.version ?? null;
}

async function refresh() {
  const response = await fetch(`https://api.github.com/repos/${REPO}/releases?per_page=100`, {
    headers: { accept: "application/vnd.github+json", "user-agent": "xelDash" },
    signal: AbortSignal.timeout(10_000),
  });
  // A repository that is still private (or has no releases) is simply "nothing newer".
  if (response.status === 404) {
    cached = null;
    return;
  }
  if (!response.ok) throw new Error(`GitHub returned HTTP ${response.status}`);
  const version = newestStable(await response.json());
  cached = version ? { version, url: `https://github.com/${REPO}/releases/tag/v${version}` } : null;
}

/** The running version and the newest one known, for the dashboard. */
export async function updateStatus() {
  const current = currentVersion();
  if (enabled) {
    const age = Date.now() - checkedAt;
    if ((!cached && age > RETRY_MS) || age > CACHE_MS) {
      checkedAt = Date.now();
      inFlight ??= refresh()
        .catch((error) => console.warn("xelDash update check failed:", error instanceof Error ? error.message : String(error)))
        .finally(() => {
          inFlight = null;
        });
      await inFlight;
    }
  }
  return {
    current,
    latest: cached?.version ?? null,
    url: cached?.url ?? null,
    available: Boolean(cached && isNewer(current, cached.version)),
    checking: enabled,
  };
}
