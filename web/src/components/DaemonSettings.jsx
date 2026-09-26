import { useCallback, useEffect, useMemo, useState } from "react";
import { formatAgo, formatTime } from "../format.js";
import { Card, HealthBadge } from "./ui.jsx";

const UNCHANGED_SECRET = "__unchanged__";
const GROUP_ORDER = ["Core", "P2P", "RPC", "GetWork", "Storage", "Logging", "Metrics"];

/** @param {Record<string, string | true>} a @param {Record<string, string | true>} b */
function sameValues(a, b) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].every((k) => a[k] === b[k]);
}

/**
 * The daemon's own options, read from its --help by node-admin, edited here and applied on
 * a node restart. Changes are checked by the daemon's parser before they take effect, and put
 * back automatically if the node does not stay up with them.
 * @param {{ token: string, onUnauthorized: () => void }} props
 */
export default function DaemonSettings({ token, onUnauthorized }) {
  const [data, setData] = useState(/** @type {any} */ (null));
  const [draft, setDraft] = useState(/** @type {Record<string, string | true>} */ ({}));
  const [query, setQuery] = useState("");
  const [changedOnly, setChangedOnly] = useState(false);
  const [expanded, setExpanded] = useState(/** @type {string | null} */ (null));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(/** @type {string | null} */ (null));
  const [waiting, setWaiting] = useState(false);

  const load = useCallback(async () => {
    const response = await fetch("/api/v1/node/settings");
    if (!response.ok) return;
    const next = await response.json();
    setData((previous) => {
      // Reset the draft when the saved state changes (first load, save, or the node applied it).
      const saved = next.pending ?? next.current;
      const before = previous ? previous.pending ?? previous.current : null;
      if (!before || !sameValues(saved, before)) setDraft({ ...saved });
      return next;
    });
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(load, waiting ? 2_000 : 15_000);
    return () => clearInterval(timer);
  }, [load, waiting]);

  // After "Save and restart", poll until the node reports the outcome.
  useEffect(() => {
    if (waiting && data && !data.pending) setWaiting(false);
  }, [waiting, data]);

  const locked = !data?.actionsEnabled || !token;
  const current = data?.current ?? {};
  const saved = data?.pending ?? current;
  const dirty = data ? !sameValues(draft, saved) : false;
  const changedFromDefault = Object.keys(draft).length;

  const groups = useMemo(() => {
    if (!data?.schema) return [];
    const q = query.trim().toLowerCase();
    /** @type {Map<string, any[]>} */
    const byGroup = new Map();
    for (const s of data.schema) {
      if (changedOnly && !(s.flag in draft)) continue;
      if (q && !s.flag.includes(q) && !s.description.toLowerCase().includes(q)) continue;
      byGroup.set(s.group, [...(byGroup.get(s.group) ?? []), s]);
    }
    return GROUP_ORDER.filter((g) => byGroup.has(g)).map((g) => [g, byGroup.get(g) ?? []]);
  }, [data, query, changedOnly, draft]);

  /** @param {string} flag @param {string | true | null} value */
  function set(flag, value) {
    setDraft((d) => {
      const next = { ...d };
      if (value === null || value === "") delete next[flag];
      else next[flag] = value;
      return next;
    });
  }

  /** @param {boolean} apply */
  async function save(apply) {
    setBusy(true);
    setError(null);
    try {
      const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
      const response = await fetch("/api/v1/node/settings", { method: "PUT", headers, body: JSON.stringify({ values: draft }) });
      const body = await response.json().catch(() => ({}));
      if (response.status === 401) onUnauthorized();
      if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
      if (apply && body.pending) {
        const applied = await fetch("/api/v1/node/settings/apply", { method: "POST", headers });
        if (!applied.ok) throw new Error((await applied.json().catch(() => ({}))).error ?? `HTTP ${applied.status}`);
        setWaiting(true);
      }
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function discard() {
    setError(null);
    if (data?.pending) {
      await fetch("/api/v1/node/settings/discard", { method: "POST", headers: { authorization: `Bearer ${token}` } });
      await load();
    }
    setDraft({ ...current });
  }

  if (!data) return null;
  if (!data.available) {
    return (
      <Card title="Daemon settings">
        <p className="text-sm text-ink-2">The node has not reported its settings yet. They appear once it has started.</p>
      </Card>
    );
  }

  const r = data.lastResult;
  return (
    <Card title="Daemon settings"
      subtitle={`${data.schema.length} options from the installed daemon. ${changedFromDefault ? `${changedFromDefault} changed from the default.` : "All at their defaults."}`}>
      <div className="space-y-4">
        {waiting && <p className="text-sm text-ink-2">Restarting the node with the new settings…</p>}
        {!waiting && r && (
          <div className="flex flex-wrap items-start gap-2 rounded-md border border-line p-3 text-sm">
            <HealthBadge level={r.outcome === "applied" ? "good" : r.outcome === "rejected" ? "critical" : "warning"}
              label={r.outcome === "applied" ? "Last change applied" : r.outcome === "rejected" ? "Last change rejected" : "Last change rolled back"} />
            <span className="text-xs text-muted" title={formatTime(r.at)}>{formatAgo(r.at)}</span>
            {r.message && <p className="basis-full break-words text-xs text-ink-2">{r.message}</p>}
          </div>
        )}
        {data.pending && !waiting && (
          <p className="text-sm text-ink-2">Saved changes are waiting for the next node restart.</p>
        )}

        <div className="flex flex-wrap items-center gap-3">
          <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search options"
            aria-label="Search options" className="min-w-0 flex-1 rounded-md border border-line bg-page px-3 py-1.5 text-sm text-ink" />
          <label className="flex items-center gap-2 text-sm text-ink-2">
            <input type="checkbox" checked={changedOnly} onChange={(e) => setChangedOnly(e.target.checked)} />
            Changed only
          </label>
        </div>

        {groups.length === 0 && <p className="text-sm text-muted">No options match.</p>}
        {groups.map(([group, items]) => (
          <details key={group} open={Boolean(query) || changedOnly || group === "Core"} className="rounded-md border border-line">
            <summary className="cursor-pointer select-none px-3 py-2 text-sm font-semibold text-ink">
              {group} <span className="font-normal text-muted">· {items.length}{items.some((s) => s.flag in draft) ? ` · ${items.filter((s) => s.flag in draft).length} changed` : ""}</span>
            </summary>
            <ul className="divide-y divide-line">
              {items.map((s) => {
                const value = draft[s.flag];
                const changed = s.flag in draft;
                const [firstLine, ...rest] = s.description.split("\n\n");
                const open = expanded === s.flag;
                return (
                  <li key={s.flag} className="grid gap-2 px-3 py-2.5 sm:grid-cols-[1fr_16rem] sm:items-start">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <code className="break-all text-sm text-ink">--{s.flag}</code>
                        {changed && <span className="rounded bg-wash px-1.5 py-0.5 text-xs text-ink-2">Changed</span>}
                        {s.caution && <span className="text-xs text-serious" title="Changes how the node stores or checks the chain">⚠ Use with care</span>}
                      </div>
                      <p className="mt-0.5 text-xs text-ink-2">{firstLine}</p>
                      {rest.length > 0 && (
                        <button type="button" onClick={() => setExpanded(open ? null : s.flag)} className="text-xs text-muted underline decoration-line underline-offset-2">
                          {open ? "Less" : "More"}
                        </button>
                      )}
                      {open && <p className="mt-1 whitespace-pre-line text-xs text-ink-2">{rest.join("\n\n")}</p>}
                    </div>
                    <div className="flex items-center gap-2">
                      {s.valueName === null ? (
                        <label className="flex items-center gap-2 text-sm text-ink">
                          <input type="checkbox" disabled={locked} checked={value === true}
                            onChange={(e) => set(s.flag, e.target.checked ? true : null)} />
                          {value === true ? "On" : "Off"}
                        </label>
                      ) : s.choices.length > 0 ? (
                        <select disabled={locked} value={typeof value === "string" ? value : ""} onChange={(e) => set(s.flag, e.target.value || null)}
                          className="w-full rounded-md border border-line bg-page px-2 py-1.5 text-sm text-ink">
                          <option value="">Default{s.default ? ` (${s.default})` : ""}</option>
                          {s.choices.map((c) => <option key={c} value={c}>{c}</option>)}
                        </select>
                      ) : (
                        <input type={s.secret ? "password" : "text"} disabled={locked} autoComplete="off"
                          value={value === UNCHANGED_SECRET ? "" : typeof value === "string" ? value : ""}
                          placeholder={value === UNCHANGED_SECRET ? "Saved (hidden)" : s.default ? `Default: ${s.default}` : "Not set"}
                          onChange={(e) => set(s.flag, e.target.value || (value === UNCHANGED_SECRET ? UNCHANGED_SECRET : null))}
                          className="w-full min-w-0 rounded-md border border-line bg-page px-2 py-1.5 text-sm text-ink" />
                      )}
                      {changed && !locked && (
                        <button type="button" onClick={() => set(s.flag, null)} title="Back to the default"
                          className="text-xs text-ink-2 underline decoration-line underline-offset-2 hover:text-ink">Reset</button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          </details>
        ))}

        <p className="text-xs text-muted">
          Set by xelDash and not editable here: {data.locked.map((f) => `--${f}`).join(", ")}.
        </p>

        {error && <p className="text-sm text-critical">{error}</p>}
        {!locked && (dirty || data.pending) && (
          <div className="sticky bottom-3 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-line bg-surface p-3 shadow-sm">
            <span className="text-sm text-ink-2">
              {dirty ? "Unsaved changes." : "Saved; applies on the next restart."} The node restarts to apply them; with a second node, mining continues on it.
            </span>
            <span className="flex gap-2">
              <button type="button" disabled={busy} onClick={() => void discard()}
                className="rounded-md border border-line px-3 py-1.5 text-sm text-ink hover:bg-wash disabled:opacity-40">Discard</button>
              <button type="button" disabled={busy} onClick={() => void save(true)}
                className="rounded-md bg-series-1 px-3 py-1.5 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-40">
                Save and restart node
              </button>
            </span>
          </div>
        )}
      </div>
    </Card>
  );
}
