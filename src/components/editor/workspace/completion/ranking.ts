import { type Completion } from "@codemirror/autocomplete";
import type { LspCompletionItem } from "../../../../lib/editor/lsp";
import { type CompletionCaseMatching, type CompletionSortMode } from "../intelligencePreferences";
import { type CompletionMatchTier, type CompletionCandidatePair } from "./types";


/** LSP CompletionItemKind → CodeMirror completion `type` (built-in icons). */
export function completionKindToType(kind: number | null): string | undefined {
  switch (kind) {
    case 1: return "text";
    case 2: return "method";
    case 3: return "function";
    case 4: return "function"; // constructor
    case 5: return "property"; // field
    case 6: return "variable";
    case 7: return "class";
    case 8: return "interface";
    case 9: return "namespace"; // module
    case 10: return "property";
    case 11: return "constant"; // unit
    case 12: return "constant"; // value
    case 13: return "enum";
    case 14: return "keyword";
    case 15: return "text"; // snippet — CM has no dedicated snippet icon
    case 16: return "constant"; // color
    case 17: return "file";
    case 18: return "text"; // reference
    case 19: return "folder";
    case 20: return "constant"; // enum member
    case 21: return "constant";
    case 22: return "class"; // struct
    case 23: return "property"; // event
    case 24: return "keyword"; // operator
    case 25: return "type"; // type parameter
    default:
      return kind == null ? undefined : "text";
  }
}


/**
 * Map LSP sortText (lexicographic, lower = better) into CodeMirror `boost`
 * (higher = better) so server ranking wins over naive label order.
 */
export function boostFromSortText(sortText: string | null | undefined): number | undefined {
  if (!sortText) return undefined;
  // Prefer pure numeric prefixes ("0001", "10") then fall back to string rank.
  const digits = sortText.match(/^\d+/)?.[0];
  if (digits) {
    const n = Number.parseInt(digits, 10);
    if (Number.isFinite(n)) return Math.max(-99, 1000 - Math.min(n, 1099));
  }
  // Lexicographic-ish: earlier code points rank higher.
  let score = 0;
  for (let i = 0;i < Math.min(sortText.length, 4);i += 1) {
    score = score * 96 + (sortText.charCodeAt(i) - 32);
  }
  return Math.max(-99, 500 - (score % 600));
}


/** Triggers that feel natural even when the server omits completionTriggerCharacters. */
export const DEFAULT_COMPLETION_TRIGGERS = [".", ":"];


/**
 * Cap the option list so the popup stays responsive. Servers like jdtls can
 * return thousands of members; IDEA also truncates the visible list and
 * re-queries as the user types.
 */
export const MAX_COMPLETION_OPTIONS = 200;
// No match

export function matchCompletionQuery(label: string, query: string): { tier: CompletionMatchTier; score: number; } {
  if (!query) return { tier: 2, score: 0 };
  const lowerLabel = label.toLowerCase();
  const lowerQuery = query.toLowerCase();

  // Tier 1: Exact match
  if (label === query) return { tier: 1, score: 1000 };
  if (lowerLabel === lowerQuery) return { tier: 1, score: 900 };

  // Tier 2: Prefix match
  if (label.startsWith(query)) return { tier: 2, score: 800 - label.length };
  if (lowerLabel.startsWith(lowerQuery)) return { tier: 2, score: 700 - label.length };

  // Tier 3: CamelCase / word boundary match
  const words = label.split(/(?=[A-Z])|[\_\-\.]/g).filter(Boolean);
  const wordPrefixes = words.map((w) => w[0]?.toLowerCase()).join("");
  if (wordPrefixes.startsWith(lowerQuery) || words.some((w) => w.toLowerCase().startsWith(lowerQuery))) {
    return { tier: 3, score: 500 - label.length };
  }

  // Tier 4: Subsequence fuzzy match
  let queryIdx = 0;
  for (let i = 0;i < lowerLabel.length && queryIdx < lowerQuery.length;i++) {
    if (lowerLabel[i] === lowerQuery[queryIdx]) {
      queryIdx++;
    }
  }
  if (queryIdx === lowerQuery.length) {
    return { tier: 4, score: 300 - label.length };
  }

  return { tier: 5, score: 0 };
}


/**
 * Pure comparator for completion candidate pairs (§ED-COMP-002).
 * Rule 1: Match tier is the primary sort key (Tier 1 < Tier 2 < Tier 3 < Tier 4 < Tier 5).
 * Rule 2: If sortMode is alphabetical, compare labels.
 * Rule 3: For provider-relevance within the same tier, strictly preserve provider order (rawResponseIndex).
 */
export function compareCandidatePairs(
  a: CompletionCandidatePair,
  b: CompletionCandidatePair,
  sortMode: CompletionSortMode = "provider-relevance",
): number {
  if (sortMode === "alphabetical") {
    return a.completion.label.localeCompare(b.completion.label);
  }

  // 1. Primary sort key: Match tier
  if (a.matchTier !== b.matchTier) {
    return a.matchTier - b.matchTier;
  }

  // 2. Explicit boost differences (e.g. prioritized symbols)
  const boostA = a.completion.boost ?? 0;
  const boostB = b.completion.boost ?? 0;
  if (boostA !== boostB) {
    return boostB - boostA;
  }

  // 3. Default tie-breaker within same tier: strictly preserve provider order (rawResponseIndex)
  return a.identity.rawResponseIndex - b.identity.rawResponseIndex;
}


