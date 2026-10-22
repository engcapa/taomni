import type { LspWorkspaceEdit } from "../../../../lib/editor/lsp";
import { fsPathComparisonKey, normalizeFsPath } from "../codeWorkspaceModel";
import { workspaceEditOperations } from "../workspaceEditPreview";
import { sha256Hex } from "../projectAnalysisModel";
import { applyLspTextEditsToString } from "../lspTextEdits";
import { normalizeLineEndings } from "../saveNormalizationPipeline";
import {
  type RefactorRecoveryDocumentSnapshotV2,
  type RefactorRecoveryResourceMoveV1,
  type RefactorRecoveryMoveProof,
  type WorkspaceEditRecoveryPlan,
  type RefactorRecoveryPreImageV2,
  type RefactorRecoveryJournalPreparation,
  type RefactorKind,
} from "./types";

/**
 * ED-AUDIT-014: compares a real post-state text against the journal's
 * expected post-image. The raw edit application is the primary expectation;
 * the EOL-normalized form is accepted as well because the shared committer
 * legitimately normalizes line endings when writing closed files with a
 * recorded EOL. Any other content is a real postcondition mismatch.
 */
export function refactorJournalPostImageMatches(
  doc: RefactorRecoveryDocumentSnapshotV2,
  actualText: string,
): boolean {
  if (sha256Hex(actualText) === doc.postHash) return true;
  if (doc.eol) {
    return sha256Hex(normalizeLineEndings(doc.postText, doc.eol)) === sha256Hex(actualText);
  }
  return false;
}

/**
 * ED-REPAIR-004: compares a real text against the journal's recorded pre-image,
 * accepting either exact or EOL-normalized match.
 */
export function refactorJournalPreImageMatches(
  doc: RefactorRecoveryDocumentSnapshotV2,
  actualText: string,
): boolean {
  if (sha256Hex(actualText) === doc.preHash) return true;
  if (doc.eol) {
    return sha256Hex(normalizeLineEndings(doc.preText, doc.eol)) === sha256Hex(actualText);
  }
  return false;
}

