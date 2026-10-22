

// Make the CodeMirror merge/unified editors fill the scroll host.
export const STYLE_ID = "taomni-diff-style";


if (typeof document !== "undefined" && !document.getElementById(STYLE_ID)) {
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
.taomni-diff-host {
  --taomni-git-diff-font-size: var(--taomni-code-font-size);
  --taomni-diff-editor-bg: var(--taomni-code-bg);
  --taomni-diff-gutter-bg: var(--taomni-code-gutter-bg);
  --taomni-diff-text: var(--taomni-code-text);
  --taomni-diff-muted: var(--taomni-code-muted);
  --taomni-diff-border: var(--taomni-code-border);
  --taomni-diff-scroll-track: var(--taomni-code-scrollbar-track);
  --taomni-diff-scroll-thumb: var(--taomni-code-scrollbar-thumb);
  --taomni-diff-added-bg: var(--taomni-code-diff-added-bg);
  --taomni-diff-added-word: var(--taomni-code-diff-added-word);
  --taomni-diff-deleted-bg: var(--taomni-code-diff-deleted-bg);
  --taomni-diff-deleted-word: var(--taomni-code-diff-deleted-word);
  --taomni-diff-deleted-border: var(--taomni-code-diff-deleted-border);
  --taomni-diff-modified-bg: var(--taomni-code-diff-modified-bg);
  --taomni-diff-modified-word: var(--taomni-code-diff-modified-word);
  --taomni-diff-connector-added: var(--taomni-code-diff-connector-added);
  --taomni-diff-connector-deleted: var(--taomni-code-diff-connector-deleted);
  --taomni-diff-connector-modified: var(--taomni-code-diff-connector-modified);
  --taomni-diff-connector-stroke: var(--taomni-code-diff-connector-stroke);
  display: flex;
  flex-direction: column;
  min-height: 0;
  min-width: 0;
  overflow: hidden;
}

.taomni-diff-host .cm-mergeView,
.taomni-diff-host .cm-mergeViewEditors,
.taomni-diff-host .cm-editor {
  height: 100% !important;
  width: 100% !important;
  min-height: 0;
  min-width: 0;
  box-sizing: border-box;
}

.taomni-diff-host .cm-mergeView {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  overflow: hidden !important;
  background: var(--taomni-diff-editor-bg);
}

.taomni-diff-host .cm-mergeViewEditors {
  display: flex;
  flex-direction: row;
  align-items: stretch;
  flex: 1 1 auto;
  width: 100%;
  min-height: 0;
  min-width: 0;
  overflow: hidden;
}

.taomni-diff-host .cm-mergeViewEditor {
  display: flex;
  flex-direction: column;
  flex: 1 1 0;
  width: auto;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  background: var(--taomni-diff-editor-bg);
}

.taomni-diff-host .cm-mergeViewEditor > .cm-editor {
  flex: 1 1 auto;
  width: 100% !important;
  min-width: 0;
  min-height: 0;
}

.taomni-diff-host .cm-mergeViewEditor + .cm-mergeViewEditor {
  border-left: 1px solid var(--taomni-diff-border);
}

.taomni-diff-host .cm-mergeView .cm-editor .cm-scroller,
.taomni-diff-host > .cm-editor .cm-scroller {
  flex: 1 1 auto;
  height: 100% !important;
  width: 100% !important;
  min-height: 0;
  min-width: 0;
  overflow-x: auto !important;
  overflow-y: auto !important;
}

.taomni-diff-host .cm-editor,
.taomni-diff-host .cm-mergeView,
.taomni-diff-host .cm-deletedChunk {
  font-family: var(--taomni-code-font-family) !important;
  font-size: var(--taomni-git-diff-font-size) !important;
  line-height: var(--taomni-code-line-height) !important;
}

.taomni-diff-host .cm-editor {
  background: var(--taomni-diff-editor-bg) !important;
  color: var(--taomni-diff-text) !important;
}

.taomni-diff-host .cm-line {
  color: var(--taomni-diff-text);
}

.taomni-diff-host .cm-gutters {
  background: var(--taomni-diff-gutter-bg) !important;
  color: var(--taomni-diff-muted) !important;
  border-right: 1px solid var(--taomni-diff-border) !important;
}

.taomni-diff-host .cm-activeLine,
.taomni-diff-host .cm-activeLineGutter {
  background: var(--taomni-code-active-line-bg) !important;
}

.taomni-diff-host .cm-selectionBackground,
.taomni-diff-host .cm-focused .cm-selectionBackground {
  background: var(--taomni-code-selection-bg) !important;
}

.taomni-diff-host .cm-merge-a .cm-changedLine {
  background-color: var(--taomni-diff-deleted-bg) !important;
}

.taomni-diff-host .cm-merge-a .cm-changedText {
  background: var(--taomni-diff-deleted-word) !important;
  border-radius: 2px;
}

.taomni-diff-host .cm-merge-b .cm-changedLine {
  background-color: var(--taomni-diff-added-bg) !important;
}

.taomni-diff-host .cm-merge-b .cm-changedText {
  background: var(--taomni-diff-added-word) !important;
  border-radius: 2px;
}

.taomni-diff-host .cm-deletedChunk {
  background: var(--taomni-diff-deleted-bg) !important;
  border-left: 3px solid var(--taomni-diff-deleted-border) !important;
  padding-left: 8px !important;
}

.taomni-diff-host .cm-deletedLine {
  background: transparent !important;
}

.taomni-diff-host .cm-deletedChunk .cm-deletedText {
  background: var(--taomni-diff-deleted-word) !important;
  border-radius: 2px;
}

.taomni-diff-host .cm-inlineChangedLine {
  background: var(--taomni-diff-modified-bg) !important;
}

.taomni-diff-host .cm-merge-a .cm-changedLineGutter,
.taomni-diff-host .cm-deletedLineGutter {
  background: var(--taomni-diff-deleted-bg) !important;
  color: var(--taomni-diff-text) !important;
}

.taomni-diff-host .cm-merge-b .cm-changedLineGutter {
  background: var(--taomni-diff-added-bg) !important;
  color: var(--taomni-diff-text) !important;
}

.taomni-diff-host .cm-inlineChangedLineGutter {
  background: var(--taomni-diff-modified-bg) !important;
  color: var(--taomni-diff-text) !important;
}

.taomni-diff-host .cm-mergeSpacer {
  background: color-mix(in srgb, var(--taomni-diff-border) 28%, transparent) !important;
  background-image: none !important;
}

.taomni-diff-host .taomni-diff-connector {
  position: relative;
  align-self: stretch;
  box-sizing: border-box;
  flex: 0 0 ${CONNECTOR_WIDTH}px;
  width: ${CONNECTOR_WIDTH}px;
  min-width: ${CONNECTOR_WIDTH}px;
  min-height: 0;
  overflow: hidden;
  background:
    linear-gradient(to right, transparent 0, color-mix(in srgb, var(--taomni-diff-border) 55%, transparent) 50%, transparent 100%),
    var(--taomni-diff-gutter-bg);
  border-left: 1px solid var(--taomni-diff-border);
  border-right: 1px solid var(--taomni-diff-border);
  cursor: col-resize;
  pointer-events: auto;
  touch-action: none;
  user-select: none;
}

.taomni-diff-host .taomni-diff-connector:focus-visible {
  outline: 1px solid var(--taomni-accent);
  outline-offset: -1px;
}

.taomni-diff-host .taomni-diff-connector.is-dragging {
  background-color: color-mix(in srgb, var(--taomni-accent) 16%, var(--taomni-diff-gutter-bg));
}

.taomni-diff-host .taomni-diff-connector svg {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  display: block;
  pointer-events: none;
}

.taomni-diff-host .taomni-diff-connector-path {
  stroke: var(--taomni-diff-connector-stroke);
  stroke-width: 1;
}

.taomni-diff-host .taomni-diff-connector-path.is-added {
  fill: var(--taomni-diff-connector-added);
}

.taomni-diff-host .taomni-diff-connector-path.is-deleted {
  fill: var(--taomni-diff-connector-deleted);
}

.taomni-diff-host .taomni-diff-connector-path.is-modified {
  fill: var(--taomni-diff-connector-modified);
}

.taomni-diff-host .cm-scroller {
  scrollbar-color: var(--taomni-diff-scroll-thumb) var(--taomni-diff-scroll-track);
  scrollbar-width: thin;
}

.taomni-diff-host .cm-scroller::-webkit-scrollbar {
  width: 12px;
  height: 12px;
}

.taomni-diff-host .cm-scroller::-webkit-scrollbar-track {
  background: var(--taomni-diff-scroll-track);
}

.taomni-diff-host .cm-scroller::-webkit-scrollbar-thumb {
  background: var(--taomni-diff-scroll-thumb);
  border: 3px solid var(--taomni-diff-scroll-track);
  border-radius: 6px;
}

.taomni-diff-host .cm-scroller::-webkit-scrollbar-thumb:hover {
  background: color-mix(in srgb, var(--taomni-diff-scroll-thumb) 78%, var(--taomni-diff-text));
}
`;
  document.head.appendChild(style);
}
import { CONNECTOR_WIDTH } from "./layout";
