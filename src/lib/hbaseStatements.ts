/**
 * Split a block of HBase shell input into individual statements.
 *
 * The HBase shell client executes one statement per backend call, so a block
 * containing several commands has to be split before dispatch. Statements are
 * separated by newlines or `;` at the top level. Separators inside quotes
 * (`'`/`"`), option maps (`{}`), or column lists (`[]`) are ignored, and a line
 * ending in `,` or `\` continues onto the next line so a multi-line `create`
 * (e.g. `create 't',` / `{NAME => 'cf1'},` / `{NAME => 'cf2'}`) stays one
 * statement. Empty statements are dropped.
 *
 * The quote/brace/bracket/escape handling mirrors the backend `split_top_level`
 * parser (src-tauri/src/hbase/mod.rs) so splitting never breaks a statement the
 * backend would otherwise parse as a unit.
 */
export interface HBaseStatementRange {
  sql: string;
  from: number;
  to: number;
}

function trimHBaseRange(input: string, from: number, to: number): { from: number; to: number; text: string } {
  let start = from;
  let end = to;
  while (start < end && /\s/.test(input[start])) start += 1;
  while (end > start && /\s/.test(input[end - 1])) end -= 1;
  return { from: start, to: end, text: input.slice(start, end) };
}

function splitHBaseInputImpl(input: string): HBaseStatementRange[] {
  const statements: HBaseStatementRange[] = [];
  let currentStart = 0;
  let current = "";
  let single = false;
  let double = false;
  let brace = 0;
  let bracket = 0;
  let i = 0;

  const pushRange = (to: number) => {
    // `current` may collapse line-continuation newlines/backslashes into spaces
    // (matching the historical string splitter). from/to still refer to the
    // original source span so cursor-hit testing stays accurate.
    const text = current.trim();
    if (text) {
      const { from, to: trimmedTo } = trimHBaseRange(input, currentStart, to);
      statements.push({ sql: text, from, to: trimmedTo });
    }
    current = "";
  };

  while (i < input.length) {
    const ch = input[i];

    // Inside quotes: copy verbatim, honoring backslash escapes, until the
    // matching quote closes. A `\` escape keeps the next character literal so
    // an escaped quote (`\'`) does not end the string.
    if (single || double) {
      if (ch === "\\" && i + 1 < input.length) {
        current += ch + input[i + 1];
        i += 2;
        continue;
      }
      current += ch;
      if (single && ch === "'") single = false;
      else if (double && ch === '"') double = false;
      i += 1;
      continue;
    }

    if (ch === "'") {
      single = true;
      current += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      double = true;
      current += ch;
      i += 1;
      continue;
    }
    if (ch === "{") {
      brace += 1;
      current += ch;
      i += 1;
      continue;
    }
    if (ch === "}") {
      brace = Math.max(0, brace - 1);
      current += ch;
      i += 1;
      continue;
    }
    if (ch === "[") {
      bracket += 1;
      current += ch;
      i += 1;
      continue;
    }
    if (ch === "]") {
      bracket = Math.max(0, bracket - 1);
      current += ch;
      i += 1;
      continue;
    }

    const topLevel = brace === 0 && bracket === 0;

    if (topLevel && (ch === "\n" || ch === "\r")) {
      // Line continuation: a trailing comma or backslash joins the next line.
      const trimmedEnd = current.replace(/[ \t]+$/, "");
      const continuesComma = trimmedEnd.endsWith(",");
      const continuesBackslash = !continuesComma && trimmedEnd.endsWith("\\");
      if (continuesComma || continuesBackslash) {
        current = continuesBackslash
          ? trimmedEnd.slice(0, -1).replace(/[ \t]+$/, "")
          : trimmedEnd;
        i += 1;
        while (i < input.length && (input[i] === " " || input[i] === "\t")) {
          i += 1;
        }
        current += " ";
        continue;
      }
      pushRange(i);
      // skip the newline character(s)
      const newlineLen = ch === "\r" && input[i + 1] === "\n" ? 2 : 1;
      i += newlineLen;
      currentStart = i;
      continue;
    }

    if (topLevel && ch === ";") {
      pushRange(i);
      i += 1;
      currentStart = i;
      continue;
    }

    current += ch;
    i += 1;
  }

  pushRange(input.length);
  return statements;
}

export function splitHBaseStatementRanges(input: string): HBaseStatementRange[] {
  return splitHBaseInputImpl(input);
}

export function splitHBaseStatements(input: string): string[] {
  return splitHBaseInputImpl(input).map((r) => r.sql);
}

export function hbaseStatementRangeAt(input: string, position: number): HBaseStatementRange | null {
  const ranges = splitHBaseStatementRanges(input);
  if (ranges.length === 0) return null;
  const clamped = Math.max(0, Math.min(position, input.length));
  const containing = ranges.find((r) => r.from <= clamped && clamped <= r.to);
  if (containing) return containing;
  // If cursor is in whitespace between statements, return null; if only one statement, return it
  return ranges.length === 1 ? ranges[0] : null;
}
