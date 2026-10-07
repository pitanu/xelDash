import { readFile, stat } from "node:fs/promises";
import { coinSymbol } from "./coin.js";
const SEND_INTERVAL_MS = 1_000;
const MAX_QUEUE = 20;
const FINAL_BATCH_MS = 5_000;
const XEL_DECIMALS = 8;
const EVENT_TYPES = ["block_found", "block_rejected", "block_final", "block_side", "mining_paused", "worker_offline", "node_update", "disk_low", "cluster"];
const EXPLORERS = /** @type {Record<string, string>} */ ({
  mainnet: "https://explorer.xelis.io",
  testnet: "https://testnet-explorer.xelis.io",
});
const TRIGGERS = /** @type {Record<string, string>} */ ({ automatic: " (automatic update)", scheduled: " (at the scheduled height)" });

/** @param {unknown} error */
function message(error) {
  return error instanceof Error ? error.message : String(error);
}

/** @param {string | number | null | undefined} atomic @param {string} coin XEL on mainnet, XET on a test network */
function formatXel(atomic, coin) {
  if (atomic === null || atomic === undefined) return "unknown";
  const padded = String(atomic).padStart(XEL_DECIMALS + 1, "0");
  const fraction = padded.slice(-XEL_DECIMALS).replace(/0+$/, "");
  return `${padded.slice(0, -XEL_DECIMALS)}${fraction ? `.${fraction}` : ""} ${coin}`;
}

/** @param {string} address */
function shortAddress(address) {
  return address.length > 24 ? `${address.slice(0, 12)}…${address.slice(-8)}` : address;
}

/**
 * @typedef {{ discordWebhookUrl: string | null, telegramBotToken: string | null, telegramChatId: string | null,
 *   webhookUrl: string | null, events: Set<string>, workerOfflineMinutes: number, dashboardUrl: string | null,
 *   explorerUrl: string | null, coin: string }} AlertConfig
 */

/** @param {Partial<Record<string, string | undefined>>} env @returns {AlertConfig} */
export function alertConfigFromEnv(env) {
  const value = (/** @type {string} */ name) => (env[name] ?? "").trim() || null;
  const events = new Set((value("ALERT_EVENTS") ?? EVENT_TYPES.join(",")).split(",").map((e) => e.trim()).filter(Boolean));
  for (const event of events) {
    if (!EVENT_TYPES.includes(event)) throw new Error(`ALERT_EVENTS: unknown event "${event}"; use ${EVENT_TYPES.join(", ")}`);
  }
  const minutes = Number(value("ALERT_WORKER_OFFLINE_MINUTES") ?? "10");
  if (!Number.isSafeInteger(minutes) || minutes < 1) throw new Error("ALERT_WORKER_OFFLINE_MINUTES must be a positive integer");
  const config = {
    discordWebhookUrl: value("ALERT_DISCORD_WEBHOOK_URL"),
    telegramBotToken: value("ALERT_TELEGRAM_BOT_TOKEN"),
    telegramChatId: value("ALERT_TELEGRAM_CHAT_ID"),
    webhookUrl: value("ALERT_WEBHOOK_URL"),
    events,
    workerOfflineMinutes: minutes,
    dashboardUrl: value("ALERT_DASHBOARD_URL"),
    // The official block explorer for this network (devnet has none), for links to found blocks.
    explorerUrl: EXPLORERS[value("XELIS_NETWORK") ?? ""] ?? null,
    coin: coinSymbol(value("XELIS_NETWORK")),
  };
  if (Boolean(config.telegramBotToken) !== Boolean(config.telegramChatId)) {
    throw new Error("Set both ALERT_TELEGRAM_BOT_TOKEN and ALERT_TELEGRAM_CHAT_ID for Telegram alerts");
  }
  return config;
}

/**
 * The alert settings saved from the dashboard (alerts.json on the config volume) when there are
 * any, else the ALERT_* values from .env.
 * @param {Partial<Record<string, string | undefined>>} env @param {string} file
 * @returns {Promise<AlertConfig>}
 */
