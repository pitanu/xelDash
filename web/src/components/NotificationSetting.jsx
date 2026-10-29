import { useState } from "react";
import {
  askForNotifications, notificationPermission, notificationSources, setChosenNotifications, showNotification, useChosenNotifications,
} from "../notifications.js";
import { SettingBlock } from "./ui.jsx";

/**
 * Per-browser notifications: which kinds this browser shows, once the browser allows them (notifications.js).
 * `visitor`: a public server's visitor, who can be told of blocks found here and nothing else.
 * @param {{ visitor?: boolean, row?: boolean }} props
 */
export default function NotificationSetting({ visitor = false, row = false }) {
  const chosen = useChosenNotifications();
  const [permission, setPermission] = useState(notificationPermission);
  const sources = notificationSources(visitor);

  async function allow() {
    setPermission(await askForNotifications());
  }
  /** @param {string} id @param {boolean} on */
  async function choose(id, on) {
    if (on && permission === "default") setPermission(await askForNotifications());
    setChosenNotifications(on ? [...chosen, id] : chosen.filter((k) => k !== id));
  }

  return (
    <SettingBlock row={row} title="Browser notifications"
      subtitle={`A notification on this computer while the dashboard is open in a background tab${visitor ? ", when a block is found on this server" : ", for the kinds you tick"}. Saved in this browser only.`}
      aside={permission === "default" ? <button type="button" className="btn" onClick={() => void allow()}>Allow notifications</button> : null}>
      {permission === "unsupported" && <p className="text-sm text-ink-2">This browser cannot show notifications.</p>}
      {permission === "denied" && (
        <p role="alert" className="mb-2 text-sm text-warning">
          Notifications are blocked for this site. Allow them in the browser&apos;s site settings (the icon left of the address), then reload.
        </p>
      )}
      {permission !== "unsupported" && (
        <>
          <fieldset className="grid gap-x-6 gap-y-2 sm:grid-cols-2" disabled={permission === "denied"}>
            <legend className="sr-only">Notify me when</legend>
            {sources.map((source) => (
              <label key={source.id} className="flex items-start gap-2 text-sm">
                <input type="checkbox" checked={chosen.includes(source.id)} onChange={(e) => void choose(source.id, e.target.checked)} />
                {source.label}
              </label>
            ))}
          </fieldset>
          {permission === "granted" && (
            <button type="button" className="btn btn-sm mt-3"
              onClick={() => showNotification({ title: "xelDash test notification", body: "If you can see this, notifications reach you.", path: "/settings", tag: "test" }, { always: true })}>
              Send a test notification
            </button>
          )}
        </>
      )}
    </SettingBlock>
  );
}
