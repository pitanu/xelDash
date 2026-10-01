import { useEffect, useState } from "react";
import { subscribeBlockFound } from "../live.js";
import { blockSoundEnabled, playChime } from "../block-sound.js";
import { useBlockUrl } from "../explorer.js";
import { formatInteger } from "../format.js";

const SHOW_MS = 12_000;

/**
 * "Block found" notice at the top of every page, shown when one of your miners finds a block
 * while the dashboard is open, with the chime if it is on. The block comes from the API, since
 * the live message only says that something happened.
 */
export default function BlockBanner() {
  const [block, setBlock] = useState(/** @type {{ hash: string, height: string, worker: string | null } | null} */ (null));
  const blockUrl = useBlockUrl();

  useEffect(() => subscribeBlockFound(() => {
    fetch("/api/v1/blocks?limit=1")
      .then((response) => (response.ok ? response.json() : null))
      .then((body) => {
        const latest = body?.blocks?.[0];
        if (!latest) return;
        setBlock({ hash: latest.hash, height: latest.height, worker: latest.worker });
        if (blockSoundEnabled()) void playChime();
      })
      .catch(() => {});
  }), []);

  useEffect(() => {
    if (!block) return undefined;
    const timer = setTimeout(() => setBlock(null), SHOW_MS);
    return () => clearTimeout(timer);
  }, [block]);

  if (!block) return null;
  const url = blockUrl(block.hash);
  return (
    <div role="status" className="block-banner border-b border-line bg-linear-to-r from-good/15 via-surface to-surface">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-2 text-sm text-ink sm:px-6">
        <span>
          <span aria-hidden="true">⛏️ </span>
          <strong>Block found</strong>
          {block.height && <> at height {url
            ? <a href={url} target="_blank" rel="noopener noreferrer" className="underline decoration-line underline-offset-2">{formatInteger(block.height)}</a>
            : formatInteger(block.height)}</>}
          {block.worker && <> by {block.worker}</>}
          <span className="text-ink-2">. It is final once the network has settled; the Blocks page shows its reward.</span>
        </span>
        <button type="button" onClick={() => setBlock(null)} aria-label="Dismiss"
          className="shrink-0 rounded p-1 text-ink-2 hover:bg-wash hover:text-ink">×</button>
      </div>
    </div>
  );
}