export async function loadAlertConfig(env, file) {
  let saved;
  try {
    saved = JSON.parse(await readFile(file, "utf8"));
  } catch {
    return alertConfigFromEnv(env);
  }
  const text = (/** @type {unknown} */ v) => (typeof v === "string" ? v : "");
  const config = alertConfigFromEnv({
    ALERT_DISCORD_WEBHOOK_URL: text(saved.discordWebhookUrl),
    ALERT_TELEGRAM_BOT_TOKEN: text(saved.telegramBotToken),
    ALERT_TELEGRAM_CHAT_ID: text(saved.telegramChatId),
    ALERT_WEBHOOK_URL: text(saved.webhookUrl),
    ALERT_WORKER_OFFLINE_MINUTES: String(saved.workerOfflineMinutes ?? 10),
    ALERT_DASHBOARD_URL: text(saved.dashboardUrl),
    XELIS_NETWORK: env.XELIS_NETWORK,
  });
  // An empty list means "nothing" here, not "everything" as it does in .env.
  if (Array.isArray(saved.events)) config.events = new Set(saved.events.filter((/** @type {string} */ e) => EVENT_TYPES.includes(e)));
  return config;
}

/**
 * Runs alerts and restarts them when the settings file changes, so a change made on the
 * dashboard applies within seconds without restarting the API.
 * @param {{ pool: import("pg").Pool, env: Partial<Record<string, string | undefined>>, file: string,
 *   logger?: Pick<Console, "info" | "warn">, intervalMs?: number }} options
 */
export function watchAlerts({ pool, env, file, logger = console, intervalMs = 10_000 }) {
  /** @type {ReturnType<typeof startAlerts>} */
  let current = null;
  let signature = "";
  async function reload() {
    let next;
    try {
      next = (await stat(file)).mtimeMs.toString();
    } catch {
      next = "none";
    }
    if (next === signature) return;
    signature = next;
    try {
      const config = await loadAlertConfig(env, file);
      current?.stop();
      current = startAlerts({ pool, config, logger });
    } catch (error) {
      logger.warn?.(`Alert settings not applied: ${message(error)}`);
    }
  }
  const timer = setInterval(() => void reload(), intervalMs);
  timer.unref();
  const ready = reload();
  return {
    ready,
    /** @param {string} payload */
    handleNotification: (payload) => current?.handleNotification(payload),
    stop() {
      clearInterval(timer);
      current?.stop();
    },
  };
}

/**
 * Sends one channel's messages in order, at most one per second. When alerts arrive faster
 * than that (a burst of blocks on devnet), extras are dropped and counted, and the next
 * message says how many were skipped.
 */
class ChannelQueue {
  /** @param {string} name @param {(text: string, alert: Alert) => Promise<void>} deliver @param {Pick<Console, "warn">} logger */
  constructor(name, deliver, logger) {
    this.name = name;
    this.deliver = deliver;
    this.logger = logger;
    /** @type {Alert[]} */
    this.queue = [];
    this.dropped = 0;
    this.running = false;
  }

  /** @param {Alert} alert */
  push(alert) {
    if (this.queue.length >= MAX_QUEUE) {
      this.dropped += 1;
      return;
    }
    this.queue.push(alert);
    if (!this.running) void this.drain();
  }

  async drain() {
    this.running = true;
    while (this.queue.length > 0) {
      const alert = /** @type {Alert} */ (this.queue.shift());
      let text = alert.text;
      if (this.dropped > 0) {
        text += `\n(${this.dropped} more alert${this.dropped === 1 ? "" : "s"} skipped; see the dashboard)`;
        this.dropped = 0;
      }
      try {
        await this.deliver(text, alert);
      } catch (error) {
        this.logger.warn?.(`Alert to ${this.name} failed: ${message(error)}`);
      }
      await new Promise((resolve) => setTimeout(resolve, SEND_INTERVAL_MS));
    }
    this.running = false;
  }
}

