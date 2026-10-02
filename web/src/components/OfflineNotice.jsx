import { useEffect, useState } from "react";

/** @typedef {"ok" | "database" | "server"} Reach */

/**
 * Tells the person what an unreachable dashboard means for mining, in the two cases that differ:
 *  - the server answers but its database does not: mining carries on (Stratum keeps what it cannot
 *    record and records it when the database is back), so the data here is simply paused;
 *  - the server cannot be reached at all: this page cannot know about mining, so it only says it
 *    will reconnect, and that a backup server (if there is one) keeps mining.
 * Checked every few seconds; it disappears by itself when the data is back.
 */
export default function OfflineNotice() {
  const [reach, setReach] = useState(/** @type {Reach} */ ("ok"));
  const [since, setSince] = useState(/** @type {number | null} */ (null));

  useEffect(() => {
    let cancelled = false;
    let failures = 0;
    async function check() {
      /** @type {Reach} */
      let next = "ok";
      try {
        const response = await fetch("/api/v1/events?limit=1", { headers: { accept: "application/json" } });
        if (response.status === 503) next = "database";
        else if (!response.ok && response.status >= 502) next = "server";
      } catch {
        next = "server";
      }
      if (cancelled) return;
      // One missed check is not an outage (a restart of the web container, a slow reply).
      failures = next === "ok" ? 0 : failures + 1;
      const shown = failures >= 2 ? next : "ok";
      setReach(shown);
      setSince((previous) => (shown === "ok" ? null : previous ?? Date.now()));
    }
    void check();
    const timer = setInterval(check, 5_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  if (reach === "ok") return null;
  const database = reach === "database";
  return (
    <div role="alert" className="border-b border-warning/60 bg-warning/10">
      <div className="mx-auto max-w-6xl px-4 py-3 text-sm text-ink sm:px-6">
        <strong>{database ? "Dashboard offline: the database is not reachable." : "Dashboard offline: cannot reach the xelDash server."}</strong>{" "}
        {database ? (
          <span className="text-ink-2">
            Mining continues. Your rigs keep working, blocks are still submitted to your node, and everything is kept and recorded
            automatically when the database is back. The numbers on this page will catch up by themselves.
          </span>
        ) : (
          <span className="text-ink-2">
            This page will reconnect by itself. If the server is restarting, it is back in a minute or two. Your rigs are not
            affected if you run a backup server: it keeps mining.
          </span>
        )}
        {since !== null && <span className="ml-1 text-xs text-muted">(since {new Date(since).toLocaleTimeString()})</span>}
      </div>
    </div>
  );
}
