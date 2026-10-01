import { useCallback, useEffect, useMemo, useState } from "react";
import { formatAgo, formatTime } from "../format.js";
import { nodeQuery } from "../nodes.js";
import { GUIDE } from "./settings-guide.js";
import { Card, HealthBadge } from "./ui.jsx";

const UNCHANGED_SECRET = "__unchanged__";
const GROUP_ORDER = ["Core", "P2P", "RPC", "GetWork", "Storage", "Logging", "Metrics"];

/** @param {Record<string, string | true>} a @param {Record<string, string | true>} b */
function sameValues(a, b) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].every((k) => a[k] === b[k]);
}

const PEER_FLAGS = /** @type {const} */ ({ priority: "priority-nodes", exclusive: "exclusive-nodes" });
// Same rule as node-admin: IPv4:port or [IPv6]:port.
const PEER = /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}|\[[0-9A-Fa-f:.]+\]):([1-9]\d{0,4})$/;

/** @param {string} text */
function splitPeers(text) {
  return text.split(/[\s,]+/).filter(Boolean);
}

/**
 * The input for one daemon option: a switch, a list of choices, or a text value.
 * @param {{ s: any, value: string | true | undefined, locked: boolean, placeholder?: string,
 *   set: (flag: string, value: string | true | null) => void }} props
 */
function Control({ s, value, locked, placeholder, set }) {
  const changed = value !== undefined;
  return (
    <div className="flex items-center gap-2">
      {s.valueName === null ? (
        <label className="flex items-center gap-2 text-sm text-ink">
          <input type="checkbox" aria-label={s.flag} disabled={locked} checked={value === true}
            onChange={(e) => set(s.flag, e.target.checked ? true : null)} />
          {value === true ? "On" : "Off"}
        </label>
      ) : s.choices.length > 0 ? (
        <select aria-label={s.flag} disabled={locked} value={typeof value === "string" ? value : ""} onChange={(e) => set(s.flag, e.target.value || null)}
          className="w-full rounded-md border border-line bg-page px-2 py-1.5 text-sm text-ink">
          <option value="">Default{s.default ? ` (${s.default})` : ""}</option>
          {s.choices.map((/** @type {string} */ c) => <option key={c} value={c}>{c}</option>)}
        </select>
      ) : (
        <input type={s.secret ? "password" : "text"} aria-label={s.flag} disabled={locked} autoComplete="off"
          value={value === UNCHANGED_SECRET ? "" : typeof value === "string" ? value : ""}
          placeholder={value === UNCHANGED_SECRET ? "Saved (hidden)" : s.default ? `Default: ${s.default}` : placeholder ?? "Not set"}
          onChange={(e) => set(s.flag, e.target.value || (value === UNCHANGED_SECRET ? UNCHANGED_SECRET : null))}
          className="w-full min-w-0 rounded-md border border-line bg-page px-2 py-1.5 text-sm text-ink" />
      )}
      {changed && !locked && (
        <button type="button" onClick={() => set(s.flag, null)} title="Back to the default"
          className="inline-flex min-h-6 items-center text-xs text-ink-2 underline decoration-line underline-offset-2 hover:text-ink">Reset</button>
      )}
    </div>
  );
}

/**
 * Trusted peers: a friendlier editor for --priority-nodes and --exclusive-nodes, working on
 * the same draft as the full option list below.
 * @param {{ draft: Record<string, string | true>, set: (flag: string, value: string | true | null) => void, locked: boolean }} props
 */
