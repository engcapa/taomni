import { applyLineTransform, type TextRange, type TextTransformResult } from "./lines";

export type NotepadSortKind = "lex" | "ci" | "loc" | "int" | "dc" | "dd" | "len";

export interface SortOptions {
  kind: NotepadSortKind;
  descending?: boolean;
  locale?: string;
  /** Optional 0-based column slice [startCol, endCol) for rectangular/column-key sorting. */
  columnRange?: { start: number; end: number };
}

/** Options shared by the fixed-key sort helpers (key and direction are implied by the helper name). */
export interface SortRangeOptions {
  /** Explicit collation locale for the locale-aware helpers; keeps results independent of the host locale. */
  locale?: string;
  /** Optional 0-based column slice [startCol, endCol) for rectangular/column-key sorting. */
  columnRange?: { start: number; end: number };
  /** Sort the whole document when the selection is empty. Defaults to true. */
  wholeIfEmpty?: boolean;
}

/**
 * Parse a complete line as a decimal number for the given decimal separator.
 * Outer whitespace is tolerated, unambiguous thousands separators are ignored, and
 * anything that is not a full number yields `null` (so callers can sort it last).
 */
function parseFormattedDecimal(value: string, decimalSeparator: "," | "."): number | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  let body = trimmed;
  let negative = false;
  if (body.startsWith("+") || body.startsWith("-")) {
    negative = body.startsWith("-");
    body = body.slice(1);
  }
  if (body.length === 0) return null;
  const thousandsSeparator = decimalSeparator === "," ? "." : ",";
  const decimalIndex = body.lastIndexOf(decimalSeparator);
  // More than one decimal mark is ambiguous (it could be a thousands separator), so treat it as invalid.
  if (decimalIndex >= 0 && body.indexOf(decimalSeparator) !== decimalIndex) return null;
  let integerDigits: string;
  let fractionDigits: string | null = null;
  if (decimalIndex >= 0) {
    integerDigits = body.slice(0, decimalIndex);
    fractionDigits = body.slice(decimalIndex + 1);
    if (fractionDigits.length === 0 || !/^\d+$/.test(fractionDigits)) return null;
  } else {
    integerDigits = body;
  }
  if (integerDigits.length === 0) {
    if (fractionDigits === null) return null;
    integerDigits = "0";
  } else if (integerDigits.includes(thousandsSeparator)) {
    const groups = integerDigits.split(thousandsSeparator);
    if (!/^\d{1,3}$/.test(groups[0])) return null;
    if (groups.slice(1).some((group) => !/^\d{3}$/.test(group))) return null;
    integerDigits = groups.join("");
  } else if (!/^\d+$/.test(integerDigits)) {
    return null;
  }
  const parsed = Number(`${negative ? "-" : ""}${integerDigits}${fractionDigits === null ? "" : `.${fractionDigits}`}`);
  return Number.isFinite(parsed) ? parsed : null;
}

function extractDecimalComma(value: string): number | null {
  return parseFormattedDecimal(value, ",");
}

function extractDecimalDot(value: string): number | null {
  return parseFormattedDecimal(value, ".");
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
      case "dd":
        // Decimal keys need nullable parsing, so they are compared in the sort callback below.
        return 0;
      case "len":
        return a.length - b.length;
    }
  };

  indexed.sort((a, b) => {
    if (options.kind === "dc" || options.kind === "dd") {
      const extract = options.kind === "dc" ? extractDecimalComma : extractDecimalDot;
      const left = extract(a.key);
      const right = extract(b.key);
      // Invalid/ambiguous values always sort last, in both directions (never reversed by `dir`).
      if (left === null && right === null) return a.index - b.index;
      if (left === null) return 1;
      if (right === null) return -1;
      const cmp = left === right ? 0 : left < right ? -1 : 1;
      if (cmp !== 0) return dir * cmp;
      return a.index - b.index;
    }
    const cmp = compareKeys(a.key, b.key);
    if (cmp !== 0) return dir * cmp;
    // Preserve the original order for equal keys (stable in both directions).
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

function sortWithKind(kind: NotepadSortKind, descending: boolean) {
  return (text: string, range: TextRange, options: SortRangeOptions = {}): TextTransformResult =>
    sortLines(
      text,
      range,
      { kind, descending, locale: options.locale, columnRange: options.columnRange },
      options.wholeIfEmpty ?? true,
    );
}

/** Sort lines lexicographically (code-unit order), ascending. */
export const sortLexAsc = sortWithKind("lex", false);
/** Sort lines lexicographically (code-unit order), descending. */
export const sortLexDesc = sortWithKind("lex", true);
/** Sort lines ignoring case, ascending. */
export const sortCiAsc = sortWithKind("ci", false);
/** Sort lines ignoring case, descending. */
export const sortCiDesc = sortWithKind("ci", true);
/** Sort lines with `Intl.Collator` (locale-aware), ascending. */
export const sortLocaleAsc = sortWithKind("loc", false);
/** Sort lines with `Intl.Collator` (locale-aware), descending. */
export const sortLocaleDesc = sortWithKind("loc", true);
/** Sort lines as integers, ascending. */
export const sortIntAsc = sortWithKind("int", false);
/** Sort lines as integers, descending. */
export const sortIntDesc = sortWithKind("int", true);
/** Sort lines as decimal numbers with comma decimal marks, ascending; invalid values sort last. */
export const sortDecimalCommaAsc = sortWithKind("dc", false);
/** Sort lines as decimal numbers with comma decimal marks, descending; invalid values sort last. */
export const sortDecimalCommaDesc = sortWithKind("dc", true);
/** Sort lines as decimal numbers with dot decimal marks, ascending; invalid values sort last. */
export const sortDecimalDotAsc = sortWithKind("dd", false);
/** Sort lines as decimal numbers with dot decimal marks, descending; invalid values sort last. */
export const sortDecimalDotDesc = sortWithKind("dd", true);
/** Sort lines by length, ascending. */
export const sortLengthAsc = sortWithKind("len", false);
/** Sort lines by length, descending. */
export const sortLengthDesc = sortWithKind("len", true);
