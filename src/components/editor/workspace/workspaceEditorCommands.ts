// §8.19.5: the facet itself lives beside the virtual-space StateField so the
// field can read it without an import cycle; re-exported here for the
// appearance/profile consumers.
export { editorVirtualSpacePolicy } from "./workspaceVirtualSpace";

export {
  type CommandOutcome,
  type ClipboardSourceEol,
  type EditorClipboardPayload,
  type NormalizedEditorSelection,
  type MultiCaretPastePlan,
  type EditorVirtualSpacePolicy,
  type SortLinesOptions,
} from "./editorCommands/types";

export {
  detectClipboardSourceEol,
  editorClipboardPayload,
  plainTextClipboardPayload,
  normalizeEditorSelections,
  buildMultiCaretPastePlan,
  pasteEditorClipboardPayload,
  pasteEditorWithAutoImports,
  cutEditorSelections,
  cloneCaretVertically,
} from "./editorCommands/clipboard";

export { cloneCaretAbove, cloneCaretBelow } from "./editorCommands/carets";

export {
  foldSelection,
  isCommentSyntaxNodeName,
  classifyRegionMarker,
  regionFoldingProvenance,
  regionFoldingProvenanceLabel,
  detectLineFoldProvenance,
  createRegionFoldService,
  regionFoldAvailableForPath,
} from "./editorCommands/folding";

export { type RegionFoldingProvenance } from "./editorCommands/foldingTypes";

export { moveStatement, moveStatementUp, moveStatementDown, completeCurrentStatement } from "./editorCommands/statements";

export {
  occurrenceSessionField,
  selectNextEditorOccurrence,
  selectAllEditorOccurrences,
  escapeEditorSelections,
  selectionHistoryField,
  expandSyntaxSelection,
  expandSelectionFromLspRanges,
  shrinkSyntaxSelection,
  unselectOccurrence,
} from "./editorCommands/selection";

export { toggleCase, joinLines, sortLinesWithOptions, sortLines, reverseLines, transposeLines, tabJumpOut, unwrapRemove } from "./editorCommands/lines";

export { workspaceEditorKeymap } from "./editorCommands/keymap";
