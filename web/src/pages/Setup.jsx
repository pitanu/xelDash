import { useEffect, useState } from "react";
import { AdminUnlock, useAdminToken } from "../components/AdminUnlock.jsx";
import CopyButton from "../components/CopyButton.jsx";
import ProblemsCard from "../components/ProblemsCard.jsx";
import { Card, Segmented } from "../components/ui.jsx";
import { formatDuration, shorten } from "../format.js";
import { useSetup } from "../setup.js";

const WALLET_URL = "https://wallet.xelis.io";

/** Numbered circle that becomes a check when its step is done. @param {{ n: number, state: "done" | "working" | "todo" }} props */
function Marker({ n, state }) {
  if (state === "done") {
    return (
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-good/15 text-good" aria-label="Done">
        <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M3 8.5l3 3 7-7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
    );
  }
  return (
    <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full border text-xs font-semibold ${state === "working" ? "border-series-1 text-series-1" : "border-line text-muted"}`}
      aria-label={state === "working" ? "In progress" : "Not started"}>
      {state === "working" ? <span className="h-3 w-3 animate-spin rounded-full border-2 border-series-1/30 border-t-series-1" /> : n}
    </span>
  );
}

/** @param {{ value: number }} props */
function Bar({ value }) {
  const pct = Math.max(0, Math.min(100, value * 100));
  return (
    <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-series-1/15" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)}>
      <div className="h-full rounded-full bg-series-1 transition-[width]" style={{ width: `${pct}%` }} />
    </div>
  );
}

/** @param {{ step: import("../setup.js").SetupStep, n: number, children?: React.ReactNode }} props */
function Step({ step, n, children }) {
  return (
    <li className={`rounded-lg border p-4 sm:p-5 ${step.state === "working" ? "border-series-1/40 bg-surface" : "border-line bg-surface"}`}>
      <div className="flex gap-3">
        <Marker n={n} state={step.state} />
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold text-ink">{step.title}</h2>
          <p className="mt-0.5 text-xs text-ink-2">{step.why}</p>
          <div className="mt-3 text-sm">
            <div className="font-medium text-ink">{step.headline}</div>
            {step.detail && step.id !== "address" && <div className="mt-0.5 text-ink-2">{step.detail}</div>}
            {step.progress !== null && <Bar value={step.progress} />}
            {step.etaSeconds !== null && <div className="mt-1 text-xs text-muted">About {formatDuration(step.etaSeconds)} left</div>}
          </div>
          {children}
        </div>
      </div>
    </li>
  );
}

/** Pasting the wallet address, checked by the node before it is saved. @param {{ current: string | null, network: string, onSaved: () => void }} props */
function AddressForm({ current, network, onSaved }) {
  const admin = useAdminToken();
  const [info, setInfo] = useState(/** @type {{ actionsEnabled: boolean, prefix: string } | null} */ (null));
  const [value, setValue] = useState("");
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(/** @type {string | null} */ (null));

  useEffect(() => {
    fetch("/api/v1/node/mining-address").then((r) => (r.ok ? r.json() : null)).then(setInfo).catch(() => {});
  }, []);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/v1/node/mining-address", {
        method: "PUT",
        headers: { "x-admin-token": admin.token, "content-type": "application/json" },
        body: JSON.stringify({ address: value }),
      });
      const body = await response.json().catch(() => ({}));
      if (response.status === 401) admin.forget();
      if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
      setEditing(false);
      setValue("");
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const prefix = info?.prefix ?? (network === "mainnet" ? "xel" : "xet");
  if (current && !editing) {
    return (
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <code className="min-w-0 break-all rounded bg-wash px-2 py-1 text-xs text-ink" title={current}>{current}</code>
        <CopyButton text={current} />
        <button type="button" onClick={() => setEditing(true)} className="inline-flex min-h-6 items-center text-xs text-ink-2 underline decoration-line underline-offset-2 hover:text-ink">Change</button>
      </div>
    );
  }
  return (
    <div className="mt-3 space-y-3">
      {info && !admin.token && <AdminUnlock actionsEnabled={info.actionsEnabled} admin={admin} />}
      <form className="flex flex-wrap gap-2" onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <input type="text" value={value} onChange={(e) => setValue(e.target.value)} autoComplete="off" spellCheck={false}
          placeholder={`${prefix}:...`} aria-label="Your XELIS address" disabled={!admin.token}
          className="min-w-0 flex-1 rounded-md border border-line bg-page px-3 py-1.5 font-mono text-sm text-ink disabled:opacity-50" />
        <button type="submit" disabled={!admin.token || !value.trim() || busy}
          className="rounded-md bg-action px-3 py-1.5 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-40">
          {busy ? "Checking..." : "Save address"}
        </button>
        {current && <button type="button" onClick={() => { setEditing(false); setError(null); }} className="text-sm text-ink-2 underline decoration-line underline-offset-2 hover:text-ink">Cancel</button>}
      </form>
      {error && <p role="alert" className="text-sm text-critical">{error}</p>}
      <div className="rounded-md bg-wash p-3 text-xs text-ink-2">
        <p className="font-medium text-ink">Do not have a wallet yet?</p>
        <p className="mt-1">
          Create a free one with the official XELIS web wallet at{" "}
          <a href={WALLET_URL} target="_blank" rel="noopener noreferrer" className="text-ink underline decoration-line underline-offset-2">wallet.xelis.io</a>.
          Write down its recovery phrase somewhere safe and never share it: anyone who has it can take your coins.
          Then copy your address (it starts with <code>{prefix}:</code>) and paste it above.
        </p>
        <p className="mt-1">xelDash only needs the address. It never asks for your recovery phrase or password, and neither should anyone else.</p>
        {network !== "mainnet" && <p className="mt-1">This is the {network} test network: use a test-network address, which starts with <code>xet:</code>.</p>}
      </div>
    </div>
  );
}

/** One label and value with a copy button. @param {{ label: string, value: string, hint?: string }} props */
function Field({ label, value, hint }) {
  return (
    <div className="grid gap-1 sm:grid-cols-[9rem_1fr] sm:items-center">
      <div className="text-xs text-ink-2">{label}{hint && <span className="block text-muted">{hint}</span>}</div>
      <div className="flex min-w-0 items-center gap-2">
        <code className="min-w-0 flex-1 break-all rounded bg-wash px-2 py-1 text-xs text-ink">{value}</code>
        <CopyButton text={value} />
      </div>
    </div>
  );
}

/** What to type into a mining program. @param {{ info: any }} props */
function ConnectPanel({ info }) {
  const [miner, setMiner] = useState("rigel");
  if (!info) return null;
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(window.location.hostname);
  const host = info.host ?? window.location.hostname;
  const address = info.address ?? (info.network === "mainnet" ? "xel:YOUR_ADDRESS" : "xet:YOUR_ADDRESS");
  const stratum = `stratum+tcp://${host}:${info.stratumPort}`;
  const getwork = info.getworkPort ? `ws://${host}:${info.getworkPort}` : null;
  const rigel = `rigel -a xelishashv3 -o ${stratum} -u ${address} -w rig1`;
  const xelisMiner = getwork ? `xelis_miner --daemon-address ${getwork} --miner-address ${address} --worker rig1` : null;

  return (
    <Card title="Connect a miner" subtitle="The settings for your mining program. Use a different worker name (rig1, rig2, ...) for each computer.">
      <div className="space-y-4">
        {!info.reachableFromNetwork && (
          <div className="rounded-md border border-line bg-wash p-3 text-xs text-ink-2">
            <p className="font-medium text-ink">Right now only this computer can connect.</p>
            <p className="mt-1">
              To mine from other computers on your home network, allow it once by running <code>xeldash lan on</code>{" "}
              (or <code>./xeldash.sh lan on</code> on Linux and macOS) in the xelDash folder. Never open these ports to the internet.
            </p>
          </div>
        )}
        {local && !info.host && (
          <p className="text-xs text-ink-2">
            You opened the dashboard on this computer, so <code>localhost</code> below works for miners here. For a miner on another
            computer, replace it with this computer's address on your network (something like <code>192.168.1.20</code>).
          </p>
        )}
        <div className="space-y-2">
          <Field label="Pool address" value={stratum} hint="also called URL or server" />
          <Field label="Your address" value={address} hint="also called wallet or user" />
          <Field label="Worker name" value="rig1" hint="any name, one per computer" />
          <Field label="Password" value="x" hint="anything; not used" />
          <Field label="Algorithm" value="xelishashv3" hint="XelisHash v3" />
        </div>
        <div>
          <Segmented label="Mining program" value={miner} onChange={setMiner}
            options={[["rigel", "Rigel"], ["xelis_miner", "xelis_miner"], ["other", "Other"]]} />
          <div className="mt-3 space-y-2 text-sm text-ink-2">
            {miner === "rigel" && (
              <>
                <p>
                  <a href="https://github.com/rigelminer/rigel/releases" target="_blank" rel="noopener noreferrer" className="text-ink underline decoration-line underline-offset-2">Rigel</a>{" "}
                  is a miner for NVIDIA graphics cards, and the one we tested most. Open a command window in its folder and run:
                </p>
                <div className="flex items-start gap-2"><code className="min-w-0 flex-1 break-all rounded bg-wash px-2 py-1 text-xs text-ink">{rigel}</code><CopyButton text={rigel} /></div>
                <p className="text-xs text-muted">On Windows, use <code>rigel.exe</code>.</p>
              </>
            )}
            {miner === "xelis_miner" && (
              <>
                <p>
                  <a href="https://github.com/xelis-project/xelis-blockchain/releases" target="_blank" rel="noopener noreferrer" className="text-ink underline decoration-line underline-offset-2">xelis_miner</a>{" "}
                  is the XELIS team's own miner (it also works on a processor). Download a release, open a command window in its folder and run:
                </p>
                {xelisMiner
                  ? <div className="flex items-start gap-2"><code className="min-w-0 flex-1 break-all rounded bg-wash px-2 py-1 text-xs text-ink">{xelisMiner}</code><CopyButton text={xelisMiner} /></div>
                  : <p className="text-xs text-muted">Getwork is switched off on this server (GETWORK_ENABLED).</p>}
              </>
            )}
            {miner === "other" && (
              <p>
                Any miner that supports XELIS (algorithm <code>xelishashv3</code>) and the Stratum protocol should work: enter the pool address, your address
                as the user (or <code>{address}.rig1</code> if it only has one user field) and any password. Rigel and xelis_miner are the ones tested so far.
                {info.tlsPort && <> A secure connection is also available: <code>stratum+ssl://{host}:{info.tlsPort}</code>.</>}
              </p>
            )}
          </div>
        </div>
        <details className="text-sm text-ink-2">
          <summary className="min-h-6 cursor-pointer select-none py-1 font-medium text-ink">It does not connect. What now?</summary>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-xs">
            <li>Check the pool address and port exactly as shown above, and that step 1 is done (a green check).</li>
            <li>On another computer, use this computer's network address instead of <code>localhost</code>, and allow network access (see above).</li>
            <li>Check the address starts with <code>{info.network === "mainnet" ? "xel:" : "xet:"}</code> and was pasted completely.</li>
            <li>A firewall on this computer may block the port: allow port {info.stratumPort} for private networks.</li>
            <li>The Health page shows whether the node and mining server are running, and any computer that was blocked for sending bad data.</li>
          </ul>
        </details>
      </div>
    </Card>
  );
}

const WORDS = [
  ["Node", "The program that keeps a copy of the XELIS blockchain and talks to the rest of the network. xelDash runs one for you."],
  ["Miner", "The program on your graphics card or processor that does the mining work."],
  ["Share", "A small proof of work your miner sends often. It shows your miner is working, and it is how xelDash measures your hashrate."],
  ["Block", "What you are really after. Finding one pays the block reward straight to your address. Solo mining finds blocks rarely, at random."],
  ["Hashrate", "How fast your miner works, in hashes per second. More is better."],
];

/** Everything from an empty install to the first share, with what to do at each step. */
export default function Setup() {
  const setup = useSetup({ intervalMs: 4_000 });
  const [network, address, minerStep, shareStep] = setup.steps;
  const info = setup.connect;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-lg font-semibold text-ink">{setup.complete ? "Setup" : "Get started"}</h1>
        <p className="text-sm text-ink-2">
          {setup.complete
            ? "xelDash is set up and a miner is connected. This page stays here if you need the connection settings again."
            : "Four short steps to start mining. You can leave this page open, or come back at any time."}
        </p>
        <div className="mt-3 flex items-center gap-3 text-xs text-ink-2">
          <div className="h-2 w-40 overflow-hidden rounded-full bg-series-1/15" role="progressbar" aria-valuemin={0} aria-valuemax={4} aria-valuenow={setup.done}>
            <div className="h-full rounded-full bg-series-1 transition-[width]" style={{ width: `${(setup.done / 4) * 100}%` }} />
          </div>
          {setup.done} of 4 done
        </div>
      </div>

      <ol className="space-y-4">
        <Step step={network} n={1} />
        <Step step={address} n={2}><AddressForm current={info?.address ?? null} network={info?.network ?? "mainnet"} onSaved={setup.reloadConnect} /></Step>
        <Step step={minerStep} n={3} />
        <Step step={shareStep} n={4} />
      </ol>

      <ProblemsCard network={info?.network ?? "mainnet"} />

      <ConnectPanel info={info ? { ...info, address: info.address } : null} />

      <Card title="Words you will see">
        <dl className="divide-y divide-line text-sm">
          {WORDS.map(([term, text]) => (
            <div key={term} className="grid gap-1 py-2 sm:grid-cols-[7rem_1fr]">
              <dt className="font-medium text-ink">{term}</dt>
              <dd className="text-ink-2">{text}</dd>
            </div>
          ))}
        </dl>
      </Card>

      {info?.address && <p className="text-xs text-muted">Mining to <span title={info.address}>{shorten(info.address, 10)}</span>. <a href="#/" className="underline decoration-line underline-offset-2 hover:text-ink">Go to the dashboard</a></p>}
    </div>
  );
}
