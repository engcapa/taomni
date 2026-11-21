import { EditorView } from "@codemirror/view";

/** Apply external document text sync into a CM6 view only if content differs, avoiding feedback loops. */
export function syncViewDocumentText(view: EditorView | null, nextContent: string): boolean {
  if (!view) return false;
  const current = view.state.doc.toString();
  if (current === nextContent) return false;
  const sel = view.state.selection.main;
  const clampedAnchor = Math.min(sel.anchor, nextContent.length);
  const clampedHead = Math.min(sel.head, nextContent.length);
  view.dispatch({
    changes: { from: 0, to: current.length, insert: nextContent },
    selection: { anchor: clampedAnchor, head: clampedHead },
  });
  return true;
}

/**
 * Synchronize scroll position between primary and secondary split panes without ping-pong loops.
 */
export function createSplitScrollCoordinator() {
  let syncing = false;
  return {
    sync(source: HTMLElement | null, target: HTMLElement | null, syncV: boolean, syncH: boolean) {
      if (syncing || !source || !target || (!syncV && !syncH)) return;
      syncing = true;
      try {
        if (syncV) target.scrollTop = source.scrollTop;
        if (syncH) target.scrollLeft = source.scrollLeft;
      } finally {
        if (typeof requestAnimationFrame === "function") {
          requestAnimationFrame(() => {
            syncing = false;
          });
        } else {
          syncing = false;
        }
      }
    },
  };
}
