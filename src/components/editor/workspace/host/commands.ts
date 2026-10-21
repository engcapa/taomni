import { EditorView } from "@codemirror/view";
import { completionStatus } from "@codemirror/autocomplete";
import { liveTemplateLanguageForPath } from "../liveTemplates";
import { foldAll, unfoldAll } from "@codemirror/language";
import { cloneCaretAbove, cloneCaretBelow, completeCurrentStatement, escapeEditorSelections, foldSelection, moveStatementDown, moveStatementUp, occurrenceSessionField, pasteEditorClipboardPayload, pasteEditorWithAutoImports, selectAllEditorOccurrences, selectNextEditorOccurrence } from "../workspaceEditorCommands";
import { completeStatementStrategy, surroundWithPlan, type SurroundKind } from "../workspaceSemanticEditing";
import { observeSyntaxFacts } from "../workspaceSyntaxFacts";
import { type EditorCommandOptions, type EditorCommandPort } from "./types";
import { writeEditorSelectionToClipboard, cutSystemClipboard, pasteSystemClipboard, pasteAsPlainText, workspaceStoreFor, clipboardContextByView } from "./clipboard";


/**
 * Apply a Surround With plan to the main selection (§8.18.8/§8.19.8). The
 * selection must span whole lines of one range; everything else is a typed
 * no-op. Provenance comes from live syntax facts when the Lezer tree aligns
 * exactly with the expanded line range and parses cleanly — otherwise the
 * plan stays honestly local-text.
 */
export function applySurroundWith(
  view: EditorView,
  kindId: SurroundKind["id"],
  onApplied?: EditorCommandOptions["onSemanticEditApplied"],
): boolean {
  if (view.state.readOnly || view.composing) return false;
  const ranges = view.state.selection.ranges;
  const main = view.state.selection.main;
  if (ranges.length !== 1) return false;
  const fromLine = view.state.doc.lineAt(main.from);
  const toLine = view.state.doc.lineAt(main.to);
  const languageId = guessEditorLanguageId(view) ?? "plaintext";
  // Node evidence is observed against the EXPANDED whole-line bounds, which
  // are what statement nodes actually align to.
  const syntax = observeSyntaxFacts(view.state, fromLine.from, toLine.to);
  const plan = surroundWithPlan(kindId, {
    text: view.state.doc.sliceString(fromLine.from, toLine.to),
    from: fromLine.from,
    to: toLine.to,
    fromLineStart: main.from === fromLine.from,
    toLineEnd: main.to === toLine.to,
    rangeCount: ranges.length,
    readOnly: view.state.readOnly,
    languageId,
    syntax,
  });
  if (plan.kind === "unavailable") {
    onApplied?.({ applied: false, provenance: null });
    return false;
  }
  view.dispatch({
    changes: plan.changes,
    selection: { anchor: Math.min(plan.selection.anchor, view.state.doc.length + plan.changes.reduce((sum, change) => sum + ("insert" in change ? (change.insert as string)?.length ?? 0 : 0), 0)) },
    userEvent: "input.surround",
    scrollIntoView: true,
  });
  // One transaction == one undo entry carrying its provenance evidence.
  onApplied?.({ applied: true, provenance: plan.provenance });
  return true;
}


/** Per-view language identity, registered at mount from the file path. */
export const editorLanguageByView = new WeakMap<EditorView, string>();


/** Best-effort language id from the host's current file path (§8.18.8). */
export function guessEditorLanguageId(view: EditorView): string | null {
  return editorLanguageByView.get(view) ?? liveTemplateLanguageForPath(null);
}


export const COMPOSITION_NAVIGATION_KEYS = new Set([
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Home",
  "End",
  "PageUp",
  "PageDown",
]);


export function isCompositionNavigationKey(key: string): boolean {
  return COMPOSITION_NAVIGATION_KEYS.has(key);
}


