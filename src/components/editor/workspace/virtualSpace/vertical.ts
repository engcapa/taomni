import { EditorSelection } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { documentColumnForVisualColumn, isEditorGeometryReady, resolveTargetVisualBlock, visualColumnFor } from "./geometry";
import { desiredVisualColumnField, MAX_OVERFLOW_COLUMNS, setDesiredVisualColumns, setVirtualOverflow, virtualOverflowAt } from "./overflow";
import { editorVirtualSpacePolicy } from "./policy";

/**
 * Vertical movement (Up / Down / PageUp / PageDown) with per-caret desired visual column.
 * Unified across single and multi-caret, respecting real display geometry, soft wrap,
 * tab/CJK/emoji visual widths and virtual space policy.
 */
export function virtualVerticalMoveCommand(
  view: EditorView,
  direction: "up" | "down" | "pageUp" | "pageDown",
  extend: boolean,
): boolean {
  if (view.composing) return false;
  const policy = view.state.facet(editorVirtualSpacePolicy);
  const state = view.state;
  const tabWidth = state.tabSize;
  const desired = state.field(desiredVisualColumnField, false) ?? [];

  // For PageUp / PageDown without ready geometry, yield to default handler (§ED-VSPACE-002)
  if ((direction === "pageUp" || direction === "pageDown") && !isEditorGeometryReady(view)) {
    return false;
  }

  let changed = false;
  const nextRanges: ReturnType<typeof EditorSelection.cursor>[] = [];
  const nextOverflow = new Map<number, number>();
  const nextDesired: number[] = [];

  for (let idx = 0; idx < state.selection.ranges.length; idx++) {
    const range = state.selection.ranges[idx];
    const currentLine = state.doc.lineAt(range.head);
    const currentOverflow = virtualOverflowAt(state, range.head);
    const initialDesiredCol = desired[idx] ?? (
      visualColumnFor(currentLine.text, range.head - currentLine.from, tabWidth)
      + currentOverflow
    );
    const requestedGoalColumn = range.goalColumn
      ?? (currentOverflow > 0
        ? initialDesiredCol * Math.max(1, view.defaultCharacterWidth)
        : undefined);

    const targetBlock = resolveTargetVisualBlock(
      view,
      range.head,
      direction,
      requestedGoalColumn,
    );
    if (!targetBlock) return false;

    const desiredCol = view.lineWrapping && targetBlock.goalColumn != null
      ? Math.max(0, Math.round(targetBlock.goalColumn / Math.max(1, view.defaultCharacterWidth)))
      : initialDesiredCol;
    nextDesired.push(desiredCol);

    const geometryTargetHead = targetBlock.head;
    const targetPhysLine = state.doc.lineAt(geometryTargetHead ?? targetBlock.from);
    const isEndOfPhysLine = (geometryTargetHead ?? targetBlock.to) === targetPhysLine.to;
    const isLastLine = targetPhysLine.number === state.doc.lines;
    const allowed = isLastLine ? policy.atFileBottom : policy.afterLineEnd;

    const blockText = state.sliceDoc(targetBlock.from, targetBlock.to);
    const blockVisualWidth = visualColumnFor(blockText, blockText.length, tabWidth);

    let targetHead: number;
    if (view.lineWrapping && geometryTargetHead != null) {
      targetHead = geometryTargetHead;
      if (desiredCol > blockVisualWidth && allowed && isEndOfPhysLine) {
        const overflow = Math.min(desiredCol - blockVisualWidth, MAX_OVERFLOW_COLUMNS);
        nextOverflow.set(targetHead, overflow);
      }
    } else if (desiredCol > blockVisualWidth) {
      targetHead = targetBlock.to;
      if (allowed && isEndOfPhysLine) {
        const overflow = Math.min(desiredCol - blockVisualWidth, MAX_OVERFLOW_COLUMNS);
        nextOverflow.set(targetHead, overflow);
      }
    } else {
      const docCol = documentColumnForVisualColumn(blockText, desiredCol, tabWidth);
      targetHead = targetBlock.from + docCol;
    }

    if (targetHead !== range.head || virtualOverflowAt(state, range.head) !== (nextOverflow.get(targetHead) ?? 0)) {
      changed = true;
    }

    if (extend) {
      nextRanges.push(EditorSelection.range(
        range.anchor,
        targetHead,
        targetBlock.goalColumn,
      ));
    } else {
      nextRanges.push(EditorSelection.cursor(targetHead, 1, undefined, targetBlock.goalColumn));
    }
  }

  if (!changed) return false;

  view.dispatch({
    selection: EditorSelection.create(nextRanges, state.selection.mainIndex),
    effects: [
      setVirtualOverflow.of(nextOverflow),
      setDesiredVisualColumns.of(nextDesired),
    ],
    scrollIntoView: true,
  });
  return true;
}

export const virtualMoveUp = (view: EditorView) => virtualVerticalMoveCommand(view, "up", false);

export const virtualMoveDown = (view: EditorView) => virtualVerticalMoveCommand(view, "down", false);

export const virtualSelectUp = (view: EditorView) => virtualVerticalMoveCommand(view, "up", true);

export const virtualSelectDown = (view: EditorView) => virtualVerticalMoveCommand(view, "down", true);

export const virtualPageUp = (view: EditorView) => virtualVerticalMoveCommand(view, "pageUp", false);

export const virtualPageDown = (view: EditorView) => virtualVerticalMoveCommand(view, "pageDown", false);

export const virtualSelectPageUp = (view: EditorView) => virtualVerticalMoveCommand(view, "pageUp", true);

export const virtualSelectPageDown = (view: EditorView) => virtualVerticalMoveCommand(view, "pageDown", true);
