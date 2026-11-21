import type { TextRange, TextTransformResult } from "./lines";

export type NotepadCaseKind =
  | "upper"
  | "lower"
  | "proper"
  | "properBlend"
  | "sentence"
  | "sentenceBlend"
  | "invert"
  | "random";

/** Convert `input` string using one of the 8 Notepad++ case modes. */
export function convertCaseText(
  input: string,
  kind: NotepadCaseKind,
  rng: () => number = Math.random,
): string {
  switch (kind) {
    case "upper":
      return input.toUpperCase();
    case "lower":
      return input.toLowerCase();
    case "proper":
      return input
        .toLowerCase()
        .replace(/(^|[^\p{L}\p{N}])(\p{L})/gu, (_m, prefix: string, letter: string) => prefix + letter.toUpperCase());
    case "properBlend":
      return input.replace(
        /(^|[^\p{L}\p{N}])(\p{L})/gu,
        (_m, prefix: string, letter: string) => prefix + letter.toUpperCase(),
      );
    case "sentence":
      return input
        .toLowerCase()
        .replace(/(^\s*|[.!?。！？]\s+)(\p{L})/gu, (_m, prefix: string, letter: string) => prefix + letter.toUpperCase());
    case "sentenceBlend":
      return input.replace(
        /(^\s*|[.!?。！？]\s+)(\p{L})/gu,
        (_m, prefix: string, letter: string) => prefix + letter.toUpperCase(),
      );
    case "invert":
      return [...input]
        .map((ch) => (ch === ch.toUpperCase() && ch !== ch.toLowerCase() ? ch.toLowerCase() : ch.toUpperCase()))
        .join("");
    case "random":
      return [...input]
        .map((ch) => (rng() < 0.5 ? ch.toUpperCase() : ch.toLowerCase()))
        .join("");
  }
}

/** Apply case conversion to the selected range (no-op if selection is empty). */
export function convertCaseRange(
  text: string,
  range: TextRange,
  kind: NotepadCaseKind,
  rng: () => number = Math.random,
): TextTransformResult {
  const from = Math.max(0, Math.min(range.from, text.length));
  const to = Math.max(from, Math.min(range.to, text.length));
  const lineCount = text.split("\n").length;
  if (from === to) {
    return { text, selection: range, changed: false, beforeLines: lineCount, afterLines: lineCount };
  }
  const source = text.slice(from, to);
  const converted = convertCaseText(source, kind, rng);
  if (converted === source) {
    return {
      text,
      selection: { from, to },
      changed: false,
      beforeLines: lineCount,
      afterLines: lineCount,
    };
  }
  const nextText = text.slice(0, from) + converted + text.slice(to);
  return {
    text: nextText,
    selection: { from, to: from + converted.length },
    changed: true,
    beforeLines: lineCount,
    afterLines: lineCount,
  };
}
