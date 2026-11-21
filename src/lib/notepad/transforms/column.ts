import { getLineStarts, lineIndexAt, type TextRange, type TextTransformResult } from "./lines";

export type ColumnNumberRadix = 10 | 16 | 8 | 2;

export type ColumnInsertSpec =
  | { mode: "text"; text: string }
  | {
      mode: "number";
      initial: number;
      increment: number;
      repeat: number;
      radix: ColumnNumberRadix;
      leadingZeros: boolean;
      width?: number;
      uppercase?: boolean;
    };

/** Generate the formatted string for the `index`-th inserted row (0-based). */
export function formatColumnCell(spec: ColumnInsertSpec, index: number, totalRows: number): string {
  if (spec.mode === "text") return spec.text;
  const repeat = Math.max(1, Math.floor(spec.repeat));
  const stepIndex = Math.floor(index / repeat);
  const rawValue = Math.trunc(spec.initial) + Math.trunc(spec.increment) * stepIndex;
  const negative = rawValue < 0;
  const absDigits = Math.abs(rawValue).toString(spec.radix);
  const cased = spec.uppercase === false ? absDigits : absDigits.toUpperCase();
  if (!spec.leadingZeros) {
    return negative ? `-${cased}` : cased;
  }
  const maxStepIndex = Math.floor(Math.max(0, totalRows - 1) / repeat);
  const maxAbs = Math.max(Math.abs(Math.trunc(spec.initial)), Math.abs(Math.trunc(spec.initial) + Math.trunc(spec.increment) * maxStepIndex));
  const autoWidth = Math.max(3, maxAbs.toString(spec.radix).length);
  const padWidth = Math.max(1, spec.width ?? autoWidth);
  const padded = cased.padStart(padWidth, "0");
  return negative ? `-${padded}` : padded;
}

/** Generate `count` preview values for Column Editor UI. */
export function previewColumnCells(spec: ColumnInsertSpec, count = 4): string[] {
  return Array.from({ length: count }, (_, idx) => formatColumnCell(spec, idx, count));
}

/** Insert text or sequence into each spanned line at the starting column (or rectangular selection ranges). */
export function applyColumnInsert(
  text: string,
  range: TextRange,
  spec: ColumnInsertSpec,
): TextTransformResult {
  const from = Math.max(0, Math.min(range.from, text.length));
  const to = Math.max(from, Math.min(range.to, text.length));
  const starts = getLineStarts(text);
  const lines = text.split("\n");
  const startLine = lineIndexAt(text, from);
  let endLine = lineIndexAt(text, to);
  if (to > from && text[to - 1] === "\n" && endLine > startLine) {
    endLine -= 1;
  }
  const column = from - starts[startLine];
  const rowCount = endLine - startLine + 1;

  const updatedSlice: string[] = [];
  for (let i = startLine; i <= endLine; i += 1) {
    const line = lines[i];
    const cell = formatColumnCell(spec, i - startLine, rowCount);
    const paddedPrefix = line.length < column ? line + " ".repeat(column - line.length) : line.slice(0, column);
    const suffix = line.slice(column);
    updatedSlice.push(paddedPrefix + cell + suffix);
  }

  const replaceFrom = starts[startLine];
  const replaceTo = starts[endLine] + lines[endLine].length;
  const joined = updatedSlice.join("\n");
  const nextText = text.slice(0, replaceFrom) + joined + text.slice(replaceTo);
  return {
    text: nextText,
    selection: { from: replaceFrom, to: replaceFrom + joined.length },
    changed: nextText !== text,
    beforeLines: rowCount,
    afterLines: rowCount,
  };
}