function TrustedPeers({ draft, set, locked }) {
  const both = typeof draft[PEER_FLAGS.priority] === "string" && typeof draft[PEER_FLAGS.exclusive] === "string";
  const mode = typeof draft[PEER_FLAGS.exclusive] === "string" ? "exclusive" : "priority";
  const saved = /** @type {string | undefined} */ (draft[PEER_FLAGS[mode]]) ?? "";
  const [text, setText] = useState(splitPeers(saved).join("\n"));
  // Follow the draft when it changes elsewhere (discard, reset, the list below).
  useEffect(() => {
    setText((t) => (splitPeers(t).join(",") === splitPeers(saved).join(",") ? t : splitPeers(saved).join("\n")));
  }, [saved]);

  const peers = splitPeers(text);
  const invalid = peers.filter((p) => {
    const port = Number(PEER.exec(p)?.[1] ?? 0);
    return port < 1 || port > 65535;
  });

  /** @param {string} next */
  function edit(next) {
    setText(next);
    set(PEER_FLAGS[mode], splitPeers(next).join(",") || null);
  }

  /** @param {"priority" | "exclusive"} next */
  function switchMode(next) {
    if (next === mode) return;
    set(PEER_FLAGS[next], peers.join(",") || null);
    set(PEER_FLAGS[mode], null);
  }

  return (
    <section className="space-y-2">
      <div>
        <h3 className="text-sm font-semibold text-ink">Trusted peers</h3>
        <p className="text-xs text-ink-2">Nodes you trust, such as your other XELIS nodes or a friend's. One IP:port per line, for example 203.0.113.5:2125. Leave empty to rely on normal peer discovery.</p>
      </div>
      <div className="space-y-2 rounded-md border border-line p-3">
        {both ? (
          <p className="text-xs text-serious">Both --priority-nodes and --exclusive-nodes are set. Edit them under All daemon options below.</p>
        ) : (
          <>
            <textarea value={text} disabled={locked} rows={Math.min(8, Math.max(3, peers.length + 1))} spellCheck={false}
              onChange={(e) => edit(e.target.value)} aria-label="Trusted peers" placeholder={"203.0.113.5:2125\n198.51.100.7:2125"}
              className="w-full rounded-md border border-line bg-page px-3 py-2 font-mono text-sm text-ink" />
            {invalid.length > 0 && (
              <p className="text-xs text-critical">Not an IP:port: {invalid.join(", ")}. Host names are not accepted by the daemon.</p>
            )}
            <fieldset className="grid gap-2 sm:grid-cols-2" disabled={locked}>
              <legend className="sr-only">How the node uses these peers</legend>
              <label className="flex gap-2 rounded-md border border-line p-2 text-sm">
                <input type="radio" name="peer-mode" checked={mode === "priority"} onChange={() => switchMode("priority")} />
                <span><span className="font-medium text-ink">Priority</span>
                  <span className="block text-xs text-ink-2">Connect to these first, and still find other peers as usual.</span></span>
              </label>
              <label className="flex gap-2 rounded-md border border-line p-2 text-sm">
                <input type="radio" name="peer-mode" checked={mode === "exclusive"} onChange={() => switchMode("exclusive")} />
                <span><span className="font-medium text-ink">Exclusive</span>
                  <span className="block text-xs text-ink-2">Only ever talk to these peers. If they all go down, the node stops syncing.</span></span>
              </label>
            </fieldset>
          </>
        )}
      </div>
    </section>
  );
}

/**
 * The daemon's own options, read from its --help by node-admin, edited here and applied on
 * a node restart. Changes are checked by the daemon's parser before they take effect, and put
 * back automatically if the node does not stay up with them.
 * @param {{ token: string, onUnauthorized: () => void, node?: string }} props
 */
