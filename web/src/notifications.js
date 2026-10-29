import { useSyncExternalStore } from "react";
import { ALERT_KIND_LABELS } from "./alert-kinds.js";
import { subscribeLiveMessages } from "./live.js";

// Browser notifications, per browser and off until chosen: each kind the person ticks in Settings, shown while the dashboard is open
// in a background tab (there is no service worker, so a closed dashboard shows nothing). Every kind is a source below; a new kind is
// one more entry, and Settings lists it by itself.
//
// The operator's sources are the server's alerts (services/api/src/alerts.js), relayed over the live feed with their text whether
// or not a channel (Discord, Telegram, webhook) chose them. A public server's visitor gets no alerts, only the block news every
// visitor sees: "A block is found" comes from that.
const KEY = "xeldash.notifications";

/**
 * @typedef {{ kind: string, event: string, text: string, data?: Record<string, any>, sentAt: string }} RelayedAlert
 * @typedef {{ title: string, body: string, path: string, tag: string }} Shown
 * @typedef {{ id: string, label: string, from: (message: any) => Shown | null }} NotificationSource
 */

/** The page an alert is about, as a dashboard route. @param {RelayedAlert} alert */
function pathFor(alert) {
  const d = alert.data ?? {};
  if (alert.kind.startsWith("block_")) return "/blocks";
  if (alert.kind.startsWith("worker_") && d.address && d.worker) return `/miner/${d.address}/worker/${encodeURIComponent(d.worker)}`;
  if (alert.kind === "node_update" || alert.kind === "disk_low") return "/nodes";
  return "/health";
}

/** An alert's text without the links added for chat channels (the notification opens the page itself). @param {string} text */
function plain(text) {
  return text.split("\n").filter((line) => !/^https?:\/\//.test(line.trim())).join("\n").trim();
}

/** @param {string} kind @returns {NotificationSource} */
function alertSource(kind) {
  return {
    id: kind,
    label: ALERT_KIND_LABELS[kind] ?? kind,
    from(message) {
      if (message?.type !== "alert" || message.kind !== kind || typeof message.text !== "string") return null;
      const [title, ...rest] = plain(message.text).split(/(?<=\.)\s+/);
      return { title, body: rest.join(" "), path: pathFor(message), tag: `${message.event}:${message.sentAt}` };
    },
  };
}

/** Every source, in the order Settings lists them. @type {NotificationSource[]} */
export const NOTIFICATION_SOURCES = Object.keys(ALERT_KIND_LABELS).map(alertSource);

/** A public server's visitor: a block found here, from the block news on the live feed. @type {NotificationSource} */
const VISITOR_BLOCKS = {
  id: "block_found",
  label: ALERT_KIND_LABELS.block_found,
  from(message) {
    if (message?.type !== "event" || message.eventType !== "block_submitted") return null;
    return { title: "A block was found on this server", body: "", path: "/blocks", tag: `block_submitted:${message.id}` };
  },
};

/** The sources a view offers: all of them to the operator, the block news to a visitor. @param {boolean} publicView */
export function notificationSources(publicView) {
  return publicView ? [VISITOR_BLOCKS] : NOTIFICATION_SOURCES;
}

/** @type {Set<() => void>} */
const listeners = new Set();
/** Used when the browser stores nothing (a private window). @type {string[]} */
let memory = [];
let snapshot = "";
/** @type {string[]} */
let cached = [];

function read() {
  try {
    const value = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(value) ? value.filter((v) => typeof v === "string") : [];
  } catch {
    return memory;
  }
}

/** The kinds this browser chose. @returns {string[]} */
export function chosenNotifications() {
  return read();
}

/** @param {string[]} kinds */
export function setChosenNotifications(kinds) {
  memory = [...new Set(kinds)];
  try {
    if (memory.length) localStorage.setItem(KEY, JSON.stringify(memory));
    else localStorage.removeItem(KEY);
  } catch {
    // Kept in memory for this page load.
  }
  for (const listener of listeners) listener();
}

/** @param {() => void} listener */
function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The chosen kinds, for React; the same array until they change. */
export function useChosenNotifications() {
  return useSyncExternalStore(subscribe, () => {
    const now = read();
    const key = now.join(",");
    if (key !== snapshot) {
      snapshot = key;
      cached = now;
    }
    return cached;
  });
}

/** "granted", "denied", "default", or "unsupported" in a browser without notifications. */
export function notificationPermission() {
  return typeof Notification === "undefined" ? "unsupported" : Notification.permission;
}

/** Ask the browser to allow notifications (it asks the person, once). @returns {Promise<string>} */
export async function askForNotifications() {
  if (typeof Notification === "undefined") return "unsupported";
  return Notification.requestPermission();
}

/** @param {Shown} shown @param {{ always?: boolean }} [options] */
export function showNotification(shown, { always = false } = {}) {
  if (notificationPermission() !== "granted") return false;
  // The person is looking at the dashboard: the page shows it already.
  if (!always && document.visibilityState === "visible" && document.hasFocus()) return false;
  // The same tag in every open tab, so the browser shows one notification, not one per tab.
  const n = new Notification(shown.title, { body: shown.body, tag: shown.tag, icon: "/icon-192.png" });
  n.onclick = () => {
    window.focus();
    window.location.hash = `#${shown.path}`;
    n.close();
  };
  return true;
}

/** Shows the chosen kinds from the live feed until the returned function is called. @param {boolean} publicView */
export function startNotifications(publicView) {
  const sources = notificationSources(publicView);
  return subscribeLiveMessages((message) => {
    const chosen = read();
    if (chosen.length === 0) return;
    for (const source of sources) {
      if (!chosen.includes(source.id)) continue;
      const shown = source.from(message);
      if (shown) showNotification(shown);
    }
  });
}
