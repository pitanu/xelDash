import { TOKEN_KEY } from "./components/AdminUnlock.jsx";

/**
 * The installer opens the dashboard with the admin token after a "?token=" in the address
 * (after the #, so it is never sent to any server). Keep it for this browser session and take
 * it out of the address bar and the browser history entry at once.
 */
export function consumeTokenFromUrl() {
  const match = /[?&]token=([0-9a-zA-Z_-]{20,200})/.exec(window.location.hash);
  if (!match) return;
  try {
    sessionStorage.setItem(TOKEN_KEY, match[1]);
  } catch {
    // Private mode: the token has to be typed instead.
  }
  const clean = window.location.hash.replace(/[?&]token=[0-9a-zA-Z_-]+/, "").replace(/\?$/, "");
  window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}${clean}`);
}
