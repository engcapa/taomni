/**
 * ED-PARITY-022 DEC-022-01: IDEA error stripe — a narrow marker bar at the
 * right edge of the editor. Each mark maps a document line to the stripe's
 * height (via the height map, so folding/wrapping keep positions honest) and
 * clicking it moves the caret there. Sources are the same data the editor
 * already shows: provider diagnostics, VCS line changes, caret usages and
 * TODO/FIXME comments. Nothing here edits the document.
 */
import { EditorSelection, StateEffect, StateField, type EditorState, type Extension } from "@codemirror/state";
import { EditorView, ViewPlugin, type PluginValue, type ViewUpdate } from "@codemirror/view";
import type { LspDiagnostic, LspDocumentHighlight } from "../../../lib/editor/lsp";
import type { GitLineChange } from "./gitEditorChrome";

export type ErrorStripeKind =
  | "error"
  | "warning"
  | "info"
  | "todo"
  | "git-added"
  | "git-modified"
  | "git-deleted"
  | "usage";

export interface ErrorStripeSources {
  diagnostics: readonly LspDiagnostic[];
  gitChanges: readonly GitLineChange[];
  usages: readonly LspDocumentHighlight[];
}

export interface ErrorStripeMark {
  kind: ErrorStripeKind;
  /** Zero-based document line. */
  line: number;
  label: string;
}

const EMPTY_SOURCES: ErrorStripeSources = { diagnostics: [], gitChanges: [], usages: [] };

export const setErrorStripeSources = StateEffect.define<ErrorStripeSources>();

const errorStripeSourcesField = StateField.define<ErrorStripeSources>({
  create: () => EMPTY_SOURCES,
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setErrorStripeSources)) return effect.value;
    }
    return value;
  },
});

