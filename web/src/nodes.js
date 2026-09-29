import { useEffect, useState } from "react";

/**
 * @typedef {{ id: string, present: boolean, state: "running" | "stopping" | "stopped", dataPresent: boolean, staged: boolean, phase: string, previousBytes: number,
 *   binary: string, pending: string | null, installed: string[], lastResult: { at: string, outcome: string, message: string | null } | null,
 *   running: { version: string, topoheight: number, peers: number, synced: boolean } | null }} ManagedNode
 */

/**
 * The nodes node-admin manages (daemon, and daemon2 once it has run), refreshed every few
 * seconds so stop and start show up quickly.
 */
export function useNodes() {
  const [state, setState] = useState(/** @type {{ nodes: ManagedNode[], actionsEnabled: boolean, upgrade: any } | null} */ (null));
  useEffect(() => {
    let cancelled = false;
    const load = () => {
      fetch("/api/v1/node/nodes")
        .then((response) => (response.ok ? response.json() : null))
        .then((body) => {
          if (!cancelled && body) setState(body);
        })
        .catch(() => {});
    };
    load();
    const timer = setInterval(load, 5_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);
  return state;
}

/** Query string that points a node-admin request at one node. @param {string} node */
export function nodeQuery(node) {
  return `?node=${encodeURIComponent(node)}`;
}