export function editorCommandPort(view: EditorView, isComposing?: () => boolean): EditorCommandPort {
  return {
    focus(options) {
      if (!view.dom.isConnected) return false;
      if (options?.preventScroll && typeof view.contentDOM?.focus === "function") {
        view.contentDOM.focus({ preventScroll: true });
      } else {
        view.focus();
      }
      return view.hasFocus || document.activeElement === view.contentDOM;
    },
    execute(commandId, options) {
      switch (commandId) {
        case "cloneCaretAbove": return cloneCaretAbove(view);
        case "cloneCaretBelow": return cloneCaretBelow(view);
        case "collapseCarets": return escapeEditorSelections(view);
        case "completeStatement": {
          // §8.19.8: the strategy decides between a syntax-tree-proven `;`,
          // the clearly-labelled Local/Heuristic fallback, and an explicit
          // no-op with reason. Same command the in-editor Mod-Shift-Enter
          // keymap runs, so shortcuts and direct typing share one behaviour.
          if (view.state.readOnly || view.composing) return false;
          const main = view.state.selection.main;
          const line = view.state.doc.lineAt(main.head);
          const decision = completeStatementStrategy({
            languageId: guessEditorLanguageId(view) ?? "plaintext",
            readOnly: view.state.readOnly,
            caretCount: view.state.selection.ranges.length,
            lineText: line.text,
            syntax: observeSyntaxFacts(view.state, line.from, line.to),
          });
          if (decision.kind === "unavailable") {
            options?.onSemanticEditApplied?.({ applied: false, provenance: null });
            return false;
          }
          if (decision.kind === "exact") {
            const at = Math.min(line.from + decision.insertSemicolonAt, line.to);
            view.dispatch({
              changes: { from: at, insert: ";" },
              selection: { anchor: at + 1 },
              userEvent: "input.completeStatement.syntax",
              scrollIntoView: true,
            });
            options?.onSemanticEditApplied?.({ applied: true, provenance: decision.provenance });
            return true;
          }
          const done = completeCurrentStatement(view);
          options?.onSemanticEditApplied?.({
            applied: done,
            provenance: { kind: "local-text", ruleId: decision.ruleId },
          });
          return done;
        }
        case "copy": return writeEditorSelectionToClipboard(view);
        case "cut": return cutSystemClipboard(view);
        case "foldAll": return foldAll(view) ?? false;
        case "foldSelection": return foldSelection(view);
        case "moveStatementDown": return moveStatementDown(view);
        case "moveStatementUp": return moveStatementUp(view);
        case "paste": return pasteSystemClipboard(view);
        case "pasteAsPlainText": return pasteAsPlainText(view);
        case "pasteFromHistory": {
          // §8.19.5: history paste promotes the entry to the live slot and
          // dispatches its FULL segment plan at the caret — deliberately
          // bypassing the system clipboard, which may hold newer content.
          const index = options?.historyIndex;
          if (index == null || view.composing || view.state.readOnly) return false;
          const store = workspaceStoreFor(clipboardContextByView.get(view));
          const session = index >= 0 && store ? store.pasteFromHistory(index) : null;
          if (!session) return false;
          pasteEditorClipboardPayload(view, {
            plainText: session.plainText,
            segments: session.segments ?? undefined,
            sourceEol: session.sourceEol,
            rectangular: session.rectangular,
          });
          view.focus();
          return true;
        }
        case "pasteWithAutoImports": {
          if (!options?.pastePayload) return false;
          return pasteEditorWithAutoImports(view, {
            pastedText: options.pastePayload.text,
            importStatements: options.pastePayload.importStatements,
          });
        }
        case "selectAllOccurrences": return selectAllEditorOccurrences(view);
        case "selectNextOccurrence": return selectNextEditorOccurrence(view);
        case "surroundWith": {
          // §8.19.8: every surround kind routes through this one entry point.
          const kindId = options?.surroundKindId;
          if (!kindId) return false;
          return applySurroundWith(view, kindId, options?.onSemanticEditApplied);
        }
        case "unfoldAll": return unfoldAll(view) ?? false;
      }
    },
    state: () => ({
      composing: view.composing || (isComposing?.() ?? false),
      readOnly: view.state.readOnly,
      hasSelection: view.state.selection.ranges.some((range) => !range.empty),
      caretCount: view.state.selection.ranges.length,
      occurrenceSessionActive: view.state.field(occurrenceSessionField, false) ?? false,
      completionActive: completionStatus(view.state) !== null,
    }),
  };
}
