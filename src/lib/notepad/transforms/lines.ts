export interface TextRange {
  from: number;
  to: number;
}

export interface TextTransformResult {
  text: string;
  selection: TextRange;
  changed: boolean;
  beforeLines: number;
  afterLines: number;
}

export interface LineSpan {
  from: number;
  to: number;
  lines: string[];
  wholeDocument: boolean;
}

/** Return 0-based start offsets for each LF-delimited line in `text`. */
export function getLineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) starts.push(i + 1);
  }
  return starts;
}

/** Return 0-based line index for character offset `pos`. */
export function lineIndexAt(text: string, pos: number): number {
  const clamped = Math.max(0, Math.min(pos, text.length));
  let line = 0;
  for (let i = 0; i < clamped; i += 1) {
    if (text.charCodeAt(i) === 10) line += 1;
  }
  return line;
}

/** Resolve the full-line span covering `range`, or the whole document when empty and `wholeIfEmpty` is true. */
export function resolveLineSpan(text: string, range: TextRange, wholeIfEmpty: boolean): LineSpan {
  const from = Math.max(0, Math.min(range.from, text.length));
  const to = Math.max(from, Math.min(range.to, text.length));
  if (from === to && wholeIfEmpty) {
    return {
      from: 0,
      to: text.length,
      lines: text.split("\n"),
      wholeDocument: true,
    };
  }
  const lineStart = text.lastIndexOf("\n", from - 1) + 1;
  const effectiveTo = to > from && text[to - 1] === "\n" ? to - 1 : to;
  let lineEnd = text.indexOf("\n", effectiveTo);
  if (lineEnd < 0) lineEnd = text.length;
  return {
    from: lineStart,
    to: lineEnd,
    lines: text.slice(lineStart, lineEnd).split("\n"),
    wholeDocument: false,
  };
}

/** Apply a pure array-of-lines transform over the resolved span. */
export function applyLineTransform(
  text: string,
  range: TextRange,
  wholeIfEmpty: boolean,
  transform: (lines: string[]) => string[] | null,
): TextTransformResult {
  const span = resolveLineSpan(text, range, wholeIfEmpty);
  const out = transform(span.lines);
  if (out === null) {
    return {
      text,
      selection: range,
      changed: false,
      beforeLines: span.lines.length,
      afterLines: span.lines.length,
    };
  }
  const segment = out.join("\n");
  const existing = text.slice(span.from, span.to);
  if (segment === existing) {
    return {
      text,
      selection: { from: span.from, to: span.from + segment.length },
      changed: false,
      beforeLines: span.lines.length,
      afterLines: out.length,
    };
  }
  const nextText = text.slice(0, span.from) + segment + text.slice(span.to);
  return {
    text: nextText,
    selection: { from: span.from, to: span.from + segment.length },
    changed: true,
    beforeLines: span.lines.length,
    afterLines: out.length,
  };
}

/** Duplicate the current line or all lines intersected by the selection. */
export function duplicateLine(text: string, range: TextRange): TextTransformResult {
  const span = resolveLineSpan(text, range, false);
  const segment = text.slice(span.from, span.to);
  const insert = `\n${segment}`;
  const nextText = text.slice(0, span.to) + insert + text.slice(span.to);
  const newFrom = span.to + 1;
  return {
    text: nextText,
    selection: { from: newFrom, to: newFrom + segment.length },
    changed: true,
    beforeLines: span.lines.length,
    afterLines: span.lines.length * 2,
  };
}

/** Move the selected lines (or current line) one line up or down. */
export function moveSelectedLines(text: string, range: TextRange, direction: -1 | 1): TextTransformResult {
  const span = resolveLineSpan(text, range, false);
  const totalLines = text.split("\n").length;
  if (direction < 0) {
    if (span.from === 0) {
      return { text, selection: range, changed: false, beforeLines: span.lines.length, afterLines: span.lines.length };
    }
    const prevStart = text.lastIndexOf("\n", span.from - 2) + 1;
    const prevLine = text.slice(prevStart, span.from - 1);
    const curSegment = text.slice(span.from, span.to);
    const replaced = `${curSegment}\n${prevLine}`;
    const nextText = text.slice(0, prevStart) + replaced + text.slice(span.to);
    return {
      text: nextText,
      selection: { from: prevStart, to: prevStart + curSegment.length },
      changed: true,
      beforeLines: span.lines.length,
      afterLines: span.lines.length,
    };
  }
  if (span.to >= text.length) {
    return { text, selection: range, changed: false, beforeLines: totalLines, afterLines: totalLines };
  }
  let nextEnd = text.indexOf("\n", span.to + 1);
  if (nextEnd < 0) nextEnd = text.length;
  const curSegment = text.slice(span.from, span.to);
  const nextLine = text.slice(span.to + 1, nextEnd);
  const replaced = `${nextLine}\n${curSegment}`;
  const nextText = text.slice(0, span.from) + replaced + text.slice(nextEnd);
  const newFrom = span.from + nextLine.length + 1;
  return {
    text: nextText,
    selection: { from: newFrom, to: newFrom + curSegment.length },
    changed: true,
    beforeLines: span.lines.length,
    afterLines: span.lines.length,
  };
}

