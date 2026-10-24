import { useState } from "react";
import { usePolled } from "../api.js";

const KEY = "xeldash.dismissedUpdate";

/** @returns {string | null} */
function dismissed() {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

/**
 * The foot of every page: the running version, small, for bug reports (once it is known), and a link to how to support xelDash, in the
 * README on GitHub (where the address is checked before sending; visitors to a public server have no Settings page with it).
 */
export function VersionFooter() {
  const version = usePolled("/api/v1/version", { intervalMs: 30 * 60_000 });
  // The page width; on phones, above the bottom tab bar.
  return (
    <footer className="mx-auto -mt-8 flex max-w-[1280px] flex-wrap items-center gap-x-4 gap-y-1 px-8 pb-10 text-xs text-muted max-[720px]:-mt-20 max-[720px]:px-4 max-[720px]:pb-28">
      {version.data?.current && <span className="mono">xelDash {version.data.current}</span>}
      <a href="https://github.com/pitanu/xelDash#support-the-project" target="_blank" rel="noopener noreferrer"
        className="text-muted underline decoration-line underline-offset-2 hover:text-ink">Support xelDash</a>
    </footer>
  );
}

/**
 * A line under the header when a newer xelDash has been released, with how to update. Dismissing it
 * hides that version in this browser until a still newer one comes out.
 */
export default function UpdateNotice() {
  const version = usePolled("/api/v1/version", { intervalMs: 30 * 60_000 });
  const [hidden, setHidden] = useState(dismissed);
  const v = version.data;
  if (!v?.available || hidden === v.latest) return null;
  return (
    <div role="status" className="card">
      <div className="flex items-center justify-between gap-3 px-6 py-4 text-sm text-ink max-[720px]:px-[18px]">
        <span>
          <strong>xelDash {v.latest} is available</strong> (you have {v.current}). To update, run{" "}
          <code className="rounded bg-surface px-1">xeldash update</code> in the xelDash folder.{" "}
          <a href={v.url} target="_blank" rel="noopener noreferrer" className="underline decoration-line underline-offset-2 hover:text-ink">What changed</a>
        </span>
        <button type="button" aria-label="Dismiss" onClick={() => {
          try {
            localStorage.setItem(KEY, v.latest);
          } catch {
            // Hidden for this page load only.
          }
          setHidden(v.latest);
        }} className="shrink-0 rounded p-1 text-ink-2 hover:bg-surface hover:text-ink">×</button>
      </div>
    </div>
  );
}
