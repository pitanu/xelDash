import { useState } from "react";
import { SUPPORT_ADDRESS, dismissSupport, supportApplies, supportDismissed } from "../support.js";
import CopyButton from "./CopyButton.jsx";
import { Card } from "./ui.jsx";

const REPO = "https://github.com/pitanu/xelDash";

function AddressRow() {
  return (
    <div className="flex items-center gap-2">
      <code className="min-w-0 flex-1 break-all rounded bg-wash px-2 py-1.5 font-mono text-xs text-ink">{SUPPORT_ADDRESS}</code>
      <CopyButton text={SUPPORT_ADDRESS} label="Copy" />
    </div>
  );
}

/**
 * The always-there version, on the Settings page: where to send a thank-you if xelDash is useful. Mainnet only.
 * @param {{ network: string | null | undefined }} props
 */
export default function SupportCard({ network }) {
  if (!supportApplies(network)) return null;
  return (
    <Card title="Support xelDash" subtitle="Free and open source, with no fees and no ads.">
      <p className="mb-3 text-sm text-ink-2">
        xelDash is made and maintained by one person. If it helps your mining, you can send a little XEL to the maintainer's wallet. It is
        entirely optional, nothing in xelDash depends on it, and xelDash never sends anything for you: copy the address and send from your own wallet.
      </p>
      <AddressRow />
      <p className="mt-2 text-xs text-muted">
        Check the address against the one in the <a href={`${REPO}#support-the-project`} target="_blank" rel="noopener noreferrer"
          className="underline decoration-line underline-offset-2 hover:text-ink">README on GitHub</a> before you send. Thank you.
      </p>
    </Card>
  );
}

/**
 * A one-time, dismissible note on the Overview once your own miners have found a block: the moment it is most natural to say thanks.
 * It never returns after it is closed in this browser.
 * @param {{ network: string | null | undefined, blocks: number }} props
 */
export function SupportNudge({ network, blocks }) {
  const [hidden, setHidden] = useState(supportDismissed);
  if (hidden || blocks < 1 || !supportApplies(network)) return null;
  return (
    <section className="rounded-lg border border-line bg-surface p-4 sm:p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-ink">{blocks === 1 ? "You found a block." : `You have found ${blocks} blocks.`} Nice.</h2>
          <p className="mt-1 text-sm text-ink-2">
            xelDash is free, with no fees, and made by one person. If it is useful to you, you can send a little XEL to the maintainer. Optional, and
            nothing depends on it.
          </p>
        </div>
        <button type="button" aria-label="Dismiss" onClick={() => { dismissSupport(); setHidden(true); }}
          className="min-h-6 shrink-0 rounded-md px-2 text-lg leading-none text-muted hover:bg-wash hover:text-ink">×</button>
      </div>
      <div className="mt-3"><AddressRow /></div>
      <p className="mt-2 text-xs text-muted">Copy it and send from your own wallet; xelDash never sends anything for you. You can find this again under Settings.</p>
    </section>
  );
}
