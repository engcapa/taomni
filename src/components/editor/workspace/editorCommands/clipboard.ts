import { EditorSelection, type ChangeSpec, type EditorState, type SelectionRange } from "@codemirror/state";
import {
  editorVirtualSpacePolicy,
  paddingForOverflow,
  setVirtualOverflow,
  setVirtualOverflowRestore,
  virtualSpaceOverflowField,
  type VirtualOverflowMap,
} from "../workspaceVirtualSpace";
import type { Command } from "@codemirror/view";
import type { EditorView } from "@codemirror/view";
import { buildPasteWithImportsChanges, computeImportInsertionOffset } from "../autoImportModel";
import { type ClipboardSourceEol, type EditorClipboardPayload, type NormalizedEditorSelection, type MultiCaretPastePlan } from "./types";

export function detectClipboardSourceEol(text: string): ClipboardSourceEol {
  if (text.includes("\r\n")) return "crlf";
  if (text.includes("\r")) return "cr";
  return "lf";
}

export function editorClipboardPayload(
  state: EditorState,
  rectangular = false,
): EditorClipboardPayload | null {
  const normalized = normalizeEditorSelections(state.selection.ranges, state.selection.mainIndex);
  const segments = normalized.ranges.map((range) => state.sliceDoc(range.from, range.to));
  if (segments.every((segment) => segment.length === 0)) return null;
  const plainText = segments.join(state.lineBreak);
  return {
    plainText,
    segments,
    sourceEol: detectClipboardSourceEol(plainText),
    rectangular,
  };
}

export function plainTextClipboardPayload(text: string): EditorClipboardPayload {
  return {
    plainText: text,
    sourceEol: detectClipboardSourceEol(text),
    rectangular: false,
  };
}

/**
 * CodeMirror normally keeps selections ordered and non-overlapping. This
 * boundary also accepts synthetic or restored ranges and deterministically
 * merges overlap while retaining the range that owned the primary caret.
 */
export function normalizeEditorSelections(
  ranges: readonly SelectionRange[],
  mainIndex: number,
): NormalizedEditorSelection {
  if (ranges.length === 0) {
    return { ranges: [EditorSelection.cursor(0)], mainIndex: 0 };
  }
  const primary = ranges[Math.min(Math.max(mainIndex, 0), ranges.length - 1)];
  const ordered = ranges
    .map((range, index) => ({ range, index }))
    .sort((a, b) => (
      a.range.from - b.range.from
      || a.range.to - b.range.to
      || a.index - b.index
    ));
  const merged: Array<{ range: SelectionRange; ownsPrimary: boolean; }> = [];
  for (const item of ordered) {
    const ownsPrimary = item.range === primary || item.index === mainIndex;
    const previous = merged[merged.length - 1];
    if (previous && item.range.from < previous.range.to) {
      const from = Math.min(previous.range.from, item.range.from);
      const to = Math.max(previous.range.to, item.range.to);
      const nextOwnsPrimary = previous.ownsPrimary || ownsPrimary;
      const anchor = nextOwnsPrimary && primary.anchor > primary.head ? to : from;
      const head = anchor === from ? to : from;
      previous.range = EditorSelection.range(anchor, head);
      previous.ownsPrimary = nextOwnsPrimary;
      continue;
    }
    merged.push({ range: item.range, ownsPrimary });
  }
  const normalizedMainIndex = Math.max(0, merged.findIndex((item) => item.ownsPrimary));
  return {
    ranges: merged.map((item) => item.range),
    mainIndex: normalizedMainIndex,
  };
}

export function normalizeClipboardEol(text: string, lineBreak: string): string {
  return text.replace(/\r\n?|\n/g, lineBreak);
}