export default function DaemonSettings({ token, onUnauthorized, node = "daemon" }) {
  const q = nodeQuery(node);
  const [data, setData] = useState(/** @type {any} */ (null));
  const [draft, setDraft] = useState(/** @type {Record<string, string | true>} */ ({}));
  const [query, setQuery] = useState("");
  const [changedOnly, setChangedOnly] = useState(false);
  const [expanded, setExpanded] = useState(/** @type {string | null} */ (null));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(/** @type {string | null} */ (null));
  const [waiting, setWaiting] = useState(false);

  const load = useCallback(async () => {
    const response = await fetch(`/api/v1/node/settings${q}`);
    if (!response.ok) return;
    const next = await response.json();
    setData((previous) => {
      // Reset the draft when the saved state changes (first load, save, or the node applied it).
      const saved = next.pending ?? next.current;
      const before = previous ? previous.pending ?? previous.current : null;
      if (!before || !sameValues(saved, before)) setDraft({ ...saved });
      return next;
    });
  }, [q]);

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
      const headers = { "x-admin-token": token, "content-type": "application/json" };
      const response = await fetch(`/api/v1/node/settings${q}`, { method: "PUT", headers, body: JSON.stringify({ values: draft }) });
      const body = await response.json().catch(() => ({}));
      if (response.status === 401) onUnauthorized();
      if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
      if (apply && body.pending) {
        const applied = await fetch(`/api/v1/node/settings/apply${q}`, { method: "POST", headers });
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
      await fetch(`/api/v1/node/settings/discard${q}`, { method: "POST", headers: { "x-admin-token": token } });
      await load();
    }
    setDraft({ ...current });
  }

  if (!data) return null;
  if (!data.available) {
    return (
      <Card title="Node settings">
        <p className="text-sm text-ink-2">The node has not reported its settings yet. They appear once it has started.</p>
      </Card>
    );
  }

  const r = data.lastResult;
  const bySchema = new Map(data.schema.map((/** @type {any} */ s) => [s.flag, s]));
  const syncConflict = draft["allow-fast-sync"] === true && draft["allow-boost-sync"] === true;
  return (
    <Card title="Node settings"
      subtitle="Settings of your XELIS node. Changes apply when you save and the node restarts, which takes a few seconds.">
      <div className="space-y-5">
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

        <TrustedPeers draft={draft} set={set} locked={locked} />

        {GUIDE.map((section) => {
          const entries = section.entries.filter((e) => bySchema.has(e.flag));
          if (entries.length === 0) return null;
          return (
            <section key={section.title} className="space-y-2">
              <div>
                <h3 className="text-sm font-semibold text-ink">{section.title}</h3>
                <p className="text-xs text-ink-2">{section.intro}</p>
              </div>
              <ul className="divide-y divide-line rounded-md border border-line">
                {entries.map((e) => {
                  const s = bySchema.get(e.flag);
                  const conflict = syncConflict && (e.flag === "allow-fast-sync" || e.flag === "allow-boost-sync");
                  return (
                    <li key={e.flag} className="grid gap-2 px-3 py-3 sm:grid-cols-[1fr_16rem] sm:items-start">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-sm font-medium text-ink">{e.title}</span>
                          {e.flag in draft && <span className="rounded bg-wash px-1.5 py-0.5 text-xs text-ink-2">Changed</span>}
                          {s.caution && <span className="text-xs text-serious" title="Changes how the node stores or checks the chain">⚠ Use with care</span>}
                        </div>
                        <p className="mt-0.5 text-sm text-ink-2">{e.explain}</p>
                        {e.tip && <p className="mt-1 text-xs text-muted">{e.tip}</p>}
                        {conflict && <p className="mt-1 text-xs text-critical">Boost sync and fast sync cannot be on together; turn one off.</p>}
                        <p className="mt-1 text-xs text-muted"><code>--{e.flag}</code>{s.default ? ` · default ${s.default}` : ""}</p>
                      </div>
                      <Control s={s} value={draft[e.flag]} locked={locked} placeholder={e.placeholder} set={set} />
                    </li>
                  );
                })}
              </ul>
            </section>
          );
        })}

        <details open={Boolean(query) || changedOnly} className="rounded-md border border-line">
          <summary className="min-h-6 cursor-pointer select-none px-3 py-2 text-sm font-semibold text-ink">
            All daemon options <span className="font-normal text-muted">· {data.schema.length} from the installed daemon{changedFromDefault ? ` · ${changedFromDefault} changed` : ""}</span>
          </summary>
          <div className="space-y-3 border-t border-line p-3">
            <p className="text-xs text-ink-2">
              Every option of the installed XELIS daemon, with the daemon's own description. Most setups never need these.
            </p>
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
              <details key={group} open={Boolean(query) || changedOnly} className="rounded-md border border-line">
                <summary className="min-h-6 cursor-pointer select-none px-3 py-2 text-sm font-semibold text-ink">
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
                          {s.note && <p className="mt-0.5 text-xs text-serious">{s.note}</p>}
                          {rest.length > 0 && (
                            <button type="button" onClick={() => setExpanded(open ? null : s.flag)} className="inline-flex min-h-6 items-center text-xs text-muted underline decoration-line underline-offset-2">
                              {open ? "Less" : "More"}
                            </button>
                          )}
                          {open && <p className="mt-1 whitespace-pre-line text-xs text-ink-2">{rest.join("\n\n")}</p>}
                        </div>
                        <Control s={s} value={value} locked={locked} set={set} />
                      </li>
                    );
                  })}
                </ul>
              </details>
            ))}
            <p className="text-xs text-muted">
              Set by xelDash and not editable here: {data.locked.map((/** @type {string} */ f) => `--${f}`).join(", ")}.
            </p>
          </div>
        </details>

        {error && <p className="text-sm text-critical">{error}</p>}
        {!locked && (dirty || data.pending) && (
          <div className="sticky bottom-3 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-line bg-surface p-3 shadow-sm">
            <span className="text-sm text-ink-2">
              {syncConflict ? "Turn off boost sync or fast sync first." : dirty ? "Unsaved changes." : "Saved; applies on the next restart."} The node restarts to apply them; with a second node or the official node fallback, mining continues meanwhile.
            </span>
            <span className="flex gap-2">
              <button type="button" disabled={busy} onClick={() => void discard()}
                className="rounded-md border border-line px-3 py-1.5 text-sm text-ink hover:bg-wash disabled:opacity-40">Discard</button>
              <button type="button" disabled={busy || syncConflict} onClick={() => void save(true)}
                className="rounded-md bg-action px-3 py-1.5 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-40">
                Save and restart node
              </button>
            </span>
          </div>
        )}
      </div>
    </Card>
  );
}
