// How much of the time miners could be given work. Stratum records when it stops issuing work
// (node_syncing, node_unreachable: no node is usable) and when it resumes (node_ready); a switch
// between nodes is not a pause. A restart of Stratum itself (stratum_started) ends any pause that
// was open, since the new process starts from scratch, and counts as a restart; the few seconds
// a restart takes are not counted as downtime.

const RANGES = /** @type {Record<string, number>} */ ({ "24h": 24, "7d": 7 * 24, "30d": 30 * 24 });
const START_TYPES = ["node_syncing", "node_unreachable"];
const END_TYPES = ["node_ready", "stratum_started"];

/** @typedef {{ type: string, at: Date }} UptimeEvent */

/**
 * @param {UptimeEvent[]} events In time order, inside the window.
 * @param {{ paused: boolean, reason: string | null }} initial State when the window starts.
 * @param {Date} start @param {Date} end
 */
export function computePauses(events, initial, start, end) {
  /** @type {{ from: Date, to: Date | null, reason: string }[]} */
  const pauses = [];
  /** @type {{ from: Date, reason: string } | null} */
  let open = initial.paused ? { from: start, reason: initial.reason ?? "node_unreachable" } : null;
  let restarts = 0;
  for (const event of events) {
    if (event.type === "stratum_started") restarts += 1;
    if (START_TYPES.includes(event.type) && !open) {
      open = { from: event.at, reason: event.type };
    } else if (END_TYPES.includes(event.type) && open) {
      pauses.push({ from: open.from, to: event.at, reason: open.reason });
      open = null;
    }
  }
  if (open) pauses.push({ from: open.from, to: null, reason: open.reason });
  const pausedMs = pauses.reduce((sum, p) => sum + ((p.to ?? end).getTime() - p.from.getTime()), 0);
  return { pauses, pausedMs, restarts };
}

/**
 * Availability over a recent window, from the recorded events. The window starts when xelDash first
 * recorded anything, if that is later, so time before it ran is not counted as working.
 * @param {import("pg").Pool} pool @param {{ range?: string }} [options]
 */
export async function getUptime(pool, { range = "7d" } = {}) {
  const hours = RANGES[range] ?? RANGES["7d"];
  const end = new Date();
  const first = (await pool.query("SELECT min(created_at) AS at FROM service_events")).rows[0]?.at ?? end;
  const start = new Date(Math.max(end.getTime() - hours * 3_600_000, first.getTime()));
  const types = [...START_TYPES, ...END_TYPES];
  const [before, within] = await Promise.all([
    pool.query(
      "SELECT type FROM service_events WHERE type = ANY($1) AND created_at < $2 ORDER BY created_at DESC, id DESC LIMIT 1",
      [types, start],
    ),
    pool.query(
      "SELECT type, created_at FROM service_events WHERE type = ANY($1) AND created_at >= $2 ORDER BY created_at, id",
      [types, start],
    ),
  ]);
  const lastBefore = before.rows[0]?.type;
  const { pauses, pausedMs, restarts } = computePauses(
    within.rows.map((row) => ({ type: row.type, at: row.created_at })),
    { paused: START_TYPES.includes(lastBefore), reason: START_TYPES.includes(lastBefore) ? lastBefore : null },
    start,
    end,
  );
  const totalMs = Math.max(1, end.getTime() - start.getTime());
  return {
    range: RANGES[range] ? range : "7d",
    since: start.toISOString(),
    seconds: Math.round(totalMs / 1000),
    pausedSeconds: Math.round(pausedMs / 1000),
    uptimePercent: Number((100 * (1 - pausedMs / totalMs)).toFixed(3)),
    restarts,
    paused: pauses.length > 0 && pauses[pauses.length - 1].to === null,
    pauses: pauses.slice(-10).reverse().map((p) => ({
      from: p.from.toISOString(),
      to: p.to?.toISOString() ?? null,
      seconds: Math.round(((p.to ?? end).getTime() - p.from.getTime()) / 1000),
      reason: p.reason === "node_syncing" ? "syncing" : "unreachable",
    })),
  };
}
