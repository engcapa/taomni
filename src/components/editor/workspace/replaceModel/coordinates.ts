import type { WorkspaceSearchMatch } from "../../../../lib/editor/workspaceSearch";
import { type ReplaceInFilesMatch } from "./model";

/** Absolute host path for a search match (mirrors buildReplaceEdits). */
export function replaceMatchAbsolutePath(match: WorkspaceSearchMatch): string {
  return match.path
    ? `${match.rootPath.replace(/\\/g, "/").replace(/\/+$/, "")}/${match.path.replace(/^\/+/, "")}`
    : match.rootPath;
}

/**
 * ED-IMPROVE-004: the Rust search backend reports Unicode code-point offsets
 * (see workspace_search.rs char_offset), while LSP ranges and the editor use
 * UTF-16 code units. This is the single conversion used by preview,
 * navigation, freshness and commit so every consumer agrees.
 */
export function codePointOffsetToUtf16Offset(lineText: string, offset: number): number {
  const converted = codePointOffsetToUtf16OffsetChecked(lineText, offset);
  return converted ?? Math.max(0, Math.min(lineText.length, Math.trunc(offset) || 0));
}

/**
 * ED-MAIN-004: strict conversion that never silently clamps. Returns null for
 * negative, non-integer, NaN, or past-the-line code-point offsets so callers
 * can surface a reason instead of writing at a different valid position.
 */
export function codePointOffsetToUtf16OffsetChecked(
  lineText: string,
  offset: number,
): number | null {
  if (!Number.isInteger(offset) || offset < 0) return null;
  let utf16 = 0;
  let codePoints = 0;
  while (utf16 < lineText.length && codePoints < offset) {
    const code = lineText.codePointAt(utf16);
    if (code === undefined) return null;
    utf16 += code > 0xffff ? 2 : 1;
    codePoints += 1;
  }
  return codePoints === offset ? utf16 : null;
}

/**
 * Thrown when a backend search match carries illegal code-point coordinates.
 * The panel and commit owners catch it and surface a zero-commit reason.
 */
export class InvalidSearchMatchCoordinatesError extends Error {
  readonly path: string;

  constructor(path: string, lineNumber: number, offset: number) {
    const detail = (!Number.isInteger(lineNumber) || lineNumber < 1)
      ? `an invalid line number ${lineNumber}`
      : `an invalid offset ${offset}`;
    super(`Search match at ${path}:${lineNumber} has ${detail}; replace refused`);
    this.name = "InvalidSearchMatchCoordinatesError";
    this.path = path;
  }
}

/**
 * ED-FIND-004 / ED-REPAIR-003: shared search-match mapping used by the preview
 * dialog owner and the commit owner so both sides agree on file paths, ranges,
 * and the matched text the freshness recheck compares against disk. Validates
 * that lineNumber is a positive integer and code-point offsets are valid.
 */
export function searchMatchesToReplaceInputs(matches: readonly WorkspaceSearchMatch[]): ReplaceInFilesMatch[] {
  return matches.map((match) => {
    const absolute = replaceMatchAbsolutePath(match);
    if (!Number.isInteger(match.lineNumber) || match.lineNumber < 1) {
      throw new InvalidSearchMatchCoordinatesError(absolute, match.lineNumber, match.matchStart);
    }
    const line = match.lineNumber - 1;
    // ED-MAIN-004: validate the raw code-point offsets before conversion. A
    // negative/fractional/NaN/past-the-line/reversed match must not be clamped
    // into a different valid range.
    const startCharacter = codePointOffsetToUtf16OffsetChecked(match.lineText, match.matchStart);
    const endCharacter = codePointOffsetToUtf16OffsetChecked(match.lineText, match.matchEnd);
    if (
      startCharacter === null
      || endCharacter === null
      || endCharacter < startCharacter
    ) {
      const badOffset = startCharacter === null ? match.matchStart : match.matchEnd;
      throw new InvalidSearchMatchCoordinatesError(absolute, match.lineNumber, badOffset);
    }
    return {
      filePath: absolute,
      fileUri: `file://${absolute}`,
      startLine: line,
      startCharacter,
      endLine: line,
      endCharacter,
      matchedText: match.lineText.slice(startCharacter, endCharacter),
    };
  });
}