const TODO_PATTERN = /(?:\/\/|\/\*|^\s*\*|#|<!--)\s*.*?\b(TODO|FIXME)\b/;

/** Severity order used when several marks share one line (IDEA shows the worst). */
const KIND_RANK: Record<ErrorStripeKind, number> = {
  error: 0,
  warning: 1,
  info: 2,
  todo: 3,
  "git-modified": 4,
  "git-added": 5,
  "git-deleted": 6,
  usage: 7,
};

function diagnosticKind(severity: number | null): ErrorStripeKind {
  if (severity === 1) return "error";
  if (severity === 2) return "warning";
  return "info";
}

/** Pure mark list for a document state (tested without a view). */
export function collectErrorStripeMarks(state: EditorState, sources: ErrorStripeSources): ErrorStripeMark[] {
  const lines = state.doc.lines;
  const marks: ErrorStripeMark[] = [];
  const inDoc = (line: number) => line >= 0 && line < lines;
  for (const diagnostic of sources.diagnostics) {
    const line = diagnostic.range.start.line;
    if (!inDoc(line)) continue;
    // Hints (severity 4) stay out of the stripe like IDEA's weak warnings off.
    if (diagnostic.severity === 4) continue;
    marks.push({ kind: diagnosticKind(diagnostic.severity), line, label: diagnostic.message });
  }
  for (const change of sources.gitChanges) {
    if (!inDoc(change.startLine)) continue;
    const kind: ErrorStripeKind = change.kind === "added"
      ? "git-added"
      : change.kind === "deleted" ? "git-deleted" : "git-modified";
    marks.push({ kind, line: change.startLine, label: `${change.kind} lines` });
  }
  for (const usage of sources.usages) {
    const line = usage.range.start.line;
    if (!inDoc(line)) continue;
    marks.push({ kind: "usage", line, label: usage.kind === 3 ? "Write usage" : "Usage" });
  }
  // TODO/FIXME scan is bounded so a huge file cannot stall a frame.
  const scanLimit = Math.min(lines, 20_000);
  for (let number = 1; number <= scanLimit; number += 1) {
    const text = state.doc.line(number).text;
    const match = TODO_PATTERN.exec(text);
    if (match) marks.push({ kind: "todo", line: number - 1, label: text.trim().slice(0, 120) });
  }
  // One mark per (line, kind); the rendered stack keeps the worst on top.
  const seen = new Set<string>();
  return marks
    .filter((mark) => {
      const key = `${mark.line}:${mark.kind}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => a.line - b.line || KIND_RANK[a.kind] - KIND_RANK[b.kind]);
}

class ErrorStripeView implements PluginValue {
  private readonly dom: HTMLDivElement;

  constructor(private readonly view: EditorView) {
    this.dom = document.createElement("div");
    this.dom.className = "cm-error-stripe";
    this.dom.setAttribute("data-testid", "code-workspace-error-stripe");
    this.dom.setAttribute("role", "group");
    this.dom.setAttribute("aria-label", "Error stripe");
    view.dom.appendChild(this.dom);
    this.render();
  }

  private timer: number | null = null;

  update(update: ViewUpdate): void {
    const sourcesChanged = update.startState.field(errorStripeSourcesField, false)
      !== update.state.field(errorStripeSourcesField, false);
    if (sourcesChanged) {
      this.cancel();
      this.render();
    } else if (update.docChanged || update.heightChanged || update.geometryChanged) {
      // Geometry changes on most keystrokes too (height map re-measure);
      // rebuilding every mark then cost a full doc scan plus DOM churn per key.
      // Typing never pays for the TODO scan per keystroke; marks settle
      // shortly after the burst (the typing-latency budget stays intact).
      this.cancel();
      this.timer = window.setTimeout(() => {
        this.timer = null;
        this.render();
      }, 150);
    }
  }

  private cancel(): void {
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = null;
  }

  private render(): void {
    const view = this.view;
    const sources = view.state.field(errorStripeSourcesField, false) ?? EMPTY_SOURCES;
    const marks = collectErrorStripeMarks(view.state, sources);
    const total = Math.max(1, view.contentHeight);
    this.dom.replaceChildren();
    this.dom.setAttribute("data-mark-count", String(marks.length));
    for (const mark of marks) {
      const line = view.state.doc.line(mark.line + 1);
      const block = view.lineBlockAt(line.from);
      const button = document.createElement("button");
      button.type = "button";
      button.tabIndex = -1;
      button.className = `cm-error-stripe-mark cm-error-stripe-${mark.kind}`;
      button.setAttribute("data-testid", "code-workspace-error-stripe-mark");
      button.setAttribute("data-kind", mark.kind);
      button.setAttribute("data-line", String(mark.line + 1));
      button.title = `${mark.line + 1}: ${mark.label}`;
      button.setAttribute("aria-label", `Line ${mark.line + 1}: ${mark.label}`);
      button.style.top = `${Math.min(99.5, (block.top / total) * 100)}%`;
      // mousedown keeps editor focus; the action runs on click so synthetic
      // (assistive / automation) clicks work the same as a pointer.
      button.addEventListener("mousedown", (event) => {
        event.preventDefault();
        event.stopPropagation();
      });
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        const target = view.state.doc.line(mark.line + 1);
        view.dispatch({
          selection: EditorSelection.cursor(target.from),
          effects: EditorView.scrollIntoView(target.from, { y: "center" }),
        });
        view.focus();
      });
      this.dom.appendChild(button);
    }
  }

  destroy(): void {
    this.cancel();
    this.dom.remove();
  }
}

const errorStripeTheme = EditorView.baseTheme({
  "&": { position: "relative" },
  ".cm-scroller": { marginRight: "10px" },
  ".cm-error-stripe": {
    position: "absolute",
    top: "0",
    right: "0",
    bottom: "0",
    width: "10px",
    zIndex: "3",
    borderLeft: "1px solid var(--taomni-code-border, transparent)",
  },
  ".cm-error-stripe-mark": {
    position: "absolute",
    left: "1px",
    right: "1px",
    height: "3px",
    padding: "0",
    border: "0",
    borderRadius: "1px",
    cursor: "pointer",
  },
  ".cm-error-stripe-error": { background: "var(--taomni-code-error, #e5484d)", zIndex: "8" },
  ".cm-error-stripe-warning": { background: "var(--taomni-code-warning, #d9a400)", zIndex: "7" },
  ".cm-error-stripe-info": { background: "var(--taomni-code-muted, #8c8c8c)", zIndex: "6" },
  ".cm-error-stripe-todo": { background: "#4a9fd8", zIndex: "5" },
  ".cm-error-stripe-git-added": { background: "var(--taomni-code-syntax-added, #22c55e)", left: "1px", right: "5px", zIndex: "4" },
  ".cm-error-stripe-git-modified": { background: "var(--taomni-code-syntax-changed, #3b82f6)", left: "1px", right: "5px", zIndex: "4" },
  ".cm-error-stripe-git-deleted": { background: "var(--taomni-code-syntax-deleted, #9ca3af)", left: "1px", right: "5px", zIndex: "4" },
  ".cm-error-stripe-usage": { background: "var(--taomni-code-muted, #a0a0a0)", left: "5px", right: "1px", zIndex: "2" },
});

export function createErrorStripe(sources: ErrorStripeSources = EMPTY_SOURCES): Extension[] {
  return [
    errorStripeSourcesField.init(() => sources),
    ViewPlugin.fromClass(ErrorStripeView),
    errorStripeTheme,
  ];
}
