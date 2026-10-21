import { findClusterBreak } from "@codemirror/state";


/** Width of one character at a given visual column (tabs stop-aligned). */
export function charVisualWidth(char: string, column: number, tabWidth: number): number {
  if (char === "\t") return tabWidth - (column % tabWidth);
  const code = char.codePointAt(0) ?? 0;
  const first = String.fromCodePoint(code);
  if (/^\p{Mark}$/u.test(first) || code === 0x200d) return 0;
  // Approximate double-width test: astral code points plus common wide ranges
  // (CJK, Hangul, fullwidth forms, emoji blocks).
  if (code > 0xffff || (code >= 0x1100 && (
    code <= 0x115f
    || (code >= 0x2e80 && code <= 0xa4cf)
    || (code >= 0xac00 && code <= 0xd7a3)
    || (code >= 0xf900 && code <= 0xfaff)
    || (code >= 0xfe30 && code <= 0xfe6f)
    || (code >= 0xff00 && code <= 0xff60)
    || (code >= 0xffe0 && code <= 0xffe6)
    || (code >= 0x1f300 && code <= 0x1faff)
  ))) {
    return 2;
  }
  return 1;
}


/** Visual column of a document column within one line's text. */
export function visualColumnFor(lineText: string, documentColumn: number, tabWidth: number): number {
  let column = 0;
  let index = 0;
  while (index < documentColumn && index < lineText.length) {
    const next = findClusterBreak(lineText, index, true, true);
    if (next <= index || next > documentColumn) break;
    column += charVisualWidth(lineText.slice(index, next), column, tabWidth);
    index = next;
  }
  return column;
}


/**
 * Document column within lineText that corresponds to the given target visual column.
 * Respects tab stops, CJK, and emoji double-width characters.
 */
export function documentColumnForVisualColumn(
  lineText: string,
  targetVisualColumn: number,
  tabWidth: number,
): number {
  if (targetVisualColumn <= 0) return 0;
  let visual = 0;
  let index = 0;
  while (index < lineText.length) {
    const next = findClusterBreak(lineText, index, true, true);
    if (next <= index) break;
    const width = charVisualWidth(lineText.slice(index, next), visual, tabWidth);
    if (visual + width > targetVisualColumn) {
      break;
    }
    visual += width;
    index = next;
  }
  return index;
}
