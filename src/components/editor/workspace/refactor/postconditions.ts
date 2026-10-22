import { fsPathComparisonKey } from "../codeWorkspaceModel";
import { sha256Hex } from "../projectAnalysisModel";
import { type RefactorPlanV4, type RefactorRecoveryResourceMoveV1 } from "./types";

/**
 * ED-REF-001-A3: Verifies that post-refactor document contents match the
 * expected post-hashes computed during plan construction.
 *
 * RC-01 fix (java-rename-deleted-recovery): path lookup is identity-based
 * (`fsPathComparisonKey`, handling `/` vs `\`, drive casing, file URIs),
 * a required document without actual text is a `missing` failure instead of
 * a silent skip, and EOL-only differences are accepted so CRLF saves are not
 * mistaken for content mismatches in one checker while accepted in another.
 */
export function buildRefactorPostTextIndex(
  actualPostTexts: Record<string, string>,
): Map<string, string> {
  const index = new Map<string, string>();
  for (const [rawKey, text] of Object.entries(actualPostTexts)) {
    index.set(fsPathComparisonKey(rawKey), text);
  }
  return index;
}

export function planPostHashMatches(expectedPostHash: string, actualText: string): boolean {
  if (sha256Hex(actualText) === expectedPostHash) return true;
  // Accept EOL-only differences: the shared committer may normalize line
  // endings when writing closed files. Checking the LF/CRLF/CR variants of
  // the actual text covers both LF-expected and CRLF-expected plans without
  // masking real content changes.
  const unified = actualText.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (sha256Hex(unified) === expectedPostHash) return true;
  if (sha256Hex(unified.replace(/\n/g, "\r\n")) === expectedPostHash) return true;
  if (sha256Hex(unified.replace(/\n/g, "\r")) === expectedPostHash) return true;
  return false;
}

export function verifyRefactorPostHashes(
  plan: Pick<RefactorPlanV4, "documents">,
  actualPostTexts: Record<string, string>,
): {
  allMatched: boolean;
  mismatches: Array<{ uri: string; expectedPostHash: string; actualPostHash: string; }>;
  missing: Array<{ uri: string; expectedPostHash: string; }>;
  verifiedDocuments: number;
} {
  const index = buildRefactorPostTextIndex(actualPostTexts);
  const mismatches: Array<{ uri: string; expectedPostHash: string; actualPostHash: string; }> = [];
  const missing: Array<{ uri: string; expectedPostHash: string; }> = [];
  let verifiedDocuments = 0;

  for (const doc of plan.documents) {
    if (!doc.expectedPostHash) continue;
    const candidates = [doc.uri, doc.canonicalPath].filter((v): v is string => !!v);
    let actualText: string | undefined;
    for (const candidate of candidates) {
      const hit = index.get(fsPathComparisonKey(candidate));
      if (hit !== undefined) {
        actualText = hit;
        break;
      }
    }
    if (actualText === undefined) {
      missing.push({ uri: doc.uri, expectedPostHash: doc.expectedPostHash });
      continue;
    }
    verifiedDocuments += 1;
    if (!planPostHashMatches(doc.expectedPostHash, actualText)) {
      mismatches.push({
        uri: doc.uri,
        expectedPostHash: doc.expectedPostHash,
        actualPostHash: sha256Hex(actualText),
      });
    }
  }

  return {
    allMatched: mismatches.length === 0 && missing.length === 0,
    mismatches,
    missing,
    verifiedDocuments,
  };
}

/**
 * RC-01: ordered move-aware post-text resolution for journal/plan checks.
 *
 * A text document addressed to a pre-move path verifies against the bytes at
 * the end of its move chain. The chain follows `resourceMoves` order; an
 * ambiguous mapping (multiple moves from the same old path, cycles) or a
 * still-present old path fails closed with `null` instead of guessing by
 * basename or an unrelated same-name file. Display/IO paths are untouched;
 * only the comparison keys are used for identity.
 */
export function resolveRefactorPostTextForDocument(
  doc: { uri: string; canonicalPath: string | null; },
  moves: readonly RefactorRecoveryResourceMoveV1[],
  index: ReadonlyMap<string, string>,
): { text: string; resolvedPath: string; } | null {
  const startRaw = doc.canonicalPath || doc.uri;
  const startKey = fsPathComparisonKey(startRaw);
  // Follow the ordered move chain starting at the document identity.
  let currentKey = startKey;
  let currentRaw = startRaw;
  const visited = new Set<string>([currentKey]);
  let followed = false;
  for (let step = 0; step < moves.length; step += 1) {
    const candidates = moves.filter((move) => {
      if (!move.oldPath && !move.oldUri) return false;
      const oldKeys = [move.oldPath, move.oldUri].filter((v): v is string => !!v)
        .map((v) => fsPathComparisonKey(v));
      return oldKeys.includes(currentKey);
    });
    if (candidates.length === 0) break;
    // Ambiguous fan-out: fail closed.
    if (candidates.length > 1) return null;
    const next = candidates[0]!;
    const nextRaw = next.newPath || next.newUri;
    if (!nextRaw) return null;
    const nextKey = fsPathComparisonKey(nextRaw);
    if (visited.has(nextKey)) return null;
    visited.add(nextKey);
    currentKey = nextKey;
    currentRaw = nextRaw;
    followed = true;
  }
  if (!followed) {
    const direct = index.get(startKey);
    return direct === undefined ? null : { text: direct, resolvedPath: startRaw };
  }
  // A completed rename removes the old path: a still-present old identity
  // means the move did not complete (or a stale buffer is shadowing disk).
  // Never prefer the stale old bytes; fail closed so the journal stays
  // recovery-required instead of recording a false success.
  if (index.has(startKey)) return null;
  // Every intermediate except the final target must also be gone; otherwise
  // the chain did not fully apply.
  for (const seen of visited) {
    if (seen !== startKey && seen !== currentKey && index.has(seen)) return null;
  }
  const finalText = index.get(currentKey);
  return finalText === undefined ? null : { text: finalText, resolvedPath: currentRaw };
}

/**
 * RC-01: pure-move endpoint proof for post verification. Every journalled
 * move must show old-gone and new-present; anything else (both present,
 * both missing, unreadable) is a postcondition failure, never a success.
 */
export function verifyRefactorMovePostEndpoints(
  moves: readonly RefactorRecoveryResourceMoveV1[],
  existsByKey: ReadonlyMap<string, boolean | null>,
): { allVerified: boolean; missing: string[]; verifiedMoves: number; } {
  const missing: string[] = [];
  let verifiedMoves = 0;
  for (const move of moves) {
    const oldRaw = move.oldPath || move.oldUri;
    const newRaw = move.newPath || move.newUri;
    if (!oldRaw || !newRaw) {
      missing.push(`${move.oldUri} -> ${move.newUri}`);
      continue;
    }
    const oldExists = existsByKey.get(fsPathComparisonKey(oldRaw));
    const newExists = existsByKey.get(fsPathComparisonKey(newRaw));
    if (oldExists === false && newExists === true) {
      verifiedMoves += 1;
      continue;
    }
    missing.push(`${oldRaw} -> ${newRaw}`);
  }
  return { allVerified: missing.length === 0, missing, verifiedMoves };
}
