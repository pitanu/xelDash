import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

// Where alerts go, chosen on the dashboard and kept on the shared config volume, where the API
// reads it. ALERT_* in .env only supply the starting values. The webhook addresses and the
// Telegram token are secrets: the dashboard is only ever shown that they are set, and the end of them.

const EVENTS = ["block_found", "block_rejected", "block_final", "block_side", "mining_paused", "worker_offline", "node_update"];
const TELEGRAM_TOKEN = /^\d{5,15}:[A-Za-z0-9_-]{20,60}$/;
const TELEGRAM_CHAT = /^(-?\d{1,20}|@[A-Za-z][A-Za-z0-9_]{3,31})$/;

/** What was entered wrongly, in words a beginner can act on. */
export class AlertSettingsProblem extends Error {}

/** @param {string} value @param {string} what @param {boolean} httpsOnly */
function checkUrl(value, what, httpsOnly) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new AlertSettingsProblem(`The ${what} is not a web address. Paste the whole link.`);
  }
  if (url.protocol !== "https:" && (httpsOnly || url.protocol !== "http:")) {
    throw new AlertSettingsProblem(`The ${what} must start with ${httpsOnly ? "https://" : "http:// or https://"}.`);
  }
  return url.toString();
}

/** @param {string | null} secret */
function hint(secret) {
  return secret ? { set: true, end: secret.slice(-4) } : { set: false, end: null };
}

/** @param {string} url @param {unknown} body */
async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`the service answered HTTP ${response.status}`);
}

export class AlertSettings {
  /** @param {{ configDir: string, env: Partial<Record<string, string | undefined>> }} options */
  constructor({ configDir, env }) {
    this.configDir = configDir;
    this.file = join(configDir, "alerts.json");
    this.env = env;
  }

  /** The saved settings, or the .env values when nothing was saved from the dashboard. */
  async read() {
    try {
      return { ...(await this.fromEnv()), ...JSON.parse(await readFile(this.file, "utf8")) };
    } catch {
      return this.fromEnv();
    }
  }

  async fromEnv() {
    const value = (/** @type {string} */ name) => (this.env[name] ?? "").trim() || null;
    const listed = (value("ALERT_EVENTS") ?? "").split(",").map((e) => e.trim()).filter((e) => EVENTS.includes(e));
    return {
      discordWebhookUrl: value("ALERT_DISCORD_WEBHOOK_URL"),
      telegramBotToken: value("ALERT_TELEGRAM_BOT_TOKEN"),
      telegramChatId: value("ALERT_TELEGRAM_CHAT_ID"),
      webhookUrl: value("ALERT_WEBHOOK_URL"),
      events: listed.length > 0 ? listed : EVENTS,
      workerOfflineMinutes: Number(value("ALERT_WORKER_OFFLINE_MINUTES") ?? "10") || 10,
      dashboardUrl: value("ALERT_DASHBOARD_URL"),
    };
  }

  async status() {
    const s = await this.read();
    return {
      discord: hint(s.discordWebhookUrl),
      telegram: { ...hint(s.telegramBotToken), chatId: s.telegramChatId },
      webhook: hint(s.webhookUrl),
      events: s.events,
      allEvents: EVENTS,
      workerOfflineMinutes: s.workerOfflineMinutes,
      dashboardUrl: s.dashboardUrl,
    };
  }

  /**
   * Change some settings. A missing field is left as it is, an empty string removes it.
   * @param {Record<string, unknown>} input
   */
  async set(input) {
    const s = await this.read();
    /** @param {string} key */
    const text = (key) => (typeof input[key] === "string" ? /** @type {string} */ (input[key]).trim() : undefined);

    const discord = text("discordWebhookUrl");
    if (discord !== undefined) {
      s.discordWebhookUrl = discord ? checkUrl(discord, "Discord webhook address", true) : null;
      if (s.discordWebhookUrl && !/^https:\/\/(?:[a-z]+\.)?discord(?:app)?\.com\/api\/webhooks\//i.test(s.discordWebhookUrl)) {
        throw new AlertSettingsProblem("That does not look like a Discord webhook (it starts with https://discord.com/api/webhooks/).");
      }
    }
    const token = text("telegramBotToken");
    if (token !== undefined) {
      if (token && !TELEGRAM_TOKEN.test(token)) throw new AlertSettingsProblem("The Telegram bot token looks like 123456789:ABC... Copy it again from @BotFather.");
      s.telegramBotToken = token || null;
    }
    const chat = text("telegramChatId");
    if (chat !== undefined) {
      if (chat && !TELEGRAM_CHAT.test(chat)) throw new AlertSettingsProblem("The Telegram chat id is a number (it may start with -) or @channelname.");
      s.telegramChatId = chat || null;
    }
    if (Boolean(s.telegramBotToken) !== Boolean(s.telegramChatId)) {
      throw new AlertSettingsProblem("Telegram needs both the bot token and the chat id.");
    }
    const webhook = text("webhookUrl");
    if (webhook !== undefined) s.webhookUrl = webhook ? checkUrl(webhook, "webhook address", false) : null;
    const dashboard = text("dashboardUrl");
    if (dashboard !== undefined) s.dashboardUrl = dashboard ? checkUrl(dashboard, "dashboard address", false) : null;

    if (input.events !== undefined) {
      if (!Array.isArray(input.events) || input.events.some((e) => !EVENTS.includes(e))) {
        throw new AlertSettingsProblem("Unknown alert type.");
      }
      s.events = [...new Set(/** @type {string[]} */ (input.events))];
    }
    if (input.workerOfflineMinutes !== undefined) {
      const minutes = input.workerOfflineMinutes;
      if (typeof minutes !== "number" || !Number.isSafeInteger(minutes) || minutes < 1 || minutes > 1440) {
        throw new AlertSettingsProblem("Minutes without a share must be a whole number from 1 to 1440.");
      }
      s.workerOfflineMinutes = minutes;
    }

    await mkdir(this.configDir, { recursive: true });
    // Holds secrets: readable by the services that share the volume, not by other users.
    await writeFile(`${this.file}.tmp`, `${JSON.stringify(s, null, 2)}\n`, { mode: 0o644 });
    await rename(`${this.file}.tmp`, this.file);
    return this.status();
  }

  /**
   * Send a message to each place alerts go now, and say for each whether it arrived.
   * @returns {Promise<{ channel: string, ok: boolean, error?: string }[]>}
   */
  async test() {
    const s = await this.read();
    const text = "✅ xelDash test message. If you can read this, alerts reach you.";
    /** @type {[string, () => Promise<void>][]} */
    const jobs = [];
    if (s.discordWebhookUrl) jobs.push(["Discord", () => postJson(s.discordWebhookUrl, { content: text, allowed_mentions: { parse: [] } })]);
    if (s.telegramBotToken && s.telegramChatId) {
      jobs.push(["Telegram", () => postJson(`https://api.telegram.org/bot${s.telegramBotToken}/sendMessage`, { chat_id: s.telegramChatId, text })]);
    }
    if (s.webhookUrl) jobs.push(["Webhook", () => postJson(s.webhookUrl, { event: "test", text, sentAt: new Date().toISOString() })]);
    return Promise.all(jobs.map(async ([channel, send]) => {
      try {
        await send();
        return { channel, ok: true };
      } catch (error) {
        // The message can carry the address being posted to when fetch fails; drop URLs from it.
        const reason = (error instanceof Error ? error.message : String(error)).replace(/https?:\/\/\S+/g, "(address hidden)");
        return { channel, ok: false, error: reason };
      }
    }));
  }
}