export function buildMultiCaretPastePlan(
  state: EditorState,
  payload: EditorClipboardPayload,
): MultiCaretPastePlan | null {
  if (state.readOnly) return null;
  const normalized = normalizeEditorSelections(state.selection.ranges, state.selection.mainIndex);
  // ED-AUDIT-010: mirror workspaceClipboardSession.planPaste so production and
  // the documented contract share one distribution rule. N segments x N carets
  // map 1:1; fewer segments cycle deterministically; extra segments are
  // dropped (first N win); no segments fall back to whole plainText per caret.
  // Single-caret exception: one caret always receives the whole plainText so a
  // multi-segment copy is never lossy on paste (matches the long-standing
  // ED-CLIP-004 fallback regression); distribution rules apply across 2+
  // carets only. External OS text never carries session segments (see
  // payloadForSystemClipboardText identity check), so the whole-block fallback
  // only applies when segment identity was already discarded or when a single
  // caret cannot express a distribution.
  const segments = payload.segments;
  const caretCount = normalized.ranges.length;
  let distributed: readonly string[];
  if (!segments || segments.length === 0 || caretCount <= 1) {
    distributed = normalized.ranges.map(() => payload.plainText);
  } else if (segments.length === caretCount) {
    distributed = [...segments];
  } else if (segments.length < caretCount) {
    distributed = normalized.ranges.map((_, index) => segments[index % segments.length]);
  } else {
    distributed = normalized.ranges.map((_, index) => segments[index]);
  }
  const inserts = distributed.map((text) => normalizeClipboardEol(text, state.lineBreak));
  const changes = normalized.ranges.map((range, index) => ({
    from: range.from,
    to: range.to,
    insert: inserts[index] ?? "",
  }));
  const changeSet = state.changes(changes);
  const mappedRanges = normalized.ranges.map((range, index) => {
    const start = changeSet.mapPos(range.from, -1);
    return EditorSelection.cursor(start + (inserts[index]?.length ?? 0));
  });
  return {
    changes,
    selection: EditorSelection.create(mappedRanges, normalized.mainIndex),
  };
}

export function pasteEditorClipboardPayload(
  view: EditorView,
  payload: EditorClipboardPayload,
): boolean {
  if (view.composing) return false;
  const plan = buildMultiCaretPastePlan(view.state, payload);
  if (!plan) return false;
  // §8.19.5: carets parked in the virtual region get their padding spaces
  // manufactured in the SAME dispatch (multi-caret padding+text is one
  // transaction), and the overflow map collapses because the doc changed.
  let overflow: VirtualOverflowMap | null = null;
  if (view.state.field(virtualSpaceOverflowField, false)?.size) {
    overflow = new Map(view.state.field(virtualSpaceOverflowField)!);
  }
  let changes: readonly ChangeSpec[] = plan.changes;
  if (overflow && overflow.size > 0) {
    const padded = [...plan.changes];
    view.state.selection.ranges.forEach((range, index) => {
      const pad = paddingForOverflow(overflow!.get(range.from) ?? overflow!.get(range.head) ?? 0);
      if (pad) {
        const entry = padded[index] as { from: number; to: number; insert?: string; };
        padded[index] = { ...entry, insert: `${pad}${entry.insert ?? ""}` };
      }
    });
    changes = padded;
  }
  view.dispatch({
    changes,
    selection: plan.selection,
    ...(overflow && overflow.size > 0
      ? {
        effects: [
          setVirtualOverflow.of(new Map()),
          // ED-AUDIT-002: record the consumed overflow so one undo restores
          // the pasted text and the virtual caret together.
          setVirtualOverflowRestore.of(overflow),
        ],
      }
      : {}),
    userEvent: "input.paste",
    scrollIntoView: true,
  });
  return true;
}

/**
 * ED-IMPORT-001 A4: paste text with auto-imported classes in one atomic transaction.
 * Creates a single transaction with one undo entry that reverts both imports and paste.
 */
