import { EditorSelection, type ChangeSpec, type SelectionRange } from "@codemirror/state";

export type CommandOutcome = "applied" | "unavailable" | "readOnly" | "noSelection" | "cancelled";

export type ClipboardSourceEol = "lf" | "crlf" | "cr";

export interface EditorClipboardPayload {
  plainText: string;
  segments?: string[];
  sourceEol: ClipboardSourceEol;
  rectangular: boolean;
}

export interface NormalizedEditorSelection {
  ranges: readonly SelectionRange[];
  mainIndex: number;
}

export interface MultiCaretPastePlan {
  changes: readonly ChangeSpec[];
  selection: EditorSelection;
}

export interface EditorVirtualSpacePolicy {
  afterLineEnd: boolean;
  atFileBottom: boolean;
}

export interface SortLinesOptions {
  descending?: boolean;
  caseSensitive?: boolean;
  natural?: boolean;
}
