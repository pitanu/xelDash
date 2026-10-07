import { useCallback, useEffect, useState } from "react";
import { Card } from "./ui.jsx";

const EVENT_LABELS = /** @type {Record<string, string>} */ ({
  block_found: "A block is found",
  block_rejected: "The node rejects a block",
  block_side: "A block of yours is a side block (still paid once final)",
  block_final: "A block becomes final (paid or orphaned)",
  mining_paused: "Mining pauses or moves to another node",
  worker_offline: "A worker stops sending shares",
  node_update: "A node is updated",
  disk_low: "The disk is running low on space",
  cluster: "A server takes over the shared address (redundancy)",
});

/**
 * @typedef {{ set: boolean, end: string | null }} SecretState
 * @typedef {{ discord: SecretState, telegram: SecretState & { chatId: string | null }, webhook: SecretState,
 *   events: string[], allEvents: string[], workerOfflineMinutes: number, dashboardUrl: string | null }} AlertStatus
 */

const inputClass = "w-full rounded-md border border-line bg-page px-3 py-1.5 text-sm text-ink disabled:opacity-50";

/**
 * One secret field: shows that it is set (and its last characters), never the value itself.
 * @param {{ label: string, help: React.ReactNode, state: SecretState, value: string, onChange: (v: string) => void, placeholder: string, disabled: boolean }} props
 */
function SecretField({ label, help, state, value, onChange, placeholder, disabled }) {
  return (
    <label className="block text-sm">
      <span className="font-medium text-ink">{label}</span>
      {state.set && <span className="ml-2 text-xs text-good">set (ends in {state.end}); type a new one to replace it, or a single - to remove it</span>}
      <input type="text" value={value} onChange={(e) => onChange(e.target.value)} autoComplete="off" spellCheck={false}
        placeholder={state.set ? "leave empty to keep" : placeholder} disabled={disabled} className={`${inputClass} mt-1 font-mono`} />
      <span className="mt-1 block text-xs text-ink-2">{help}</span>
    </label>
  );
}

/**
 * Where alerts are sent and which ones, with a button that sends a test message. Saved on the
 * server and applied to the running alerts within seconds.
 * @param {{ token: string, onUnauthorized: () => void }} props
 */
