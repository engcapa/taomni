import type { LspPosition, LspRange, LspTextEdit } from "../../../lib/editor/lsp";

/** Convert a 0-based LSP position into a string offset for `\n`-normalized text. */
export function offsetFromLspPositionInString(text: string, position: LspPosition): number {
  const lines = text.split("\n");
  if (lines.length === 0) return 0;
  const lineIndex = Math.min(lines.length - 1, Math.max(0, position.line));
  let offset = 0;
  for (let i = 0; i < lineIndex; i += 1) {
    offset += lines[i].length + 1;
  }
  const line = lines[lineIndex] ?? "";
  return offset + Math.min(line.length, Math.max(0, position.character));
}

/**
 * Apply LSP TextEdits to a document string.
 * Edits are applied from the end of the document to the start so earlier
 * offsets stay valid (standard client strategy for non-overlapping edits).
 */
export function applyLspTextEditsToString(text: string, edits: readonly LspTextEdit[]): string {
  if (!edits.length) return text;
  const ordered = [...edits].sort((a, b) => {
    const aStart = offsetFromLspPositionInString(text, a.range.start);
    const bStart = offsetFromLspPositionInString(text, b.range.start);
    if (aStart !== bStart) return bStart - aStart;
    const aEnd = offsetFromLspPositionInString(text, a.range.end);
    const bEnd = offsetFromLspPositionInString(text, b.range.end);
    return bEnd - aEnd;
  });
  let next = text;
  for (const edit of ordered) {
    const from = offsetFromLspPositionInString(next, edit.range.start);
    const to = offsetFromLspPositionInString(next, edit.range.end);
    next = next.slice(0, from) + edit.newText + next.slice(to);
  }
  return next;
}

export function rangeIsEmpty(range: LspRange): boolean {
  return range.start.line === range.end.line && range.start.character === range.end.character;
}
