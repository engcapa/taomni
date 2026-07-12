import type { Text } from "@codemirror/state";
import type { LspPosition } from "../../../lib/editor/lsp";

export function offsetFromLspPosition(doc: Text, position: LspPosition): number {
  if (doc.lines === 0) return 0;
  const lineNo = Math.min(doc.lines, Math.max(1, position.line + 1));
  const line = doc.line(lineNo);
  return Math.min(line.to, line.from + Math.max(0, position.character));
}

export function lspPositionFromOffset(doc: Text, offset: number): LspPosition {
  const line = doc.lineAt(Math.max(0, Math.min(doc.length, offset)));
  return {
    line: line.number - 1,
    character: offset - line.from,
  };
}
