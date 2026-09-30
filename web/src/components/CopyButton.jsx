import { useState } from "react";

/** Copy text: the clipboard API where the page allows it (https, localhost), else a selection. @param {string} text */
async function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(text);
    return;
  }
  // A dashboard opened over plain http on a LAN address has no clipboard API.
  const box = document.createElement("textarea");
  box.value = text;
  box.setAttribute("readonly", "");
  box.style.position = "fixed";
  box.style.opacity = "0";
  document.body.appendChild(box);
  box.select();
  try {
    if (!document.execCommand("copy")) throw new Error("copy refused");
  } finally {
    document.body.removeChild(box);
  }
}

/** @param {{ text: string, label?: string }} props */
export default function CopyButton({ text, label = "Copy" }) {
  const [state, setState] = useState(/** @type {"idle" | "copied" | "failed"} */ ("idle"));
  async function copy() {
    try {
      await copyText(text);
      setState("copied");
    } catch {
      setState("failed");
    }
    setTimeout(() => setState("idle"), 2_000);
  }
  return (
    <button type="button" onClick={() => void copy()}
      className="shrink-0 rounded-md border border-line px-2 py-0.5 text-xs text-ink-2 hover:bg-wash hover:text-ink">
      {state === "copied" ? "Copied" : state === "failed" ? "Select and copy" : label}
    </button>
  );
}
