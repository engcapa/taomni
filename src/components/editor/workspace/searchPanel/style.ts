import { EditorView } from "@codemirror/view";

export const WORKSPACE_SEARCH_STYLE = EditorView.theme({
  ".cm-panels-top": {
    borderBottom: "1px solid var(--taomni-code-border)",
  },
  ".cm-panel.cm-workspace-search": {
    display: "flex",
    flexDirection: "column",
    gap: "4px",
    padding: "6px 8px",
    background: "var(--taomni-code-gutter-bg)",
    color: "var(--taomni-code-text)",
    fontSize: "var(--taomni-ui-font-size, 12px)",
  },
  ".cm-workspace-search-row": {
    display: "flex",
    alignItems: "center",
    gap: "4px",
    minWidth: "0",
  },
  ".cm-workspace-search-field": {
    position: "relative",
    display: "flex",
    alignItems: "center",
    flex: "1 1 320px",
    maxWidth: "520px",
    minWidth: "80px",
    border: "1px solid var(--taomni-code-border)",
    borderRadius: "4px",
    background: "var(--taomni-code-bg)",
    overflow: "hidden",
  },
  ".cm-workspace-search-field:focus-within": {
    borderColor: "var(--taomni-accent)",
    outline: "1px solid var(--taomni-accent)",
  },
  ".cm-workspace-search-input": {
    boxSizing: "border-box",
    width: "100%",
    minWidth: "0",
    height: "2.2em",
    border: "none",
    borderRadius: "4px",
    padding: "0 7px",
    outline: "none",
    background: "var(--taomni-code-bg)",
    color: "var(--taomni-code-text)",
    font: "inherit",
  },
  '.cm-workspace-search-input[type="search"]': {
    // Do not set appearance:none — it can suppress the platform clear control.
    WebkitAppearance: "textfield",
  },
  ".cm-workspace-search-input:focus": {
    borderColor: "var(--taomni-accent)",
  },
  ".cm-workspace-search-button": {
    boxSizing: "border-box",
    height: "2.2em",
    minWidth: "2em",
    flexShrink: "0",
    border: "1px solid transparent",
    borderRadius: "4px",
    padding: "0 6px",
    background: "transparent",
    color: "inherit",
    font: "inherit",
    cursor: "pointer",
  },
  ".cm-workspace-search-button:hover": {
    background: "var(--taomni-code-active-line-bg)",
  },
  '.cm-workspace-search-button[aria-pressed="true"]': {
    borderColor: "var(--taomni-code-border)",
    background: "var(--taomni-code-selection-match-bg)",
    color: "var(--taomni-accent)",
  },
  ".cm-workspace-search-status": {
    minWidth: "3.5em",
    marginLeft: "4px",
    color: "var(--taomni-code-muted)",
    whiteSpace: "nowrap",
  },
  ".cm-workspace-replace-row": {
    paddingLeft: "calc(2em + 4px)",
  },
  ".cm-workspace-search [hidden]": {
    display: "none",
  },
  ".cm-workspace-search-options": {
    display: "flex",
    flexWrap: "wrap",
    gap: "4px",
  },
  ".cm-workspace-search-button:focus-visible": {
    outline: "2px solid var(--taomni-accent)",
    outlineOffset: "-2px",
  },
  ".cm-workspace-search-button:disabled": {
    opacity: "0.5",
    cursor: "default",
  },
  ".cm-workspace-search-textarea": {
    height: "auto",
    minHeight: "4.4em",
    padding: "4px 7px",
    resize: "vertical",
  },
  ".cm-workspace-search-field .cm-workspace-search-button": {
    minWidth: "1.6em",
    padding: "0 4px",
  },
  ".cm-workspace-search-history-button": {
    color: "var(--taomni-code-muted)",
  },
  ".cm-workspace-search-filter": {
    whiteSpace: "nowrap",
  },
  ".cm-workspace-search-history": {
    display: "flex",
    flexDirection: "column",
    maxWidth: "520px",
    maxHeight: "12em",
    overflowY: "auto",
    border: "1px solid var(--taomni-code-border)",
    borderRadius: "4px",
    background: "var(--taomni-code-bg)",
  },
  ".cm-workspace-search-history-item": {
    border: "none",
    background: "transparent",
    color: "inherit",
    font: "inherit",
    textAlign: "left",
    padding: "2px 8px",
    whiteSpace: "pre",
    overflow: "hidden",
    textOverflow: "ellipsis",
    cursor: "pointer",
  },
  ".cm-workspace-search-history-item:hover, .cm-workspace-search-history-item:focus": {
    background: "var(--taomni-code-active-line-bg)",
    outline: "none",
  },
  ".cm-workspace-search-history-empty": {
    padding: "2px 8px",
    color: "var(--taomni-code-muted)",
  },
  ".cm-searchMatch": {
    backgroundColor: "var(--taomni-code-selection-match-bg)",
    outline: "1px solid color-mix(in srgb, var(--taomni-accent) 45%, transparent)",
  },
  ".cm-searchMatch.cm-searchMatch-selected": {
    backgroundColor: "color-mix(in srgb, var(--taomni-accent) 32%, transparent)",
  },
});
