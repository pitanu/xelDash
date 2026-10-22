// The tab title tells someone on another tab that a block was found: "(2) Block found · xelDash" until they look at the tab again.

/** @typedef {Pick<Document, "title" | "hidden" | "hasFocus" | "addEventListener" | "removeEventListener">} TitleDocument */

/** Whether the tab is on screen and has focus. @param {TitleDocument} doc */
export function tabInView(doc) {
  return !doc.hidden && doc.hasFocus();
}

/**
 * Counts blocks found while the tab is out of view in its title, and puts the plain title back once the tab is in view again.
 * @param {TitleDocument} [doc]
 * @param {Pick<Window, "addEventListener" | "removeEventListener">} [win]
 */
export function watchUnseenBlocks(doc = document, win = window) {
  const plain = doc.title;
  let unseen = 0;
  const seen = () => {
    if (unseen === 0 || !tabInView(doc)) return;
    unseen = 0;
    doc.title = plain;
  };
  doc.addEventListener("visibilitychange", seen);
  win.addEventListener("focus", seen);
  return {
    blockFound() {
      if (tabInView(doc)) return;
      unseen += 1;
      doc.title = `(${unseen}) Block found · ${plain}`;
    },
    stop() {
      doc.removeEventListener("visibilitychange", seen);
      win.removeEventListener("focus", seen);
      doc.title = plain;
    },
  };
}
