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

const SENTENCE_TERMINATORS = new Set([".", "!", "?", "。", "！", "？"]);

function isWhitespaceChar(ch: string): boolean {
  return /\s/u.test(ch);
}

function isLetterChar(ch: string): boolean {
  return /\p{L}/u.test(ch);
}

/** Title Case: capitalize the first letter of every word while leaving all other characters untouched. */
export function properKeepRestText(input: string): string {
  return input.replace(
    /(^|[^\p{L}\p{N}])(\p{L})/gu,
    (_m, prefix: string, letter: string) => prefix + letter.toUpperCase(),
  );
}

/**
 * Uppercase the first letter of every sentence.
 * A sentence starts at the beginning of the text, at the beginning of every line, and after
 * `.`, `!`, `?`, `。`, `！` or `？` when the terminator is followed by whitespace.
 */
function capitalizeSentenceStarts(input: string): string {
  const chars = [...input];
  const out: string[] = [];
  let atSentenceStart = true;
  for (let index = 0; index < chars.length; index += 1) {
    const ch = chars[index];
    if (ch === "\n") {
      out.push(ch);
      atSentenceStart = true;
      continue;
    }
    if (atSentenceStart) {
      if (isWhitespaceChar(ch)) {
        out.push(ch);
      } else if (isLetterChar(ch)) {
        out.push(ch.toUpperCase());
        atSentenceStart = false;
      } else {
        // Quotes/brackets before the first letter do not end the sentence start.
        out.push(ch);
      }
      continue;
    }
    out.push(ch);
    if (SENTENCE_TERMINATORS.has(ch)) {
      const next = chars[index + 1];
      if (next !== undefined && isWhitespaceChar(next)) atSentenceStart = true;
    }
  }
  return out.join("");
}

/** Sentence case: lowercase everything, then capitalize the first letter of every sentence. */
export function sentenceText(input: string): string {
  return capitalizeSentenceStarts(input.toLowerCase());
}

/** Sentence case (blend): capitalize only the first letter of every sentence, keep the rest unchanged. */
export function sentenceKeepRestText(input: string): string {
  return capitalizeSentenceStarts(input);
}

/** Randomize the case of every letter; digits, whitespace and punctuation are left untouched. */
export function randomCaseText(input: string, rng: () => number = Math.random): string {
  return [...input]
    .map((ch) => {
      const upper = ch.toUpperCase();
      const lower = ch.toLowerCase();
      if (upper === lower) return ch;
      return rng() < 0.5 ? upper : lower;
    })
    .join("");
}

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
      return properKeepRestText(input.toLowerCase());
    case "properBlend":
      return properKeepRestText(input);
    case "sentence":
      return sentenceText(input);
    case "sentenceBlend":
      return sentenceKeepRestText(input);
    case "invert":
      return [...input]
        .map((ch) => (ch === ch.toUpperCase() && ch !== ch.toLowerCase() ? ch.toLowerCase() : ch.toUpperCase()))
        .join("");
    case "random":
      return randomCaseText(input, rng);
  }
}

/** Apply a pure string case conversion to the selected range (no-op if selection is empty). */
function applyCaseToRange(
  text: string,
  range: TextRange,
  convert: (source: string) => string,
): TextTransformResult {
  const from = Math.max(0, Math.min(range.from, text.length));
  const to = Math.max(from, Math.min(range.to, text.length));
  const lineCount = text.split("\n").length;
  if (from === to) {
    return { text, selection: range, changed: false, beforeLines: lineCount, afterLines: lineCount };
  }
  const source = text.slice(from, to);
  const converted = convert(source);
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

/** Apply case conversion to the selected range (no-op if selection is empty). */
export function convertCaseRange(
  text: string,
  range: TextRange,
  kind: NotepadCaseKind,
  rng: () => number = Math.random,
): TextTransformResult {
  return applyCaseToRange(text, range, (source) => convertCaseText(source, kind, rng));
}

/** Title Case over the selected range: capitalize first letters but keep the remaining characters as-is. */
export function properKeepRest(text: string, range: TextRange): TextTransformResult {
  return applyCaseToRange(text, range, properKeepRestText);
}

/** Sentence case over the selected range: first letter of each sentence uppercase, the rest lowercase. */
export function sentence(text: string, range: TextRange): TextTransformResult {
  return applyCaseToRange(text, range, sentenceText);
}

/** Sentence case (blend) over the selected range: uppercase sentence starts only, keep the rest as-is. */
export function sentenceKeepRest(text: string, range: TextRange): TextTransformResult {
  return applyCaseToRange(text, range, sentenceKeepRestText);
}

/** Random case over the selected range; the injected `rng` makes the result deterministic. */
export function randomCase(
  text: string,
  range: TextRange,
  rng: () => number = Math.random,
): TextTransformResult {
  return applyCaseToRange(text, range, (source) => randomCaseText(source, rng));
}
