import { applyLineTransform, type TextRange, type TextTransformResult } from "./lines";

export type NotepadSortKind = "lex" | "ci" | "loc" | "int" | "dc" | "dd" | "len";

export interface SortOptions {
  kind: NotepadSortKind;
  descending?: boolean;
  locale?: string;
  /** Optional 0-based column slice [startCol, endCol) for rectangular/column-key sorting. */
  columnRange?: { start: number; end: number };
}

function extractDecimalComma(value: string): number {
  const match = value.match(/-?(?:\d{1,3}(?:\.\d{3})+|\d+)(?:,\d+)?|-?,\d+/);
  if (!match) return 0;
  let token = match[0];
  if (token.includes(",")) {
    token = token.replace(/\./g, "").replace(",", ".");
  }
  const parsed = Number.parseFloat(token);
  return Number.isFinite(parsed) ? parsed : 0;
}

function extractDecimalDot(value: string): number {
  const match = value.match(/-?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?|-?\.\d+/);
  if (!match) return 0;
  const token = match[0].replace(/,/g, "");
  const parsed = Number.parseFloat(token);
  return Number.isFinite(parsed) ? parsed : 0;
}

function extractInteger(value: string): number {
  const match = value.match(/-?\d+/);
  if (!match) return 0;
  const parsed = Number.parseInt(match[0], 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function keySlice(line: string, columnRange?: { start: number; end: number }): string {
  if (!columnRange) return line;
  const start = Math.max(0, columnRange.start);
  const end = Math.max(start, columnRange.end);
  return line.slice(start, end);
}

/** Stable sort over an array of lines across 7 Notepad++ sort modes. */
export function sortLinesList(lines: string[], options: SortOptions): string[] {
  const dir = options.descending ? -1 : 1;
  const collator = options.kind === "loc" ? new Intl.Collator(options.locale ?? "zh") : null;
  const indexed = lines.map((line, index) => ({
    line,
    index,
    key: keySlice(line, options.columnRange),
  }));

  const compareKeys = (a: string, b: string): number => {
    switch (options.kind) {
      case "lex":
        return a < b ? -1 : a > b ? 1 : 0;
      case "ci": {
        const la = a.toLowerCase();
        const lb = b.toLowerCase();
        return la < lb ? -1 : la > lb ? 1 : 0;
      }
      case "loc":
        return collator!.compare(a, b);
      case "int":
        return extractInteger(a) - extractInteger(b);
      case "dc":
        return extractDecimalComma(a) - extractDecimalComma(b);
      case "dd":
        return extractDecimalDot(a) - extractDecimalDot(b);
      case "len":
        return a.length - b.length;
    }
  };

  indexed.sort((a, b) => {
    const cmp = compareKeys(a.key, b.key);
    if (cmp !== 0) return dir * cmp;
    return a.index - b.index;
  });

  return indexed.map((entry) => entry.line);
}

/** Pure text+range wrapper for line sorting. */
export function sortLines(
  text: string,
  range: TextRange,
  options: SortOptions,
  wholeIfEmpty = true,
): TextTransformResult {
  return applyLineTransform(text, range, wholeIfEmpty, (lines) => sortLinesList(lines, options));
}
