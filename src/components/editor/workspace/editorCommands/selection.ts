import { EditorSelection, StateEffect, StateField, type EditorState } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import { selectNextOccurrence, selectSelectionMatches } from "@codemirror/search";
import type { Command } from "@codemirror/view";
import type { EditorView } from "@codemirror/view";
import type { LspRange } from "../../../../lib/editor/lsp";
import { offsetFromLspPosition } from "../lspPositions";

export const setSelectionHistory = StateEffect.define<EditorSelection[]>();

export const setOccurrenceSession = StateEffect.define<boolean>();

export const occurrenceSessionField = StateField.define<boolean>({
  create: () => false,
  update(active, transaction) {
    const controlled = transaction.effects.find((effect) => effect.is(setOccurrenceSession));
    if (controlled?.is(setOccurrenceSession)) return controlled.value;
    if (active && (transaction.docChanged || transaction.selection)) return false;
    return active;
  },
});

export const selectNextEditorOccurrence: Command = (view) => {
  const before = view.state.selection;
  if (!selectNextOccurrence(view) || view.state.selection.eq(before)) return false;
  view.dispatch({ effects: setOccurrenceSession.of(true) });
  return true;
};

export const selectAllEditorOccurrences: Command = (view) => {
  const before = view.state.selection;
  if (!selectSelectionMatches(view) || view.state.selection.eq(before)) return false;
  view.dispatch({ effects: setOccurrenceSession.of(true) });
  return true;
};

export const escapeEditorSelections: Command = (view) => {
  // ED-AUDIT-011: Escape during IME composition belongs to the candidate
  // window; never collapse carets or clear occurrence state mid-composition.
  if (view.composing) return false;
  if (view.state.field(occurrenceSessionField, false)) {
    view.dispatch({ effects: setOccurrenceSession.of(false) });
    return true;
  }
  if (view.state.selection.ranges.length <= 1) return false;
  view.dispatch({
    selection: EditorSelection.create([view.state.selection.main]),
    scrollIntoView: true,
    userEvent: "select.collapse",
  });
  return true;
};

export const selectionHistoryField = StateField.define<EditorSelection[]>({
  create: () => [],
  update(history, transaction) {
    const controlled = transaction.effects.find((effect) => effect.is(setSelectionHistory));
    if (controlled?.is(setSelectionHistory)) return controlled.value;
    if (transaction.docChanged || transaction.selection) return [];
    return history;
  },
});

export function expandedSelection(state: EditorState): EditorSelection | null {
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

export const unselectOccurrence: Command = (view) => {
  const ranges = view.state.selection.ranges;
  if (ranges.length <= 1) return false;
  const newRanges = ranges.slice(0, ranges.length - 1);
  const newMainIndex = Math.min(view.state.selection.mainIndex, newRanges.length - 1);
  view.dispatch({
    selection: EditorSelection.create(newRanges, newMainIndex),
    effects: setOccurrenceSession.of(true),
    scrollIntoView: true,
  });
  return true;
};
