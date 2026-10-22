import { EditorState, type Extension } from "@codemirror/state";
import { remoteTransactionAnnotation } from "../workspaceDocumentTransactionOwner";
import { EditorView, type Rect } from "@codemirror/view";


/**
 * Read-only buffers keep the caret, selection, search, and Ctrl+click navigation —
 * only document changes are rejected (IDEA's decompiled-source behaviour).
 */
export function readOnlyExtension(readOnly: boolean): Extension {
  return readOnly
    ? [
      EditorState.readOnly.of(true),
      EditorView.contentAttributes.of({ "aria-readonly": "true" }),
      EditorState.transactionFilter.of((tr) => (
        tr.docChanged && tr.startState.readOnly && !tr.annotation(remoteTransactionAnnotation) ? [] : tr
      )),
    ]
    : [];
}


export const WORKSPACE_EDITOR_STYLE = EditorView.theme({
  "&": {
    height: "100%",
  },
  ".cm-foldGutter .cm-gutterElement": {
    minWidth: "1.6ch",
    padding: "0 4px",
    // ED-PARITY-011 DEC-011-06: IDEA shows fold markers on gutter hover only.
    opacity: "0",
    transition: "opacity 120ms",
  },
  ".cm-gutters:hover .cm-foldGutter .cm-gutterElement, .cm-foldGutter .cm-gutterElement:focus-within": {
    opacity: "1",
  },
});


export const LSP_EDITOR_STYLE = EditorView.theme({
  ".cm-lsp-diagnostic-error": {
    textDecoration: "underline wavy #ef4444 1px",
    textUnderlineOffset: "2px",
  },
  ".cm-lsp-diagnostic-warning": {
    textDecoration: "underline wavy #f59e0b 1px",
    textUnderlineOffset: "2px",
  },
  ".cm-lsp-diagnostic-info": {
    textDecoration: "underline dotted #38bdf8 1px",
    textUnderlineOffset: "2px",
  },
  ".cm-tooltip": {
    zIndex: "50 !important",
  },
  ".cm-tooltip.cm-tooltip-hover": {
    background: "transparent !important",
    border: "none !important",
    boxShadow: "none !important",
    padding: "0 !important",
    overflow: "visible !important",
  },
  ".cm-lsp-hover-container": {
    width: "440px",
    height: "280px",
    minWidth: "260px",
    minHeight: "100px",
    maxWidth: "min(560px, 85vw)",
    maxHeight: "min(380px, 45vh)",
  },
  ".cm-lsp-hover": {
    overflow: "auto",
    padding: "8px 12px",
    background: "var(--taomni-code-tooltip-bg)",
    color: "var(--taomni-code-text)",
    fontSize: "12px",
    lineHeight: "1.5",
    outline: "none",
  },
  // Nested markdown (via .taomni-chat-md) is themed in index.css so it tracks
  // --taomni-code-* even when the tooltip is portaled outside the editor host.
});


export function positionCompletionInfo(view: EditorView, list: Rect, option: Rect, info: Rect, space: Rect) {
  const gap = 4;
  const width = Math.min(400, info.right - info.left, space.right - space.left);
  const height = info.bottom - info.top;
  const right = space.right - list.right - gap;
  const left = list.left - space.left - gap;
  let x: number;
  let y: number;
  let maxHeight: number;
  if (right >= width || left >= width) {
    x = right >= width ? list.right + gap : list.left - width - gap;
    y = Math.max(space.top, Math.min(option.top, space.bottom - height));
    maxHeight = space.bottom - y;
  } else {
    // CodeMirror's narrow fallback overlaps the selected row's neighbours.
    // Stack outside the entire list so every candidate remains clickable.
    const below = space.bottom - list.bottom - gap;
    const above = list.top - space.top - gap;
    x = Math.max(space.left, Math.min(list.left, space.right - width));
    if (below >= Math.min(height, above)) {
      y = list.bottom + gap;
      maxHeight = below;
    } else {
      maxHeight = above;
      y = list.top - Math.min(height, above) - gap;
    }
  }
  return {
    style: `left: ${(x - list.left) / view.scaleX}px; top: ${(y - list.top) / view.scaleY}px; `
      + `width: ${width / view.scaleX}px; max-width: ${width / view.scaleX}px; `
      + `max-height: ${Math.max(0, maxHeight) / view.scaleY}px; box-sizing: border-box; overflow-y: auto`,
  };
}