/** @typedef {{ event: string, text: string, data: Record<string, unknown> }} Alert */

/** @param {string} url @param {unknown} body */
async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
}

/**
 * Block, mining-state and worker-offline alerts to Discord, Telegram and/or a JSON webhook.
 * Block and state alerts follow service_events via the live channel; worker offline is a
 * once-a-minute check of per-minute stats. Returns null when no channel is configured.
 * @param {{ pool: import("pg").Pool, config: AlertConfig, logger?: Pick<Console, "info" | "warn"> }} options
 */
export function startAlerts({ pool, config, logger = console }) {
  /** @type {ChannelQueue[]} */
  const channels = [];
  if (config.discordWebhookUrl) {
    const url = config.discordWebhookUrl;
    channels.push(new ChannelQueue("Discord", (text) => postJson(url, {
      content: text.slice(0, 2000),
      // Worker names come from miners; never let one ping @everyone or a role.
      allowed_mentions: { parse: [] },
    }), logger));
  }
  if (config.telegramBotToken && config.telegramChatId) {
    const url = `https://api.telegram.org/bot${config.telegramBotToken}/sendMessage`;
    const chatId = config.telegramChatId;
    channels.push(new ChannelQueue("Telegram", (text) => postJson(url, { chat_id: chatId, text, disable_web_page_preview: true }), logger));
  }
  if (config.webhookUrl) {
    const url = config.webhookUrl;
    channels.push(new ChannelQueue("webhook", (text, alert) => postJson(url, {
      event: alert.event, text, ...alert.data, sentAt: new Date().toISOString(),
    }), logger));
  }
  if (channels.length === 0) return null;
  logger.info?.(`Alerts enabled: ${channels.map((c) => c.name).join(", ")} (${[...config.events].join(", ")})`);

  const explorer = (/** @type {string | undefined} */ hash) => (config.explorerUrl && hash ? `\n${config.explorerUrl}/block/${hash}` : "");
  const link = (/** @type {string} */ path) => (config.dashboardUrl ? `\n${config.dashboardUrl.replace(/\/$/, "")}/#${path}` : "");
  /** @param {Alert} alert */
  const send = (alert) => {
    for (const channel of channels) channel.push(alert);
  };

  // Blocks become final whenever the stable height moves, which can be many at once (after a
  // node restart, or several blocks close together). Finals arriving within FINAL_BATCH_MS are
  // sent as one message.
  /** @type {Record<string, any>[]} */
  let finals = [];
  /** @type {ReturnType<typeof setTimeout> | null} */
  let finalTimer = null;
  /** @param {Record<string, any>} block */
  function queueFinal(block) {
    finals.push(block);
    finalTimer ??= setTimeout(flushFinals, FINAL_BATCH_MS);
  }
  function flushFinals() {
    const batch = finals;
    finals = [];
    finalTimer = null;
    if (batch.length === 1) {
      const p = batch[0];
      const text = p.status === "main-chain"
        ? `✅ Block ${p.height} is final on the main chain. Reward: ${formatXel(p.reward, config.coin)}.`
        : p.status === "side"
          ? `🟡 Block ${p.height} is final as a side block. Reward: ${formatXel(p.reward, config.coin)}.`
          : `❌ Block ${p.height} was orphaned; it earns no reward.`;
      send({ event: "block_final", data: p, text: `${text}${link("/blocks")}` });
      return;
    }
    const heights = batch.map((b) => Number(b.height)).sort((a, b) => a - b);
    const count = (/** @type {string} */ status) => batch.filter((b) => b.status === status).length;
    const reward = batch.reduce((sum, b) => sum + BigInt(b.reward ?? 0), 0n);
    const parts = [
      count("main-chain") && `${count("main-chain")} on the main chain`,
      count("side") && `${count("side")} side`,
      count("orphaned") && `${count("orphaned")} orphaned`,
    ].filter(Boolean);
    send({
      event: "block_final",
      data: { blocks: batch },
      text: `✅ ${batch.length} blocks are final (heights ${heights[0]}–${heights.at(-1)}): ${parts.join(", ")}. `
        + `Total reward: ${formatXel(reward.toString(), config.coin)}.${link("/blocks")}`,
    });
  }

  /** @param {string} id @param {string} type */
  async function onEvent(id, type) {
    const row = (await pool.query("SELECT payload FROM service_events WHERE id = $1", [id])).rows[0];
    if (!row) return;
    const p = row.payload ?? {};
    if (type === "block_submitted" && config.events.has("block_found")) {
      const block = (await pool.query(
        `SELECT m.address FROM blocks b LEFT JOIN miners m ON m.id = b.miner_id WHERE b.hash = $1`, [p.hash],
      )).rows[0];
      const who = [p.workerName, block?.address ? shortAddress(block.address) : null].filter(Boolean).join(" · ");
      send({ event: "block_found", data: { ...p, address: block?.address ?? null },
        text: `⛏️ Block found at height ${p.height}${who ? ` by ${who}` : ""}. Waiting for it to become final.${explorer(p.hash)}${link("/blocks")}` });
    } else if (type === "block_rejected" && config.events.has("block_rejected")) {
      send({ event: "block_rejected", data: p,
        text: `⚠️ The node rejected a block candidate at height ${p.height}${p.workerName ? ` from ${p.workerName}` : ""}: ${p.error}` });
    } else if (type === "block_side" && config.events.has("block_side")) {
      send({ event: "block_side", data: p,
        text: `🟡 Your block at height ${p.height} is a side block for now: another block was found at the same height. Side blocks are still paid once they are final, in the amount the node credits.${link("/blocks")}` });
    } else if (type === "block_final" && config.events.has("block_final")) {
      queueFinal(p);
    } else if ((type === "node_syncing" || type === "node_unreachable") && config.events.has("mining_paused")) {
      send({ event: "mining_paused", data: { ...p, reason: type.replace("node_", "") },
        text: type === "node_syncing"
          ? `⏸️ Mining paused: the node is syncing (topoheight ${p.topoheight} of ${p.networkTopoheight}). Miners were disconnected and will reconnect when it catches up.`
          : "⏸️ Mining paused: the node is not responding. Miners were disconnected and will reconnect when it is back." });
    } else if (type === "node_switched" && config.events.has("mining_paused")) {
      // The node mining left is still ready when a higher-priority node recovered (failback).
      const state = p.nodes?.[p.from];
      send({ event: "node_switched", data: p,
        text: state === "ready"
          ? `🔀 Mining moved back to node ${p.to}, the preferred node. Miners got fresh work.`
          : `🔀 Mining switched from node ${p.from} to ${p.to}: ${p.from} ${state === "syncing" ? "is syncing" : "is not responding"}. Miners got fresh work and keep mining.` });
    } else if (type.startsWith("node_update_") && config.events.has("node_update")) {
      const version = p.target === "image" ? "the image's version" : p.target;
      const why = TRIGGERS[p.trigger] ?? "";
      send({ event: "node_update", data: { ...p, outcome: type.slice("node_update_".length) },
        text: type === "node_update_started"
          ? `⬆️ Switching ${p.nodes.join(", then ")} to ${version}${why}, one node at a time.`
          : type === "node_update_done"
            ? `✅ ${p.switched?.length ? p.switched.join(" and ") : "The nodes"} now run${p.switched?.length === 1 ? "s" : ""} ${version}${why}.`
            : `❌ Switching ${p.node} to ${version} failed${why}: ${p.error}. Later nodes were left as they were.${link("/nodes")}` });
    } else if (type.startsWith("cluster_") && config.events.has("cluster")) {
      const who = p.server ? ` (${p.server})` : "";
      const text = type === "cluster_active"
        ? `🔀 Failover: this server${who} now holds the shared address ${p.vip}. Your rigs are connected here and keep mining.`
        : type === "cluster_fault"
          ? `⚠️ This server${who} cannot mine, so it gave up the shared address ${p.vip} to the other server. Check its node.`
          : `💤 This server${who} is standing by again. The other server holds the shared address.`;
      send({ event: type, data: p, text: `${text}${link("/health")}` });
    } else if (type === "disk_low" && config.events.has("disk_low")) {
      const gb = (/** @type {number} */ bytes) => Math.round(bytes / 1e9);
      send({ event: "disk_low", data: p,
        text: p.level === "critical"
          ? `🚨 Disk almost full: ${gb(p.freeBytes)} GB free of ${gb(p.totalBytes)} GB. The node stops when it is full. Free some space now (the Nodes page lists old copies you can delete).${link("/nodes")}`
          : `💾 Disk space is low: ${gb(p.freeBytes)} GB free of ${gb(p.totalBytes)} GB. The chain keeps growing, and the node stops when the disk is full.${link("/nodes")}` });
    } else if (type === "chain_copy_failed" && config.events.has("node_update")) {
      send({ event: "node_update", data: p, text: `❌ Copying chain data from ${p.from} to ${p.to} failed: ${p.error}${link("/nodes")}` });
    } else if (type === "node_ready" && config.events.has("mining_paused")) {
      send({ event: "mining_resumed", data: p, text: "▶️ Mining resumed: the node is ready again." });
    }
  }

  // Workers with an accepted share in the last day are tracked. A worker is offline after
  // ALERT_WORKER_OFFLINE_MINUTES without one. The first pass only records state, so a restart
  // does not re-announce workers that were already offline.
  /** @type {Map<string, boolean>} */
  const online = new Map();
  let firstPass = true;
  async function checkWorkers() {
    if (!config.events.has("worker_offline")) return;
    const result = await pool.query(
      `SELECT m.address, w.name, max(s.bucket) AS last_share
       FROM worker_stats_1m s
       JOIN workers w ON w.id = s.worker_id
       JOIN miners m ON m.id = w.miner_id
       WHERE s.accepted > 0 AND s.bucket >= now() - interval '24 hours'
       GROUP BY m.address, w.name`,
    );
    // A share lands in its minute's bucket, so allow one extra minute before calling it silent.
    const cutoff = Date.now() - (config.workerOfflineMinutes + 1) * 60_000;
    for (const row of result.rows) {
      const key = `${row.address}/${row.name}`;
      const isOnline = row.last_share.getTime() >= cutoff;
      const was = online.get(key);
      online.set(key, isOnline);
      if (firstPass || was === undefined || was === isOnline) continue;
      const path = `/miner/${row.address}/worker/${encodeURIComponent(row.name)}`;
      send(isOnline
        ? { event: "worker_online", data: { address: row.address, worker: row.name },
          text: `🟢 Worker ${row.name} (${shortAddress(row.address)}) is sending shares again.${link(path)}` }
        : { event: "worker_offline", data: { address: row.address, worker: row.name, lastShare: row.last_share.toISOString() },
          text: `🔴 Worker ${row.name} (${shortAddress(row.address)}) has sent no accepted shares for ${config.workerOfflineMinutes} minute${config.workerOfflineMinutes === 1 ? "" : "s"}.${link(path)}` });
    }
    firstPass = false;
  }
  const workerTimer = setInterval(() => {
    checkWorkers().catch((error) => logger.warn?.(`Worker offline check failed: ${message(error)}`));
  }, 60_000);
  workerTimer.unref();
  void checkWorkers().catch((error) => logger.warn?.(`Worker offline check failed: ${message(error)}`));

  return {
    /** Feed a `xeldash_live` notification payload. @param {string} payload */
    handleNotification(payload) {
      let note;
      try {
        note = JSON.parse(payload);
      } catch {
        return;
      }
      if (note.type !== "event") return;
      onEvent(note.id, note.eventType).catch((error) => logger.warn?.(`Alert for event ${note.id} failed: ${message(error)}`));
    },
    stop() {
      clearInterval(workerTimer);
      if (finalTimer) clearTimeout(finalTimer);
    },
  };
}