export default function AlertSettings({ token, onUnauthorized }) {
  const [status, setStatus] = useState(/** @type {AlertStatus | null} */ (null));
  const [discord, setDiscord] = useState("");
  const [telegramToken, setTelegramToken] = useState("");
  const [telegramChat, setTelegramChat] = useState("");
  const [webhook, setWebhook] = useState("");
  const [events, setEvents] = useState(/** @type {string[]} */ ([]));
  const [minutes, setMinutes] = useState("10");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(/** @type {{ ok: boolean, text: string } | null} */ (null));
  const [test, setTest] = useState(/** @type {{ channel: string, ok: boolean, error?: string }[] | null} */ (null));

  /** @param {AlertStatus} s */
  const apply = useCallback((s) => {
    setStatus(s);
    setEvents(s.events);
    setMinutes(String(s.workerOfflineMinutes));
    setTelegramChat(s.telegram.chatId ?? "");
  }, []);

  useEffect(() => {
    fetch("/api/v1/node/alerts").then((r) => (r.ok ? r.json() : null)).then((s) => s && apply(s)).catch(() => {});
  }, [apply]);

  /** @param {string} path @param {string} method @param {unknown} [body] */
  async function call(path, method, body) {
    const response = await fetch(`/api/v1/node${path}`, {
      method,
      headers: { "x-admin-token": token, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const answer = await response.json().catch(() => ({}));
    if (response.status === 401) onUnauthorized();
    if (!response.ok) throw new Error(answer.error ?? `HTTP ${response.status}`);
    return answer;
  }

  /** A field left empty is unchanged, a single "-" removes it. @param {string} value */
  const change = (value) => (value.trim() === "" ? undefined : value.trim() === "-" ? "" : value.trim());

  async function save() {
    setBusy(true);
    setMessage(null);
    setTest(null);
    const number = Number(minutes);
    try {
      const saved = await call("/alerts", "PUT", {
        discordWebhookUrl: change(discord),
        telegramBotToken: change(telegramToken),
        // Removing the token removes the chat id with it.
        telegramChatId: telegramToken.trim() === "-" ? "" : telegramChat.trim() === (status?.telegram.chatId ?? "") ? undefined : telegramChat.trim(),
        webhookUrl: change(webhook),
        events,
        workerOfflineMinutes: number,
      });
      apply(saved);
      setDiscord("");
      setTelegramToken("");
      setWebhook("");
      setMessage({ ok: true, text: "Saved. Alerts use the new settings within a few seconds." });
    } catch (e) {
      setMessage({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }

  async function sendTest() {
    setBusy(true);
    setMessage(null);
    setTest(null);
    try {
      const answer = await call("/alerts/test", "POST");
      if (answer.none) setMessage({ ok: false, text: "Nothing is set up yet. Add a Discord, Telegram or webhook address and save first." });
      else setTest(answer.results);
    } catch (e) {
      setMessage({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }

  const disabled = !token || busy;
  const anySet = Boolean(status && (status.discord.set || status.telegram.set || status.webhook.set));
  return (
    <Card title="Where to send alerts"
      subtitle="Get a message on your phone when a block is found, mining stops, or a worker goes quiet. Set up one or more places below, save, then send a test message.">
      {!status ? (
        <p className="text-sm text-ink-2">Loading...</p>
      ) : (
        <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); void save(); }}>
          <SecretField label="Discord" state={status.discord} value={discord} onChange={setDiscord} disabled={disabled}
            placeholder="https://discord.com/api/webhooks/..."
            help="In Discord: channel settings, Integrations, Webhooks, New Webhook, Copy Webhook URL." />
          <div className="grid gap-3 sm:grid-cols-2">
            <SecretField label="Telegram bot token" state={status.telegram} value={telegramToken} onChange={setTelegramToken} disabled={disabled}
              placeholder="123456789:ABC..." help="Create a bot by chatting with @BotFather in Telegram; it gives you the token." />
            <label className="block text-sm">
              <span className="font-medium text-ink">Telegram chat id</span>
              <input type="text" value={telegramChat} onChange={(e) => setTelegramChat(e.target.value)} autoComplete="off" spellCheck={false}
                placeholder="123456789" disabled={disabled} className={`${inputClass} mt-1 font-mono`} />
              <span className="mt-1 block text-xs text-ink-2">Send your bot a message, then open api.telegram.org/bot&lt;token&gt;/getUpdates to find your chat id.</span>
            </label>
          </div>
          <SecretField label="Other (webhook)" state={status.webhook} value={webhook} onChange={setWebhook} disabled={disabled}
            placeholder="https://..." help="For your own tools (Home Assistant, ntfy, n8n): xelDash sends them a JSON message." />

          <fieldset>
            <legend className="text-sm font-medium text-ink">Tell me when</legend>
            <div className="mt-2 grid gap-1 sm:grid-cols-2">
              {status.allEvents.map((event) => (
                <label key={event} className="flex items-center gap-2 text-sm text-ink-2">
                  <input type="checkbox" checked={events.includes(event)} disabled={disabled}
                    onChange={(e) => setEvents(e.target.checked ? [...events, event] : events.filter((x) => x !== event))} />
                  {EVENT_LABELS[event] ?? event}
                </label>
              ))}
            </div>
            <label className="mt-3 flex flex-wrap items-center gap-2 text-sm text-ink-2">
              A worker counts as offline after
              <input type="number" min={1} max={1440} value={minutes} onChange={(e) => setMinutes(e.target.value)} disabled={disabled}
                className="w-20 rounded-md border border-line bg-page px-2 py-1 text-sm text-ink" />
              minutes without a share
            </label>
          </fieldset>

          <div className="flex flex-wrap items-center gap-3">
            <button type="submit" disabled={disabled}
              className="rounded-md bg-action px-3 py-1.5 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-40">
              {busy ? "Working..." : "Save"}
            </button>
            <button type="button" disabled={disabled || !anySet} onClick={() => void sendTest()}
              className="rounded-md border border-line px-3 py-1.5 text-sm text-ink hover:bg-wash disabled:opacity-40">
              Send a test message
            </button>
            {!token && <span className="text-xs text-ink-2">Unlock above to change alerts.</span>}
          </div>
          {message && <p role="alert" className={`text-sm ${message.ok ? "text-good" : "text-critical"}`}>{message.text}</p>}
          {test && (
            <ul className="space-y-1 text-sm">
              {test.map((r) => (
                <li key={r.channel} className={r.ok ? "text-good" : "text-critical"}>
                  {r.ok ? `${r.channel}: sent. Check that the message arrived.` : `${r.channel}: failed (${r.error}). Check the address and try again.`}
                </li>
              ))}
            </ul>
          )}
        </form>
      )}
    </Card>
  );
}
