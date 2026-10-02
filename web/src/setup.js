import { useEffect, useRef, useState } from "react";
import { usePolled } from "./api.js";
import { formatBytes, formatInteger } from "./format.js";

/**
 * Time left for something that is counting down (bytes to download, blocks to catch up),
 * estimated from how fast it fell over the last few minutes. Null until there is enough to go on.
 * @param {number | null} remaining @param {unknown} stamp changes with every fresh reading
 */
function useEta(remaining, stamp) {
  const samples = useRef(/** @type {{ t: number, v: number }[]} */ ([]));
  const [eta, setEta] = useState(/** @type {number | null} */ (null));
  useEffect(() => {
    if (remaining === null) {
      samples.current = [];
      setEta(null);
      return;
    }
    const now = Date.now();
    const list = [...samples.current, { t: now, v: remaining }].filter((x) => now - x.t < 180_000);
    samples.current = list;
    const first = list[0];
    const last = list[list.length - 1];
    const seconds = (last.t - first.t) / 1000;
    if (seconds >= 20 && first.v > last.v) setEta(last.v / ((first.v - last.v) / seconds));
    else if (seconds >= 20) setEta(null);
  }, [remaining, stamp]);
  return eta;
}

/**
 * @typedef {{ id: string, title: string, why: string, state: "done" | "working" | "todo", headline: string,
 *   detail: string | null, progress: number | null, etaSeconds: number | null }} SetupStep
 */

/**
 * The four steps to a working setup, worked out from what xelDash already knows: the node's
 * state, the snapshot download, the saved address, and the miners that have connected.
 * @param {{ intervalMs?: number }} [options]
 */
export function useSetup({ intervalMs = 5_000 } = {}) {
  const status = usePolled("/api/v1/status", { intervalMs });
  const miners = usePolled("/api/v1/miners", { intervalMs });
  const snapshot = usePolled("/api/v1/node/snapshot/status", { intervalMs });
  const connect = usePolled("/api/v1/connect", { intervalMs: 30_000 });

  const s = status.data;
  const node = s?.node ?? null;
  const snap = snapshot.data;
  const snapPhase = snap?.state?.phase;
  const snapshotBusy = Boolean(snap && (snap.bootstrapping || ["downloading", "verifying", "extracting", "copying"].includes(snapPhase)));
  const snapTotal = snap?.state?.total ?? null;
  const behind = node?.syncing && node.networkTopoheight ? Math.max(0, node.networkTopoheight - node.topoheight) : null;
  const snapRemaining = snapshotBusy && snapTotal ? Math.max(0, snapTotal - (snap.state.bytes ?? 0)) : null;
  const remaining = snapRemaining ?? behind;
  const eta = useEta(remaining, snapRemaining !== null ? snapshot.data : status.data);

  const networkReady = Boolean(s?.services.stratum.ok && !s.services.stratum.paused && node);
  /** @type {SetupStep} */
  const network = {
    id: "network",
    title: "Connect to the XELIS network",
    why: "xelDash runs its own XELIS node for you. The first time, it has to download and check the blockchain. That happens by itself; you can leave this page.",
    state: networkReady ? "done" : "working",
    headline: "Starting up",
    detail: null,
    progress: null,
    etaSeconds: null,
  };
  if (networkReady) {
    network.headline = "Connected to the XELIS network";
    network.detail = s?.node && s.node.network !== "mainnet"
      ? `Running on the ${s.node.network} test network.`
      : `Block ${formatInteger(node.height)}, ${node.peers ?? 0} other nodes connected.`;
  } else if (snapshotBusy) {
    const phase = snapPhase === "verifying" ? "Checking the download" : snapPhase === "extracting" ? "Unpacking the snapshot (a few minutes)"
      : "Downloading a snapshot of the blockchain, so you do not have to wait days to sync";
    network.headline = phase;
    if (snapPhase === "downloading" && snapTotal) {
      network.detail = `${formatBytes(snap.state.bytes)} of ${formatBytes(snapTotal)}`;
      network.progress = snap.state.bytes / snapTotal;
    } else if (snapPhase === "downloading") {
      network.detail = `${formatBytes(snap.state.bytes)} so far`;
    }
    network.etaSeconds = eta;
  } else if (!s) {
    network.headline = "Waiting for xelDash to answer";
  } else if (!node) {
    network.headline = "The XELIS node is starting";
    network.detail = "This takes a minute or two.";
  } else if (node.syncing) {
    network.headline = "Catching up with the network";
    const percent = node.networkTopoheight ? node.topoheight / node.networkTopoheight : null;
    network.detail = `${formatInteger(behind)} blocks behind${percent !== null && percent < 0.99 ? ` (${Math.floor(percent * 100)}% done)` : ""}.`;
    if (percent !== null && percent < 0.99) network.progress = percent;
    network.etaSeconds = eta;
  } else if (node.peers === 0) {
    network.headline = "Looking for other XELIS nodes to connect to";
    network.detail = "If this takes more than a few minutes, check your internet connection.";
  } else {
    network.headline = "Getting ready to accept miners";
  }

  const address = connect.data?.address ?? null;
  /** @type {SetupStep} */
  const addressStep = {
    id: "address",
    title: "Choose where your rewards go",
    why: "Every block you find is paid straight to your XELIS wallet address. xelDash never holds your coins, and only ever needs the address.",
    state: address ? "done" : "todo",
    headline: address ? "Rewards go to your address" : "Add your wallet address",
    detail: address,
    progress: null,
    etaSeconds: null,
  };

  const minerList = miners.data?.miners ?? [];
  const everConnected = minerList.length > 0;
  const accepted = minerList.reduce((sum, m) => sum + Number(m.accepted1h), 0);
  /** @type {SetupStep} */
  const minerStep = {
    id: "miner",
    title: "Connect a miner",
    why: "A miner is the program that uses your graphics card or processor to do the mining. Point it at xelDash with the settings below.",
    state: everConnected ? "done" : networkReady ? "working" : "todo",
    headline: everConnected ? "A miner has connected" : networkReady ? "Waiting for your first miner" : "Ready once the network is connected",
    detail: everConnected ? `${minerList.length === 1 ? "1 address is" : `${minerList.length} addresses are`} mining here.` : null,
    progress: null,
    etaSeconds: null,
  };
  /** @type {SetupStep} */
  const shareStep = {
    id: "share",
    title: "Watch your first share arrive",
    why: "Shares are small proofs of work your miner sends. When one is accepted, you know everything works. Blocks are found rarely; shares show it is working.",
    state: accepted > 0 ? "done" : everConnected ? "working" : "todo",
    headline: accepted > 0 ? "Shares are being accepted" : everConnected ? "Waiting for the first share (a minute or two)" : "Comes after a miner connects",
    detail: accepted > 0 ? `${formatInteger(accepted)} accepted in the last hour.` : null,
    progress: null,
    etaSeconds: null,
  };

  const steps = [network, addressStep, minerStep, shareStep];
  const loaded = Boolean(status.data || status.error) && Boolean(miners.data || miners.error);
  // The miner list comes from the database: while it cannot be read, "no miner yet" would be a guess.
  const unavailable = Boolean(miners.error && !miners.data);
  return {
    steps,
    done: steps.filter((step) => step.state === "done").length,
    // Set up once the node works and a miner has connected; the address is recommended, not required.
    complete: networkReady && everConnected,
    loaded,
    unavailable,
    connect: connect.data,
    reloadConnect: connect.reload,
    networkReady,
  };
}
