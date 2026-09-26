import { connect } from "node:net";

// A node counts as syncing when a peer reports a topoheight this far ahead of ours.
const SYNC_TOLERANCE = 3;

/** @param {unknown} error */
function message(error) {
  return error instanceof Error ? error.message : String(error);
}

/** Resolves true if a TCP connection opens within the timeout. @param {string} host @param {number} port */
function probeTcp(host, port, timeoutMs = 2_000) {
  return new Promise((resolve) => {
    const socket = connect(port, host);
    const done = (/** @type {boolean} */ ok) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

/**
 * Health of the node and the xelDash services. Each part is checked on its own, so one
 * failing dependency shows as down instead of failing the whole response.
 * @param {{ pool: import("pg").Pool, daemonCall: (method: string) => Promise<any>, stratumHost: string, stratumPort: number }} deps
 */
export async function getStatus({ pool, daemonCall, stratumHost, stratumPort }) {
  const [info, p2p, database, stratumUp, started, bans] = await Promise.allSettled([
    daemonCall("get_info"),
    daemonCall("p2p_status"),
    pool.query("SELECT 1"),
    probeTcp(stratumHost, stratumPort),
    pool.query("SELECT created_at FROM service_events WHERE type = 'stratum_started' ORDER BY id DESC LIMIT 1"),
    pool.query(
      `SELECT host(ip) AS ip, reason, until FROM bans
       WHERE until > now() ORDER BY until DESC LIMIT 50`,
    ),
  ]);

  /** @type {Record<string, unknown> | null} */
  let node = null;
  if (info.status === "fulfilled") {
    const i = info.value;
    const peers = p2p.status === "fulfilled" ? p2p.value : null;
    node = {
      version: i.version,
      network: i.network,
      height: i.height,
      topoheight: i.topoheight,
      stableheight: i.stableheight,
      blockVersion: i.block_version,
      difficulty: i.difficulty,
      mempoolSize: i.mempool_size,
      averageBlockTimeMs: i.average_block_time,
      blockTimeTargetMs: i.block_time_target,
      peers: peers ? peers.peer_count : null,
      maxPeers: peers ? peers.max_peers : null,
      bestTopoheight: peers ? peers.best_topoheight : null,
      syncing: peers ? peers.peer_count > 0 && peers.best_topoheight > i.topoheight + SYNC_TOLERANCE : null,
    };
  }

  return {
    node,
    services: {
      daemon: info.status === "fulfilled" ? { ok: true } : { ok: false, error: message(info.reason) },
      database: database.status === "fulfilled" ? { ok: true } : { ok: false, error: message(database.reason) },
      stratum: {
        ok: stratumUp.status === "fulfilled" && stratumUp.value,
        startedAt: started.status === "fulfilled" ? started.value.rows[0]?.created_at?.toISOString() ?? null : null,
      },
    },
    bans: bans.status === "fulfilled"
      ? bans.value.rows.map((b) => ({ ip: b.ip, reason: b.reason, until: b.until.toISOString() }))
      : [],
  };
}