/** Join selected lines (or current + next line when empty) with single space separating trimmed continuations. */
export function joinLines(text: string, range: TextRange): TextTransformResult {
  const from = Math.max(0, Math.min(range.from, text.length));
  const to = Math.max(from, Math.min(range.to, text.length));
  let span = resolveLineSpan(text, { from, to }, false);
  if (from === to || span.lines.length === 1) {
    if (span.to >= text.length) {
      return { text, selection: range, changed: false, beforeLines: 1, afterLines: 1 };
    }
    let nextEnd = text.indexOf("\n", span.to + 1);
    if (nextEnd < 0) nextEnd = text.length;
    span = {
      from: span.from,
      to: nextEnd,
      lines: text.slice(span.from, nextEnd).split("\n"),
      wholeDocument: false,
    };
  }
  const joined = span.lines
    .map((line, index) => (index === 0 ? line.replace(/[ \t]+$/, "") : line.trimStart()))
    .filter((line, index, arr) => index === 0 || line.length > 0 || index < arr.length - 1)
    .join(" ")
    .replace(/ +$/g, "");
  const nextText = text.slice(0, span.from) + joined + text.slice(span.to);
  return {
    text: nextText,
    selection: { from: span.from, to: span.from + joined.length },
    changed: nextText !== text,
    beforeLines: span.lines.length,
    afterLines: 1,
  };
}

/** Split lines exceeding `columnWidth` cleanly into segments of at most `columnWidth` characters. */
export function splitLinesAtColumn(
  text: string,
  range: TextRange,
  columnWidth: number,
  wholeIfEmpty = true,
): TextTransformResult {
  const width = Math.max(1, Math.floor(columnWidth));
  return applyLineTransform(text, range, wholeIfEmpty, (lines) =>
    lines.flatMap((line) => {
      if (line.length <= width) return [line];
      const parts: string[] = [];
      let rest = line;
      while (rest.length > width) {
        const spaceBreak = rest.lastIndexOf(" ", width);
        const cut = spaceBreak > 0 ? spaceBreak : width;
        parts.push(rest.slice(0, cut).replace(/[ \t]+$/, ""));
        rest = rest.slice(cut).replace(/^[ \t]+/, "");
      }
      if (rest.length > 0 || parts.length === 0) parts.push(rest);
      return parts;
    }),
  );
}

export function insertBlankLineAbove(text: string, range: TextRange): TextTransformResult {
  const span = resolveLineSpan(text, range, false);
  const nextText = `${text.slice(0, span.from)}\n${text.slice(span.from)}`;
  return {
    text: nextText,
    selection: { from: span.from, to: span.from },
    changed: true,
    beforeLines: span.lines.length,
    afterLines: span.lines.length + 1,
  };
}

export function insertBlankLineBelow(text: string, range: TextRange): TextTransformResult {
  const span = resolveLineSpan(text, range, false);
  const nextText = `${text.slice(0, span.to)}\n${text.slice(span.to)}`;
  const caret = span.to + 1;
  return {
    text: nextText,
    selection: { from: caret, to: caret },
    changed: true,
    beforeLines: span.lines.length,
    afterLines: span.lines.length + 1,
  };
}

export function dedupeLinesList(lines: string[]): string[] {
  const seen = new Set<string>();
  return lines.filter((line) => {
    if (seen.has(line)) return false;
    seen.add(line);
    return true;
  });
}

export function dedupeAdjacentLinesList(lines: string[]): string[] {
  return lines.filter((line, index) => index === 0 || line !== lines[index - 1]);
}

export function removeEmptyLinesList(lines: string[]): string[] {
  return lines.filter((line) => line !== "");
}

export function removeBlankLinesList(lines: string[]): string[] {
  return lines.filter((line) => line.trim() !== "");
}

export function reverseLinesList(lines: string[]): string[] {
  return [...lines].reverse();
}

export function shuffleLinesList(lines: string[], rng: () => number = Math.random): string[] {
  const copy = [...lines];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

/**
 * Fisher-Yates shuffle of a resolved line span. A trailing empty element only means
 * "segment ends with a newline", so it stays at the end instead of being shuffled into the body.
 */
function shuffleSpanLines(lines: string[], rng: () => number): string[] {
  const hasTrailingNewline = lines.length > 1 && lines[lines.length - 1] === "";
  const body = hasTrailingNewline ? lines.slice(0, -1) : lines;
  const shuffled = shuffleLinesList(body, rng);
  return hasTrailingNewline ? [...shuffled, ""] : shuffled;
}

export const dedupeLines = (text: string, range: TextRange, wholeIfEmpty = true) =>
  applyLineTransform(text, range, wholeIfEmpty, dedupeLinesList);

export const dedupeAdjacentLines = (text: string, range: TextRange, wholeIfEmpty = true) =>
  applyLineTransform(text, range, wholeIfEmpty, dedupeAdjacentLinesList);

export const removeEmptyLines = (text: string, range: TextRange, wholeIfEmpty = true) =>
  applyLineTransform(text, range, wholeIfEmpty, removeEmptyLinesList);

export const removeBlankLines = (text: string, range: TextRange, wholeIfEmpty = true) =>
  applyLineTransform(text, range, wholeIfEmpty, removeBlankLinesList);

export const reverseLines = (text: string, range: TextRange, wholeIfEmpty = true) =>
  applyLineTransform(text, range, wholeIfEmpty, reverseLinesList);

export function shuffleLines(
  text: string,
  range: TextRange,
  wholeIfEmpty?: boolean,
  rng?: () => number,
): TextTransformResult;
export function shuffleLines(text: string, range: TextRange, rng: () => number): TextTransformResult;
export function shuffleLines(
  text: string,
  range: TextRange,
  wholeIfEmptyOrRng: boolean | (() => number) = true,
  rng: () => number = Math.random,
): TextTransformResult {
  const wholeIfEmpty = typeof wholeIfEmptyOrRng === "boolean" ? wholeIfEmptyOrRng : true;
  const random = typeof wholeIfEmptyOrRng === "function" ? wholeIfEmptyOrRng : rng;
  return applyLineTransform(text, range, wholeIfEmpty, (lines) => shuffleSpanLines(lines, random));
}