export function recoveryMovePath(uri: string, path: string | null): string | null {
  if (path) return path;
  if (/^file:/i.test(uri)) {
    try {
      return decodeURIComponent(uri.replace(/^file:\/\//i, ""));
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * ED-FOLLOW-001: resolves the live read target of a journal document through
 * journalled file moves. A text op addressed to the pre-move path reads at
 * the new path once the old path is gone (and back at the old path after a
 * reversal moved it home). `oldExists` is the live existence of the move's
 * old path; without a matching move the recorded target is used unchanged.
 */
export function resolveRecoveryDocTarget(
  doc: { uri: string; canonicalPath: string | null; },
  moves: readonly RefactorRecoveryResourceMoveV1[],
  oldExists: (oldPath: string) => boolean,
): string {
  const recorded = doc.canonicalPath || doc.uri;
  const recordedKey = fsPathComparisonKey(recorded);
  for (const move of moves) {
    if (!move.oldPath || !move.newPath) continue;
    if (
      (move.oldPath && fsPathComparisonKey(move.oldPath) === recordedKey)
      || (move.oldUri && fsPathComparisonKey(move.oldUri) === recordedKey)
    ) {
      return oldExists(move.oldPath) ? recorded : move.newPath;
    }
    if (
      (move.newPath && fsPathComparisonKey(move.newPath) === recordedKey)
      || (move.newUri && fsPathComparisonKey(move.newUri) === recordedKey)
    ) {
      return recorded;
    }
  }
  return recorded;
}

export function resolveRecoveryMoveProof(
  move: RefactorRecoveryResourceMoveV1,
  documents: readonly RefactorRecoveryDocumentSnapshotV2[],
): RefactorRecoveryMoveProof {
  const keys = new Set<string>();
  for (const raw of [move.oldPath, move.oldUri, move.newPath, move.newUri]) {
    if (raw) keys.add(fsPathComparisonKey(raw));
  }
  const matched = documents.filter((doc) => {
    const docKeys = [doc.canonicalPath, doc.uri].filter((v): v is string => !!v)
      .map((v) => fsPathComparisonKey(v));
    return docKeys.some((key) => keys.has(key));
  });
  if (matched.length > 1) {
    return { kind: "ambiguous", reason: "multiple journal documents match the same file move" };
  }
  if (matched.length === 1) {
    return { kind: "document", doc: matched[0]! };
  }
  if (move.contentHash !== null) return { kind: "legacy-hash", hash: move.contentHash };
  return { kind: "unverified" };
}

/**
 * RC-03: checks live bytes against a move proof. Document proofs accept the
 * recorded preimage (move not yet applied / partially restored) or postimage
 * (text edits applied, now sitting at the new path), under the shared
 * EOL rules. Legacy proofs compare the single hash. Unverified always
 * passes the content gate (endpoints still gate the move); ambiguous never
 * does.
 */
export function recoveryMoveProofMatches(
  proof: RefactorRecoveryMoveProof,
  liveText: string,
): boolean {
  if (proof.kind === "unverified") return true;
  if (proof.kind === "ambiguous") return false;
  if (proof.kind === "legacy-hash") return sha256Hex(liveText) === proof.hash;
  return refactorJournalPreImageMatches(proof.doc, liveText)
    || refactorJournalPostImageMatches(proof.doc, liveText);
}

export function prepareRefactorRecoveryJournalV2(input: {
  plan: WorkspaceEditRecoveryPlan;
  edit: LspWorkspaceEdit;
  preImages: readonly RefactorRecoveryPreImageV2[];
  workspaceRoot: string;
  transactionId: string;
}): RefactorRecoveryJournalPreparation {
  const { plan, edit, preImages, workspaceRoot, transactionId } = input;
  const operations = workspaceEditOperations(edit);
  const textOperations = operations.filter((operation) => operation.kind === "text");
  const renameOperations = operations.filter((operation) => operation.kind === "rename");
  const unsupportedOperations = operations.filter((operation) => (
    operation.kind !== "text" && operation.kind !== "rename"
  ));
  if (unsupportedOperations.length > 0) {
    return {
      state: "unsupported",
      reason: "Recovery journal covers text edits and file moves; create/delete resource operations have no crash recovery",
    };
  }
  if (textOperations.length === 0 && renameOperations.length === 0) {
    return {
      state: "unsupported",
      reason: "Edit contains no text operations or file moves to journal",
    };
  }
  const resourceMoves: RefactorRecoveryResourceMoveV1[] = [];
  for (const operation of renameOperations) {
    if (operation.kind !== "rename") continue;
    const rawOldPath = recoveryMovePath(operation.oldUri, operation.oldPath);
    const rawNewPath = recoveryMovePath(operation.newUri, operation.newPath);
    if (!rawOldPath || !rawNewPath) {
      return {
        state: "incomplete",
        reason: `File move has no resolvable path pair (${operation.oldUri} -> ${operation.newUri}); refusing to mutate without a recovery journal`,
      };
    }
    // RC-01: normalize display paths; historical unnormalized entries keep
    // working because every reader compares by `fsPathComparisonKey`.
    const oldPath = normalizeFsPath(rawOldPath);
    const newPath = normalizeFsPath(rawNewPath);
    // The moved bytes' content proof comes from the matching text-op
    // preimage when the moved file also carries text edits; null otherwise
    // (reversal then moves bytes without a content proof).
    const matchingPreImage = preImages.find((candidate) => {
      if (candidate.canonicalPath !== null) {
        try {
          if (fsPathComparisonKey(candidate.canonicalPath) === fsPathComparisonKey(oldPath)) return true;
        } catch {
          // Fall through to URI comparison.
        }
      }
      try {
        return fsPathComparisonKey(candidate.uri) === fsPathComparisonKey(operation.oldUri);
      } catch {
        return candidate.uri === operation.oldUri;
      }
    });
    resourceMoves.push({
      oldUri: operation.oldUri,
      newUri: operation.newUri,
      oldPath,
      newPath,
      contentHash: matchingPreImage ? sha256Hex(matchingPreImage.preText) : null,
    });
  }
  const documents: RefactorRecoveryDocumentSnapshotV2[] = [];
  for (const operation of textOperations) {
    const document = operation.document;
    const preImage = preImages.find((candidate) => {
      try {
        if (fsPathComparisonKey(candidate.uri) === fsPathComparisonKey(document.uri)) return true;
      } catch {
        if (candidate.uri === document.uri) return true;
      }
      if (document.path !== null && candidate.canonicalPath !== null) {
        try {
          return fsPathComparisonKey(candidate.canonicalPath) === fsPathComparisonKey(document.path);
        } catch {
          return false;
        }
      }
      return false;
    });
    if (!preImage) {
      return {
        state: "incomplete",
        reason: `No preimage captured for ${document.path ?? document.uri}; refusing to mutate without a recovery journal`,
      };
    }
    const postText = document.edits.length > 0
      ? applyLspTextEditsToString(preImage.preText, document.edits)
      : preImage.preText;
    documents.push({
      uri: document.uri,
      canonicalPath: preImage.canonicalPath ? normalizeFsPath(preImage.canonicalPath) : null,
      preText: preImage.preText,
      preHash: sha256Hex(preImage.preText),
      postText,
      postHash: sha256Hex(postText),
      encoding: preImage.encoding ?? "UTF-8",
      bom: preImage.bom ?? false,
      eol: preImage.eol ?? null,
    });
  }
  const now = Date.now();
  return {
    state: "prepared",
    entry: {
      schemaVersion: 2,
      recoveryId: `ref-rec2-${sha256Hex(`${plan.actionId}:${transactionId}:${now}`).slice(0, 16)}`,
      transactionId,
      actionId: plan.actionId,
      kind: plan.kind,
      workspaceRoot,
      createdAt: now,
      updatedAt: now,
      status: "prepared",
      appliedOperationIndex: null,
      documents: Object.freeze(documents),
      resourceMoves: Object.freeze(resourceMoves),
      verification: { mismatchedUris: Object.freeze([]), checkedAt: null },
    },
  };
}

/**
 * ED-REPAIR-004: build an internal recovery plan description for general
 * text WorkspaceEdits (e.g. multi-file Replace) so that crashes, write
 * failures, or interrupted transactions have a discoverable recovery journal
 * without faking a provider refactoring action.
 */
export function buildTextWorkspaceEditRecoveryPlan(input: {
  actionId?: string;
  kind?: RefactorKind;
  label?: string | null;
  transactionId?: string;
}): WorkspaceEditRecoveryPlan {
  const kind: RefactorKind = input.kind
    ?? (input.label?.toLowerCase().includes("replace") ? "replace" : "other");
  const actionId = input.actionId
    ?? (input.label ? `workspace-edit:${input.label}` : `workspace-edit:${input.transactionId ?? Date.now()}`);
  return {
    actionId,
    kind,
    documents: [],
  };
}
