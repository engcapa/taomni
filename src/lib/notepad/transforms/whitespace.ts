import { applyLineTransform, type TextRange, type TextTransformResult } from "./lines";

export function trimTrailingSpacesList(lines: string[]): string[] {
  return lines.map((line) => line.replace(/[ \t]+$/, ""));
}

export function trimLeadingSpacesList(lines: string[]): string[] {
  return lines.map((line) => line.replace(/^[ \t]+/, ""));
}

export function trimBothSpacesList(lines: string[]): string[] {
  return lines.map((line) => line.replace(/^[ \t]+|[ \t]+$/g, ""));
}

export function tabsToSpacesList(lines: string[], tabWidth = 4): string[] {
  const width = Math.max(1, Math.floor(tabWidth));
  return lines.map((line) => {
    let out = "";
    let col = 0;
    for (const ch of line) {
      if (ch === "\t") {
        const spaces = width - (col % width);
        out += " ".repeat(spaces);
        col += spaces;
      } else {
        out += ch;
        col += 1;
      }
    }
    return out;
  });
}

export function spacesToTabsAllList(lines: string[], tabWidth = 4): string[] {
  const width = Math.max(1, Math.floor(tabWidth));
  const pattern = new RegExp(` {${width}}`, "g");
  return lines.map((line) => line.replace(pattern, "\t"));
}

export function spacesToTabsLeadingList(lines: string[], tabWidth = 4): string[] {
  const width = Math.max(1, Math.floor(tabWidth));
  const pattern = new RegExp(`^( {${width}})+`);
  return lines.map((line) => line.replace(pattern, (match) => "\t".repeat(match.length / width)));
}

export const trimTrailingSpaces = (text: string, range: TextRange, wholeIfEmpty = true) =>
  applyLineTransform(text, range, wholeIfEmpty, trimTrailingSpacesList);

export const trimLeadingSpaces = (text: string, range: TextRange, wholeIfEmpty = true) =>
  applyLineTransform(text, range, wholeIfEmpty, trimLeadingSpacesList);

export const trimBothSpaces = (text: string, range: TextRange, wholeIfEmpty = true) =>
  applyLineTransform(text, range, wholeIfEmpty, trimBothSpacesList);

export const tabsToSpaces = (text: string, range: TextRange, tabWidth = 4, wholeIfEmpty = true) =>
  applyLineTransform(text, range, wholeIfEmpty, (lines) => tabsToSpacesList(lines, tabWidth));

export const spacesToTabsAll = (text: string, range: TextRange, tabWidth = 4, wholeIfEmpty = true) =>
  applyLineTransform(text, range, wholeIfEmpty, (lines) => spacesToTabsAllList(lines, tabWidth));

export const spacesToTabsLeading = (text: string, range: TextRange, tabWidth = 4, wholeIfEmpty = true) =>
  applyLineTransform(text, range, wholeIfEmpty, (lines) => spacesToTabsLeadingList(lines, tabWidth));

/** Convert EOL sequences inside selection (or whole doc if empty) to single spaces. */
export function eolToSpace(text: string, range: TextRange, trimBeforeJoin = true): TextTransformResult {
  const from = Math.max(0, Math.min(range.from, text.length));
  const to = Math.max(from, Math.min(range.to, text.length));
  const targetFrom = from === to ? 0 : from;
  const targetTo = from === to ? text.length : to;
  const segment = text.slice(targetFrom, targetTo);
  const replaced = trimBeforeJoin
    ? segment.replace(/[ \t]*\r?\n[ \t]*/g, " ")
    : segment.replace(/\r?\n/g, " ");
  const beforeLines = segment.split("\n").length;
  if (replaced === segment) {
    return {
      text,
      selection: { from: targetFrom, to: targetFrom + replaced.length },
      changed: false,
      beforeLines,
      afterLines: 1,
    };
  }
  const nextText = text.slice(0, targetFrom) + replaced + text.slice(targetTo);
  return {
    text: nextText,
    selection: { from: targetFrom, to: targetFrom + replaced.length },
    changed: true,
    beforeLines,
    afterLines: 1,
  };
}
