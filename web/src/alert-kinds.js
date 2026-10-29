// The kinds of alert, in words: chosen per server for Discord, Telegram and webhooks (AlertSettings.jsx) and per browser for its
// notifications (notifications.js). The names match ALERT_EVENTS (services/api/src/alerts.js).
export const ALERT_KIND_LABELS = /** @type {Record<string, string>} */ ({
  block_found: "A block is found",
  block_rejected: "The node rejects a block",
  block_side: "A block of yours is a side block (still paid once final)",
  block_final: "A block becomes final (paid or orphaned)",
  mining_paused: "Mining pauses or moves to another node",
  worker_offline: "A worker stops sending shares",
  worker_unusual: "A worker stops at a time of day it usually mines (quiet for rigs on a schedule)",
  worker_rejects: "A worker has many rejected shares (10% or more over 15 minutes)",
  node_update: "A node is updated",
  node_peers: "A node loses its connection to other nodes (mainnet, testnet)",
  disk_low: "The disk is running low on space",
  cluster: "A server takes over the shared address (redundancy)",
});
