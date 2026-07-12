import {
  EditorSelection,
  StateEffect,
  StateField,
  type EditorState,
} from "@codemirror/state";
import {
  copyLineDown,
  deleteLine,
  moveLineDown,
  moveLineUp,
  toggleBlockComment,
  toggleComment,
} from "@codemirror/commands";
import { syntaxTree } from "@codemirror/language";
import { gotoLine } from "@codemirror/search";
import type { Command, KeyBinding } from "@codemirror/view";
import type { EditorView } from "@codemirror/view";
import type { LspRange } from "../../../lib/editor/lsp";
import { offsetFromLspPosition } from "./lspPositions";

const setSelectionHistory = StateEffect.define<EditorSelection[]>();

export const selectionHistoryField = StateField.define<EditorSelection[]>({
  create: () => [],
  update(history, transaction) {
    const controlled = transaction.effects.find((effect) => effect.is(setSelectionHistory));
    if (controlled?.is(setSelectionHistory)) return controlled.value;
    if (transaction.docChanged || transaction.selection) return [];
    return history;
  },
});

function expandedSelection(state: EditorState): EditorSelection | null {
  let changed = false;
  const ranges = state.selection.ranges.map((range) => {
    let node: ReturnType<typeof syntaxTree>["topNode"] | null = syntaxTree(state).resolveInner(range.head, -1);
    while (node) {
      const contains = node.from <= range.from && node.to >= range.to;
      const expands = node.from < range.from || node.to > range.to;
      if (contains && expands) {
        changed = true;
        return EditorSelection.range(node.from, node.to);
      }
      node = node.parent;
    }
    return range;
  });
  return changed ? EditorSelection.create(ranges, state.selection.mainIndex) : null;
}

export const expandSyntaxSelection: Command = (view) => {
  const selection = expandedSelection(view.state);
  if (!selection) return false;
  const history = view.state.field(selectionHistoryField);
  view.dispatch({
    selection,
    effects: setSelectionHistory.of([...history, view.state.selection]),
    scrollIntoView: true,
  });
  return true;
};

export function expandSelectionFromLspRanges(view: EditorView, ranges: LspRange[]): boolean {
  const current = view.state.selection.main;
  for (const range of ranges) {
    const from = offsetFromLspPosition(view.state.doc, range.start);
    const to = offsetFromLspPosition(view.state.doc, range.end);
    if (from > current.from || to < current.to) continue;
    if (from === current.from && to === current.to) continue;
    const history = view.state.field(selectionHistoryField);
    view.dispatch({
      selection: EditorSelection.range(from, to),
      effects: setSelectionHistory.of([...history, view.state.selection]),
      scrollIntoView: true,
    });
    return true;
  }
  return false;
}

export const shrinkSyntaxSelection: Command = (view) => {
  const history = view.state.field(selectionHistoryField);
  const previous = history[history.length - 1];
  if (!previous) return false;
  view.dispatch({
    selection: previous,
    effects: setSelectionHistory.of(history.slice(0, -1)),
    scrollIntoView: true,
  });
  return true;
};

export const workspaceEditorKeymap: readonly KeyBinding[] = [
  { key: "Mod-/", run: toggleComment },
  { key: "Mod-Shift-/", run: toggleBlockComment },
  { key: "Mod-d", run: copyLineDown },
  { key: "Mod-y", run: deleteLine },
  { key: "Shift-Alt-ArrowUp", run: moveLineUp },
  { key: "Shift-Alt-ArrowDown", run: moveLineDown },
  { key: "Mod-w", run: expandSyntaxSelection },
  { key: "Mod-Shift-w", run: shrinkSyntaxSelection },
  { key: "Mod-g", run: gotoLine },
];