export function compareCompletionCandidates(
  a: Completion,
  b: Completion,
  query: string,
  sortMode: CompletionSortMode = "provider-relevance",
): number {
  if (sortMode === "alphabetical") {
    return a.label.localeCompare(b.label);
  }

  const matchA = matchCompletionQuery(a.label, query);
  const matchB = matchCompletionQuery(b.label, query);

  if (matchA.tier !== matchB.tier) {
    return matchA.tier - matchB.tier;
  }

  // Preserve provider order within the same match tier
  return 0;
}


/**
 * §8.21.3 V2-E: Symbol identity extraction for exclusion and prioritization.
 * Uses provider item's FQN/detail/data; never relies solely on unqualified label.
 */
export function symbolIdentityFromItem(item: LspCompletionItem): {
  fqn: string | null;
  detail: string | null;
  label: string;
  hasPackageIdentity: boolean;
} {
  const rawObj = item.raw && typeof item.raw === "object" ? (item.raw as Record<string, unknown>) : null;
  const rawData = rawObj?.data && typeof rawObj.data === "object" ? (rawObj.data as Record<string, unknown>) : null;
  let fqn = (typeof rawData?.fqn === "string" ? rawData.fqn : null)
    ?? (typeof rawData?.symbol === "string" ? rawData.symbol : null);
  const detail = item.detail;
  if (!fqn && detail && detail.includes(".")) {
    const match = detail.match(/([a-zA-Z0-9_$]+(?:\.[a-zA-Z0-9_$]+)+)/);
    if (match) {
      fqn = match[1];
    }
  }
  const hasPackageIdentity = !!fqn || (!!detail && detail.includes("."));
  return { fqn, detail, label: item.label, hasPackageIdentity };
}


export function matchesSymbolPattern(
  identity: { fqn: string | null; detail: string | null; label: string; hasPackageIdentity: boolean; },
  patterns: readonly { pattern: string; }[],
): boolean {
  if (!patterns || patterns.length === 0) return false;
  // Identity insufficient: do NOT match on label alone (preventing false exclusion of same-named types)
  if (!identity.hasPackageIdentity) return false;
  const target = identity.fqn ?? identity.detail ?? "";
  return patterns.some((p) => {
    const pat = p.pattern.trim();
    if (!pat) return false;
    if (pat.endsWith(".*")) {
      const prefix = pat.slice(0, -2);
      return target === prefix || target.startsWith(`${prefix}.`);
    }
    if (pat.endsWith("*")) {
      const prefix = pat.slice(0, -1);
      return target.startsWith(prefix);
    }
    return target === pat || target.endsWith(`.${pat}`);
  });
}


export function matchesCaseRule(
  typed: string,
  label: string,
  mode: CompletionCaseMatching,
): boolean {
  if (!typed || !label) return true;
  if (mode === "none") return true;
  if (mode === "all") {
    return label.startsWith(typed);
  }
  if (mode === "first-letter") {
    const typedFirst = typed[0];
    const labelFirst = label[0];
    const isTypedUpper = typedFirst >= "A" && typedFirst <= "Z";
    const isTypedLower = typedFirst >= "a" && typedFirst <= "z";
    const isLabelUpper = labelFirst >= "A" && labelFirst <= "Z";
    const isLabelLower = labelFirst >= "a" && labelFirst <= "z";
    if (isTypedUpper && isLabelLower) return false;
    if (isTypedLower && isLabelUpper) return false;
    return true;
  }
  return true;
}


export function mergeCompletionTriggers(server: readonly string[] | null | undefined): string[] {
  const set = new Set<string>();
  for (const ch of server ?? []) {
    if (ch) set.add(ch);
  }
  for (const ch of DEFAULT_COMPLETION_TRIGGERS) set.add(ch);
  return [...set];
}


/**
 * Extra boost for camelCase / prefix quality when the server did not provide
 * sortText. Lower = better match; returned as CM boost (higher = better).
 */
export function boostFromTypedPrefix(
  typed: string,
  filterLabel: string,
  sortText: string | null | undefined,
): number | undefined {
  const fromSort = boostFromSortText(sortText);
  if (!typed) return fromSort;
  const label = filterLabel;
  const lowerTyped = typed.toLowerCase();
  const lowerLabel = label.toLowerCase();
  let quality = 0;
  if (label.startsWith(typed)) quality = 120;
  else if (lowerLabel.startsWith(lowerTyped)) quality = 100;
  else if (lowerLabel.includes(lowerTyped)) quality = 40;
  else {
    // camelCase initials: "oF" → openFile, "cwt" → CodeWorkspaceTab
    let ti = 0;
    for (let i = 0;i < label.length && ti < typed.length;i += 1) {
      const ch = label[i];
      const boundary = i === 0
        || ch !== ch.toLowerCase()
        || /[^A-Za-z0-9]/.test(label[i - 1] ?? "");
      if (!boundary && i > 0) continue;
      if (ch.toLowerCase() === typed[ti].toLowerCase()) ti += 1;
    }
    if (ti === typed.length) quality = 80;
  }
  if (!quality && fromSort === undefined) return undefined;
  return (fromSort ?? 0) + quality;
}
