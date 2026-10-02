// Plain-language guide to the daemon options most setups need, shown first on the Settings
// page. An option appears only if the installed daemon has it; everything else stays under
// "All daemon options" with the daemon's own description.

/**
 * @typedef {{ flag: string, title: string, explain: string, tip?: string, placeholder?: string }} GuideEntry
 * @typedef {{ title: string, intro: string, entries: GuideEntry[] }} GuideSection
 */

/** @type {GuideSection[]} */
export const GUIDE = [
  {
    title: "Syncing",
    intro: "How the node catches up with the network after it has been off or behind.",
    entries: [
      {
        flag: "allow-boost-sync",
        title: "Boost sync",
        explain: "Downloads missing blocks from several peers at once instead of one after another, so the node catches up much faster after downtime.",
        tip: "Recommended for mining. Uses more bandwidth while catching up. Cannot be on together with fast sync.",
      },
      {
        flag: "allow-fast-sync",
        title: "Fast sync",
        explain: "When the node is very far behind, it downloads the current state of the chain instead of replaying every block. The skipped history is not checked by your node.",
        tip: "Rarely needed: a snapshot from the Nodes page does the same job. Only with peers you trust. Cannot be on together with boost sync.",
      },
    ],
  },
  {
    title: "Peers",
    intro: "Which other XELIS nodes your node talks to. More good peers means your blocks reach the network sooner.",
    entries: [
      {
        flag: "p2p-sync-from-priority-only",
        title: "Sync only from trusted peers",
        explain: "Download the chain only from your trusted peers (above), while other peers can still connect and receive your blocks.",
        tip: "Needs at least one trusted peer in Priority mode that is online.",
      },
      {
        flag: "max-peers",
        title: "Maximum peers",
        explain: "How many other nodes yours stays connected to at once. More peers spread the blocks you find faster, at the cost of more bandwidth.",
        tip: "The default suits most home connections.",
      },
      {
        flag: "tag",
        title: "Node name",
        explain: "A short label other nodes see for yours. Leave it empty to stay anonymous.",
        placeholder: "Not set",
      },
      {
        flag: "disable-ip-sharing",
        title: "Keep my IP address private",
        explain: "Asks the peers you connect to not to pass your IP address on to other nodes.",
        tip: "Fewer nodes will find and connect to yours.",
      },
    ],
  },
  {
    title: "Disk and logs",
    intro: "How much the node keeps on disk.",
    entries: [
      {
        flag: "auto-prune-keep-n-blocks",
        title: "Prune old blocks",
        explain: "Deletes old blocks as new ones arrive, keeping only this many below the tip, to save disk space: on mainnet about 4 GB of the node's 10 GB, however many you keep. Empty keeps the full history.",
        tip: "Keep at least 17,280 blocks (about a day). It prunes when the chain height reaches a multiple of this number, which can take hours, and the space only comes back after the node is restarted once more. Mining works as normal, but a pruned node cannot help other nodes sync old blocks, and pruning cannot be undone without a new snapshot.",
        placeholder: "Keep everything",
      },
      {
        flag: "log-level",
        title: "Log detail",
        explain: "How much the node writes to its log (docker compose logs daemon). \"debug\" and \"trace\" help when something is wrong, but produce a lot of output.",
      },
    ],
  },
];

/** Flags covered by the guide, including the trusted-peer editor. */
export const GUIDED_FLAGS = new Set([
  "priority-nodes",
  "exclusive-nodes",
  ...GUIDE.flatMap((section) => section.entries.map((entry) => entry.flag)),
]);
