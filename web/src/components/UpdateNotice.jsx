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

/** The running version, small, at the foot of every page, for bug reports. */
export function VersionFooter() {
  const version = usePolled("/api/v1/version", { intervalMs: 30 * 60_000 });
  if (!version.data?.current) return null;
  return <footer className="mx-auto max-w-6xl px-4 pb-8 text-xs text-muted sm:px-6">xelDash {version.data.current}</footer>;
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
    <div role="status" className="border-b border-line bg-wash">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-2 text-sm text-ink sm:px-6">
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