export function pasteEditorWithAutoImports(
  view: EditorView,
  options: {
    pastedText: string;
    importStatements?: readonly string[];
  },
): boolean {
  if (view.composing || view.state.readOnly) return false;
  const currentDoc = view.state.doc.toString();
  const pasteOffset = view.state.selection.main.head;
  const importStatements = options.importStatements ?? [];

  if (importStatements.length === 0) {
    return pasteEditorClipboardPayload(view, {
      plainText: options.pastedText,
      sourceEol: detectClipboardSourceEol(options.pastedText),
      rectangular: false,
    });
  }

  const insertionOffset = computeImportInsertionOffset(currentDoc);
  const { changes } = buildPasteWithImportsChanges({
    documentText: currentDoc,
    pasteOffset,
    pastedText: options.pastedText,
    importStatements,
    insertionOffset,
  });

  const addedImportLen = importStatements.join("").length;
  const adjustedPasteOffset = insertionOffset <= pasteOffset ? pasteOffset + addedImportLen : pasteOffset;
  const newHead = adjustedPasteOffset + options.pastedText.length;

  view.dispatch({
    changes,
    selection: { anchor: newHead },
    userEvent: "input.paste",
    scrollIntoView: true,
  });
  return true;
}

export function cutEditorSelections(view: EditorView): boolean {
  if (view.composing || view.state.readOnly) return false;
  const normalized = normalizeEditorSelections(
    view.state.selection.ranges,
    view.state.selection.mainIndex,
  );
  if (normalized.ranges.every((range) => range.empty)) return false;
  const changes = normalized.ranges
    .filter((range) => !range.empty)
    .map((range) => ({ from: range.from, to: range.to, insert: "" }));
  const changeSet = view.state.changes(changes);
  const ranges = normalized.ranges.map((range) => (
    EditorSelection.cursor(changeSet.mapPos(range.from, -1))
  ));
  view.dispatch({
    changes,
    selection: EditorSelection.create(ranges, normalized.mainIndex),
    userEvent: "delete.cut",
    scrollIntoView: true,
  });
  return true;
}

export function cloneCaretVertically(direction: -1 | 1): Command {
  return (view) => {
    if (view.composing || view.state.readOnly) return false;
    const state = view.state;
    const virtualSpace = state.facet(editorVirtualSpacePolicy);
    const normalized = normalizeEditorSelections(state.selection.ranges, state.selection.mainIndex);
    const additions: Array<{
      targetHead: number;
      overflow: number;
    }> = [];
    for (const range of normalized.ranges) {
      const line = state.doc.lineAt(range.head);
      const desiredColumn = range.head - line.from
        + (state.field(virtualSpaceOverflowField, false)?.get(range.head) ?? 0);
      const targetLineNumber = line.number + direction;
      if (targetLineNumber < 1) continue;
      if (targetLineNumber > state.doc.lines) {
        // CodeMirror merges empty selections at the same final document
        // offset. Never manufacture a line or padding just to clone a caret.
        continue;
      }
      const target = state.doc.line(targetLineNumber);
      const targetColumn = Math.min(desiredColumn, target.length);
      additions.push({
        targetHead: target.from + targetColumn,
        overflow: virtualSpace.afterLineEnd
          ? Math.max(0, desiredColumn - target.length)
          : 0,
      });
    }
    if (additions.length === 0) return false;

    const nextOverflow = new Map(
      state.field(virtualSpaceOverflowField, false) ?? new Map<number, number>(),
    );
    for (const addition of additions) {
      if (addition.overflow > 0) {
        nextOverflow.set(addition.targetHead, addition.overflow);
      }
    }
    const clonedRanges = additions.map((addition) => EditorSelection.cursor(addition.targetHead));
    const merged = normalizeEditorSelections(
      [...normalized.ranges, ...clonedRanges],
      normalized.mainIndex,
    );
    view.dispatch({
      selection: EditorSelection.create(merged.ranges, merged.mainIndex),
      effects: setVirtualOverflow.of(nextOverflow),
      scrollIntoView: true,
      userEvent: "select.cloneCaret",
    });
    return true;
  };
}
