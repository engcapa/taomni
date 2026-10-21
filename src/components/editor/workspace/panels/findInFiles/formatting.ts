import { type WorkspaceSearchMatch } from "../../../../../lib/editor/workspaceSearch";
import { codePointOffsetToUtf16Offset, replaceMatchAbsolutePath, type ReplacePreviewSnapshot } from "../../replaceInFilesModel";
import { type MatchSegments } from "./types";

/** Prefer keeping text from the line start when the match is near it. */
export const CONTEXT_BEFORE_MATCH = 48;

/** Cap how much of the line continues past the keyword. */
export const CONTEXT_AFTER_MATCH = 56;

/** Hard cap on displayed code points (hit always retained in full). */
export const MAX_LINE_CHARS = 120;

/**
 * Slice the line around the match. Offsets from the backend are Unicode
 * code-point based, so slice via code points rather than UTF-16 indices.
 *
 * Strategy (Find-in-Files readability):
 * - Drop pure leading indent so results align.
 * - Keep up to CONTEXT_BEFORE_MATCH before the hit (or from line start when closer).
 * - Keep up to CONTEXT_AFTER_MATCH after the hit.
 * - If the window still exceeds MAX_LINE_CHARS, shrink both sides while
 *   always retaining the full hit.
 */
export function matchSegments(match: WorkspaceSearchMatch): MatchSegments {
  const chars = Array.from(match.lineText);
  const trimmed = match.lineText.trimStart();
  const leading = chars.length - Array.from(trimmed).length;
  const start = Math.min(Math.max(match.matchStart, leading), chars.length);
  const end = Math.min(Math.max(match.matchEnd, start), chars.length);
  const hitLen = end - start;

  let contextStart = Math.max(leading, start - CONTEXT_BEFORE_MATCH);
  let contextEnd = Math.min(chars.length, end + CONTEXT_AFTER_MATCH);

  // Prefer keeping from the (trimmed) line start when the whole prefix fits.
  if (start - leading <= CONTEXT_BEFORE_MATCH) {
    contextStart = leading;
  }

  let windowLen = contextEnd - contextStart;
  if (windowLen > MAX_LINE_CHARS) {
    const budget = Math.max(0, MAX_LINE_CHARS - hitLen);
    const leftWant = start - contextStart;
    const rightWant = contextEnd - end;
    const leftKeep = Math.min(leftWant, Math.ceil(budget / 2));
    const rightKeep = Math.min(rightWant, budget - leftKeep);
    // If the right side was shorter, give leftover budget back to the left.
    const leftFinal = Math.min(leftWant, leftKeep + (budget - leftKeep - rightKeep));
    contextStart = start - leftFinal;
    contextEnd = end + rightKeep;
  }

  const elidedStart = contextStart > leading;
  const elidedEnd = contextEnd < chars.length;
  const text = chars.slice(contextStart, contextEnd).join("");
  const hitStart = start - contextStart;
  const hitEnd = end - contextStart;
  const prefix = elidedStart ? "…" : "";
  const suffix = elidedEnd ? "…" : "";

  return {
    before: prefix + chars.slice(contextStart, start).join(""),
    hit: chars.slice(start, end).join(""),
    after: chars.slice(end, contextEnd).join("") + suffix,
    text,
    hitStart,
    hitEnd,
    elidedStart,
    elidedEnd,
  };
}

export function groupKey(match: WorkspaceSearchMatch): string {
  return `${match.rootId}:${match.path}`;
}

/**
 * ED-IMPROVE-005: display label for the frozen preview scope so the dialog
 * shows exactly which roots/mask/generation/query the frozen set came from.
 */
export function replaceScopeLabel(snapshot: ReplacePreviewSnapshot): string {
  const { scope, query } = snapshot;
  const targets = scope.roots.length > 0
    ? `${scope.roots.length} root${scope.roots.length === 1 ? "" : "s"}`
    : `${scope.explicitFiles.length} file${scope.explicitFiles.length === 1 ? "" : "s"}`;
  const mask = scope.fileMask ? ` · mask ${scope.fileMask}` : "";
  const generation = scope.generation != null ? ` · facts G${scope.generation}` : "";
  return `Frozen preview: ${scope.kind} · ${targets}${mask}${generation} · query “${query.query}”`;
}

/** Join key shared by preview usages and search matches for exclusion. */
export function usageJoinKeyForMatch(match: WorkspaceSearchMatch): string {
  const line = Math.max(0, match.lineNumber - 1);
  // ED-IMPROVE-004: preview usage keys carry UTF-16 LSP characters, so the
  // backend's code-point offsets are converted through the shared mapping.
  const start = codePointOffsetToUtf16Offset(match.lineText, match.matchStart);
  const end = codePointOffsetToUtf16Offset(match.lineText, match.matchEnd);
  return `${replaceMatchAbsolutePath(match)}:${line}:${start}:${line}:${end}`;
}

export function groupTitle(match: WorkspaceSearchMatch): string {
  return `${match.rootName}/${match.path}`;
}
