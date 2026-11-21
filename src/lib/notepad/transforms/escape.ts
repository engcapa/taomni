export type NotepadSearchMode = "normal" | "ext" | "re";

export interface SearchPatternOptions {
  query: string;
  mode: NotepadSearchMode;
  caseSensitive: boolean;
  wholeWord: boolean;
  dotAll: boolean;
}

/** Unescape Notepad++ Extended search/replace sequences (\n, \r, \t, \0, \xNN, \uNNNN, \\). */
export function unescapeExtended(input: string): string {
  return input.replace(/\\(n|r|t|0|b|f|x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}|\\)/g, (_m, token: string) => {
    switch (token[0]) {
      case "n":
        return "\n";
      case "r":
        return "\r";
      case "t":
        return "\t";
      case "0":
        return "\0";
      case "b":
        return "\b";
      case "f":
        return "\f";
      case "\\":
        return "\\";
      case "x":
      case "u":
        return String.fromCharCode(Number.parseInt(token.slice(1), 16));
      default:
        return token;
    }
  });
}

export function escapeRegExpLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Expand replacement template for Normal, Extended, or Regex mode ($1 / ${1} supported). */
export function resolveReplacementText(replacement: string, mode: NotepadSearchMode): string {
  if (mode === "ext") return unescapeExtended(replacement);
  if (mode === "re") {
    return replacement.replace(/\\(n|r|t|0|\\)/g, (_m, c: string) =>
      c === "n" ? "\n" : c === "r" ? "\r" : c === "t" ? "\t" : c === "0" ? "\0" : "\\",
    );
  }
  return replacement;
}

/** Compile a RegExp for Notepad search; throws descriptive error on invalid regex. */
export function buildSearchRegExp(options: SearchPatternOptions, global = true): RegExp | null {
  if (!options.query) return null;
  let source = options.query;
  if (options.mode === "ext") {
    source = escapeRegExpLiteral(unescapeExtended(source));
  } else if (options.mode === "normal") {
    source = escapeRegExpLiteral(source);
  }
  if (options.wholeWord) {
    source = `\\b(?:${source})\\b`;
  }
  const flags = `${global ? "g" : ""}${options.caseSensitive ? "" : "i"}m${options.dotAll && options.mode === "re" ? "s" : ""}`;
  return new RegExp(source, flags);
}

/** Validate regex syntax without throwing; returns null if valid or error message otherwise. */
export function validateSearchPattern(options: SearchPatternOptions): string | null {
  if (!options.query) return null;
  try {
    buildSearchRegExp(options, true);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}
