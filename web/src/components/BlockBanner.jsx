import { useEffect, useState } from "react";
import { subscribeBlockFound } from "../live.js";
import { blockSoundEnabled, playBlockSound } from "../block-sound.js";
import { useCoin } from "../coin.js";
import { useBlockUrl } from "../explorer.js";
import { formatEffort, formatInteger, formatXel } from "../format.js";
import { useOperatorView } from "../server-mode.js";
import { watchUnseenBlocks } from "../tab-title.js";

// Long enough to be seen by someone who looks back at the page later; it goes when closed, or when a newer block replaces it.
const SHOW_MS = 60 * 60_000;

/** @typedef {{ hash: string, height: string, worker: string | null, reward: string | null, effort: number | null }} FoundBlock */

/**
 * "Block found!" card at the top of every page, shown when a block is found while the dashboard is open, with the block sound if
 * it is on and the tab title marked while the tab is out of view. Height, reward (known once the block is final) and the round's
 * effort, and a way to the block. The block comes from the API, since the live message only says that something happened.
 */
export default function BlockBanner() {
  const [block, setBlock] = useState(/** @type {FoundBlock | null} */ (null));
  const blockUrl = useBlockUrl();
  const coin = useCoin();
  const operator = useOperatorView();

  useEffect(() => {
    const title = watchUnseenBlocks();
    const unsubscribe = subscribeBlockFound(() => {
      fetch("/api/v1/blocks?limit=1")
        .then((response) => (response.ok ? response.json() : null))
        .then((body) => {
          const latest = body?.blocks?.[0];
          if (!latest) return;
          setBlock({ hash: latest.hash, height: latest.height, worker: latest.worker, reward: latest.reward ?? null, effort: latest.effort ?? null });
          title.blockFound();
          if (blockSoundEnabled()) void playBlockSound();
        })
        .catch(() => {});
    });
    return () => {
      unsubscribe();
      title.stop();
    };
  }, []);

  useEffect(() => {
    if (!block) return undefined;
    const timer = setTimeout(() => setBlock(null), SHOW_MS);
    return () => clearTimeout(timer);
  }, [block]);

  if (!block) return null;
  const url = blockUrl(block.hash);
  return (
    <div role="status" className="block-banner card pad flex flex-wrap items-center gap-x-8 gap-y-4">
      <div className="flex min-w-0 flex-1 basis-64 items-center gap-4">
        <span className="grid h-12 w-12 shrink-0 place-items-center rounded-xl bg-accent-soft" aria-hidden="true">
          <svg width="22" height="22" viewBox="0 0 24 24">
            <path d="M12 2l8.5 5v10L12 22l-8.5-5V7zM3.5 7L12 12l8.5-5M12 12v10" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinejoin="round" />
          </svg>
        </span>
        <div className="min-w-0">
          <div className="text-lg font-semibold text-ink">Block found!</div>
          <div className="label">
            {block.worker ? `by ${block.worker} · ` : ""}{operator ? "paid straight to the finder's address" : "on this server, paid to the finder's address"}
          </div>
        </div>
      </div>
      <dl className="m-0 flex flex-wrap gap-x-8 gap-y-2">
        <div><dt className="label">Height</dt><dd className="mono m-0 text-base font-medium text-ink">{formatInteger(block.height)}</dd></div>
        <div>
          <dt className="label">Reward</dt>
          <dd className="mono m-0 text-base font-medium text-ink" title="Known once the block is final">{block.reward ? formatXel(block.reward, coin) : "when final"}</dd>
        </div>
        <div><dt className="label">Effort</dt><dd className="mono m-0 text-base font-medium text-ink">{block.effort === null ? "—" : formatEffort(block.effort)}</dd></div>
      </dl>
      <div className="flex items-center gap-2">
        {url
          ? <a href={url} target="_blank" rel="noopener noreferrer" className="btn btn-primary">View block</a>
          : <a href="#/blocks" className="btn btn-primary">View block</a>}
        <button type="button" onClick={() => setBlock(null)} aria-label="Dismiss" className="btn">×</button>
      </div>
      <p className="label m-0 basis-full">It is final once the network has settled; the Blocks page shows its reward.</p>
    </div>
  );
}
