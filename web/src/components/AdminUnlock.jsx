import { useState } from "react";
import { Card } from "./ui.jsx";

export const TOKEN_KEY = "xeldash.adminToken";

function readToken() {
  try {
    return sessionStorage.getItem(TOKEN_KEY) ?? "";
  } catch {
    return "";
  }
}

/**
 * The admin token for node changes (XELDASH_ADMIN_TOKEN), kept for this browser session.
 * `forget()` after a 401 explains why the page locked; `forget(false)` is a plain sign-out.
 */
export function useAdminToken() {
  const [token, setToken] = useState(readToken);
  const [error, setError] = useState(/** @type {string | null} */ (null));

  /** Check a token with node-admin before keeping it. @param {string} candidate */
  async function unlock(candidate) {
    setError(null);
    try {
      const response = await fetch("/api/v1/node/token/check", { method: "POST", headers: { "x-admin-token": candidate } });
      if (!response.ok) {
        setError(response.status === 401 ? "That token is not right. Check XELDASH_ADMIN_TOKEN in .env." : `Could not check the token (HTTP ${response.status}).`);
        return false;
      }
    } catch {
      setError("Could not reach the node admin service.");
      return false;
    }
    try {
      sessionStorage.setItem(TOKEN_KEY, candidate);
    } catch {
      // Private mode: keep it in memory for this page only.
    }
    setToken(candidate);
    return true;
  }

  /** @param {boolean} [refused] the server turned the token down, rather than the user locking */
  function forget(refused = true) {
    if (refused) setError("The admin token was refused, so nothing was changed. Enter it again; unsaved settings are kept.");
    try {
      sessionStorage.removeItem(TOKEN_KEY);
    } catch {
      // Nothing stored.
    }
    setToken("");
  }

  return { token, error, unlock, forget };
}

/**
 * Explains how to turn changes on, or asks for the token, or offers to lock again.
 * @param {{ actionsEnabled: boolean, admin: ReturnType<typeof useAdminToken> }} props
 */
export function AdminUnlock({ actionsEnabled, admin }) {
  const [input, setInput] = useState("");
  if (!actionsEnabled) {
    return (
      <Card title="Changes are off">
        <p className="text-sm text-ink-2">
          Changing the node needs an admin token. Set <code className="rounded bg-wash px-1">XELDASH_ADMIN_TOKEN</code> in
          {" "}<code className="rounded bg-wash px-1">.env</code> and restart xelDash, then enter it here. Until then this page is read-only.
        </p>
      </Card>
    );
  }
  if (admin.token) {
    return (
      <div className="flex justify-end">
        <button type="button" onClick={() => admin.forget(false)} className="text-xs text-ink-2 underline decoration-line underline-offset-2 hover:text-ink">
          Lock changes
        </button>
      </div>
    );
  }
  return (
    <Card title="Unlock changes" subtitle="Enter the admin token from .env (XELDASH_ADMIN_TOKEN). It is kept for this browser session only.">
      <form className="flex flex-wrap gap-2" onSubmit={(e) => {
        e.preventDefault();
        void admin.unlock(input).then((ok) => ok && setInput(""));
      }}>
        <input type="password" value={input} onChange={(e) => setInput(e.target.value)} autoComplete="off"
          aria-label="Admin token" className="min-w-0 flex-1 rounded-md border border-line bg-page px-3 py-1.5 text-sm text-ink" />
        <button type="submit" disabled={!input}
          className="rounded-md bg-series-1 px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-40">Unlock</button>
      </form>
      {admin.error && <p role="alert" className="mt-2 text-sm text-critical">{admin.error}</p>}
    </Card>
  );
}
