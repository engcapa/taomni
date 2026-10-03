import type {
  RefactorRecoveryDocumentSnapshotV2,
  RefactorRecoveryJournalEntryV2,
  RefactorRecoveryResourceMoveV1,
} from "./refactorPlan";
import {
  recoveryMoveProofMatches,
  resolveRecoveryDocTarget,
  resolveRecoveryMoveProof,
} from "./refactorPlan";
import { fsPathComparisonKey } from "./codeWorkspaceModel";
import { sha256Hex } from "./projectAnalysisModel";
import { normalizeLineEndings } from "./saveNormalizationPipeline";

/**
 * ED-AUDIT-014 recovery lifecycle for text-only refactor journals.
 *
 * The controller owns precondition classification and verified restore; the
 * shell (CodeWorkspaceTab) supplies the real read/write transaction paths.
 * It never overwrites third-party content and only reports success after an
 * independent read-back confirms every preimage.
 */

export type RefactorRecoveryPreconditionState =
  | "already-restored" // current content hash equals the recorded preHash
  | "restorable" // current content hash equals the recorded postHash
  | "conflict" // third-party content; zero-overwrite boundary
  | "unreadable"; // read failed; cannot classify

export interface RefactorRecoveryPrecondition {
  uri: string;
  canonicalPath: string | null;
  state: RefactorRecoveryPreconditionState;
  currentHash: string | null;
}

/**
 * ED-FOLLOW-001: precondition of one journalled file move.
 * `restorable` = old path gone, new path present (with the journalled
 * content when a content proof exists). `already-restored` = old path back
 * and new path gone. Anything else (both present, both missing, content
 * drift, unreadable ends) is `conflict`/`unreadable`: the move is never
 * touched and the entry stays pending.
 */
export type RefactorRecoveryMoveState =
  | "already-restored"
  | "restorable"
  | "conflict"
  | "unreadable";

export interface RefactorRecoveryMovePrecondition {
  oldUri: string;
  newUri: string;
  oldPath: string | null;
  newPath: string | null;
  state: RefactorRecoveryMoveState;
  /** Hash of the bytes currently at the new path; null when unreadable. */
  currentHash: string | null;
  /**
   * False when the move carries no content proof: reversal moves bytes home
   * without a content guarantee and reports it as content-unverified.
   */
  contentVerified: boolean;
  /**
   * RC-02/RC-03: fine-grained reason for UI display (`both-missing`,
   * `both-present`, `content-changed`, `read-failed`, `ambiguous-proof`,
   * `missing-pair`). The coarse `state` union stays the executor guard.
   */
  detail?: string;
}

export interface RefactorRecoveryPreconditionSummary {
  documents: RefactorRecoveryPrecondition[];
  moves: RefactorRecoveryMovePrecondition[];
  overall: "already-restored" | "restorable" | "conflict" | "unreadable";
}

export interface RefactorRecoveryClassifyHooks {
  /**
   * ED-FOLLOW-001: existence probe for move endpoints. Defaults to deriving
   * existence from `readText` (null = missing or unreadable, treated as
   * unreadable) when the shell does not supply a real stat.
   */
  pathExists?: (path: string) => Promise<boolean | null>;
}

export async function classifyRefactorRecoveryPreconditions(
  entry: RefactorRecoveryJournalEntryV2,
  readText: (canonicalPath: string) => Promise<{ text: string } | null>,
  hooks: RefactorRecoveryClassifyHooks = {},
): Promise<RefactorRecoveryPreconditionSummary> {
  const moves = entry.resourceMoves ?? [];
  const journalDocuments = entry.documents ?? [];
  const existence = new Map<string, boolean>();
  const keyOf = (path: string): string => {
    try {
      return fsPathComparisonKey(path);
    } catch {
      return path;
    }
  };
  const checkExists = async (path: string): Promise<boolean | null> => {
    const key = keyOf(path);
    const cached = existence.get(key);
    if (cached !== undefined) return cached;
    if (hooks.pathExists) {
      try {
        const result = await hooks.pathExists(path);
        if (result !== null) existence.set(key, result);
        return result;
      } catch {
        return null;
      }
    }
    try {
      const current = await readText(path);
      return current !== null;
    } catch {
      return null;
    }
  };
  const oldExists = (oldPath: string): boolean => existence.get(keyOf(oldPath)) === true;
  const docPreconditions: RefactorRecoveryPrecondition[] = [];
  let sawConflict = false;
  let sawUnreadable = false;
  let sawRestorable = false;
  const movePreconditions: RefactorRecoveryMovePrecondition[] = [];
  for (const move of moves) {
    movePreconditions.push(await classifyRecoveryMove(move, readText, checkExists, journalDocuments));
  }
  for (const doc of entry.documents) {
    const target = resolveRecoveryDocTarget(doc, moves, oldExists);
    let state: RefactorRecoveryPreconditionState;
    let currentHash: string | null = null;
    try {
      const current = await readText(target);
      if (current === null) {
        state = "unreadable";
        sawUnreadable = true;
      } else {
        currentHash = sha256Hex(current.text);
        const matchesPre = currentHash === doc.preHash
          || (doc.eol ? sha256Hex(normalizeLineEndings(doc.preText, doc.eol)) === currentHash : false);
        const matchesPost = currentHash === doc.postHash
          || (doc.eol ? sha256Hex(normalizeLineEndings(doc.postText, doc.eol)) === currentHash : false);
        if (matchesPre) {
          state = "already-restored";
        } else if (matchesPost) {
          state = "restorable";
          sawRestorable = true;
        } else {
          state = "conflict";
          sawConflict = true;
        }
      }
    } catch {
      state = "unreadable";
      sawUnreadable = true;
    }
    docPreconditions.push({ uri: doc.uri, canonicalPath: doc.canonicalPath, state, currentHash });
  }
  for (const move of movePreconditions) {
    if (move.state === "conflict") sawConflict = true;
    else if (move.state === "unreadable") sawUnreadable = true;
    else if (move.state === "restorable") sawRestorable = true;
  }
  const overall: RefactorRecoveryPreconditionSummary["overall"] = sawConflict
    ? "conflict"
    : sawUnreadable
      ? "unreadable"
      : sawRestorable
        ? "restorable"
        : "already-restored";
  return { documents: docPreconditions, moves: movePreconditions, overall };
}

async function classifyRecoveryMove(
  move: RefactorRecoveryResourceMoveV1,
  readText: (canonicalPath: string) => Promise<{ text: string } | null>,
  checkExists: (path: string) => Promise<boolean | null>,
  documents: readonly RefactorRecoveryDocumentSnapshotV2[] = [],
): Promise<RefactorRecoveryMovePrecondition> {
  const proof = resolveRecoveryMoveProof(move, documents);
  const base: RefactorRecoveryMovePrecondition = {
    oldUri: move.oldUri,
    newUri: move.newUri,
    oldPath: move.oldPath,
    newPath: move.newPath,
    state: "unreadable",
    currentHash: null,
    contentVerified: proof.kind !== "unverified",
    detail: "read-failed",
  };
  if (!move.oldPath || !move.newPath) return { ...base, detail: "missing-pair" };
  if (proof.kind === "ambiguous") {
    return { ...base, state: "conflict", detail: "ambiguous-proof" };
  }
  const [oldKnown, newKnown] = await Promise.all([
    checkExists(move.oldPath),
    checkExists(move.newPath),
  ]);
  if (oldKnown === null || newKnown === null) return base;
  if (oldKnown && !newKnown) return { ...base, state: "already-restored", detail: "already-restored" };
  if (!oldKnown && newKnown) {
    // RC-03: the live bytes at the new path are the POST image for mixed
    // text+rename transactions. A document proof accepts preimage (move not
    // yet applied / partially restored) or postimage (edits applied); the
    // legacy single-hash proof is kept for pure moves without documents.
    if (proof.kind === "unverified") return { ...base, state: "restorable", detail: "restorable" };
    try {
      const current = await readText(move.newPath);
      if (current === null) return base;
      const currentHash = sha256Hex(current.text);
      if (!recoveryMoveProofMatches(proof, current.text)) {
        return { ...base, state: "conflict", currentHash, detail: "content-changed" };
      }
      return { ...base, state: "restorable", currentHash, detail: "restorable" };
    } catch {
      return base;
    }
  }
  // Both present, or both missing: reversing would destroy or invent bytes.
  // Both-missing is the deleted-after-rename shape: it stays pending with an
  // explicit abandon outlet instead of auto-resolving.
  if (!oldKnown && !newKnown) return { ...base, state: "conflict", detail: "both-missing" };
  return { ...base, state: "conflict", detail: "both-present" };
}

export interface RefactorRecoveryExecution {
  /** `rolled-back` only when every document is confirmed at its preHash. */
  state: "rolled-back" | "pending";
  restoredUris: string[];
  /** Documents already at their preHash before any write (idempotent re-runs). */
  skippedUris: string[];
  conflicts: Array<{ uri: string; canonicalPath: string | null; currentHash: string | null }>;
  failures: Array<{ uri: string; canonicalPath: string | null; reason: string }>;
  /** ED-FOLLOW-001: new-paths reversed home to their old paths. */
  reversedMoves: string[];
  /**
   * ED-FOLLOW-001: reversals that moved bytes home without a content proof
   * (the journalled move carried no contentHash). The bytes are back but the
   * content guarantee is weaker than a hash-verified restore.
   */
  contentUnverifiedMoves: string[];
  moveConflicts: Array<{ oldUri: string; newUri: string; reason: string }>;
  moveFailures: Array<{ oldUri: string; newUri: string; reason: string }>;
}

export interface RefactorRecoveryExecuteHooks {
  /**
   * Writes `doc.preText` through the shell's existing encoding writer /
   * transaction path. Must throw on failure; the controller records it.
   */
  restoreText: (doc: RefactorRecoveryDocumentSnapshotV2) => Promise<void>;
  /** Independent read-back of the just-restored file; null means unreadable. */
  readBack: (doc: RefactorRecoveryDocumentSnapshotV2) => Promise<{ text: string } | null>;
  /**
   * ED-FOLLOW-001: reverses one journalled file move (new path back to the
   * old path) through the shell's resource-operation path. Must throw on
   * failure; the controller records it and verifies the reversal.
   */
  reverseResourceMove?: (move: RefactorRecoveryResourceMoveV1) => Promise<void>;
  /** ED-FOLLOW-001: live existence probe used to verify a reversal. */
  pathExists?: (path: string) => Promise<boolean>;
  /**
   * ED-FOLLOW-001: live read of a path's bytes used to verify reversed
   * content when the journalled move carries a content proof.
   */
  readMoveText?: (path: string) => Promise<{ text: string } | null>;
}

/**
 * Executes a verified restore over the classified preconditions. Documents
 * classified `conflict` or `unreadable` are never written. A failed restore
 * keeps the remaining documents untouched (pending state survives for retry).
 *
 * ED-FOLLOW-001: journalled file moves reverse BEFORE text documents run,
 * so a document addressed to the pre-move path classifies and restores
 * against the moved-home bytes. A move reversal is only claimed after an
 * independent existence/content check confirms old-present, new-gone (and
 * the journalled content hash when one exists).
 */
export async function executeRefactorRecovery(
  entry: RefactorRecoveryJournalEntryV2,
  preconditions: RefactorRecoveryPreconditionSummary,
  hooks: RefactorRecoveryExecuteHooks,
): Promise<RefactorRecoveryExecution> {
  const byUri = new Map(preconditions.documents.map((doc) => [doc.uri, doc]));
  const moves = entry.resourceMoves ?? [];
  const moveByNewUri = new Map(preconditions.moves.map((move) => [move.newUri, move]));
  const execution: RefactorRecoveryExecution = {
    state: "rolled-back",
    restoredUris: [],
    skippedUris: [],
    conflicts: [],
    failures: [],
    reversedMoves: [],
    contentUnverifiedMoves: [],
    moveConflicts: [],
    moveFailures: [],
  };
  const oldExistsLive = new Map<string, boolean>();
  const keyOfLive = (path: string): string => {
    try {
      return fsPathComparisonKey(path);
    } catch {
      return path;
    }
  };
  const checkOldExists = async (oldPath: string): Promise<boolean> => {
    const key = keyOfLive(oldPath);
    const cached = oldExistsLive.get(key);
    if (cached !== undefined) return cached;
    if (!hooks.pathExists) return false;
    try {
      const result = await hooks.pathExists(oldPath);
      oldExistsLive.set(key, result);
      return result;
    } catch {
      return false;
    }
  };
  for (const move of moves) {
    const precondition = move.newUri ? moveByNewUri.get(move.newUri) : undefined;
    const state = precondition?.state ?? "unreadable";
    if (state === "already-restored") {
      if (move.oldPath) oldExistsLive.set(keyOfLive(move.oldPath), true);
      continue;
    }
    if (state === "conflict") {
      execution.moveConflicts.push({
        oldUri: move.oldUri,
        newUri: move.newUri,
        reason: precondition?.detail === "both-missing"
          ? "both move endpoints are missing; reversal would invent bytes"
          : precondition?.detail === "both-present"
            ? "both move endpoints are present; reversal would destroy bytes"
            : precondition?.detail === "content-changed"
              ? "bytes at the new path changed since the transaction; reversal would destroy third-party content"
              : precondition?.detail === "ambiguous-proof"
                ? "multiple journal documents match the same file move; reversal refused to guess"
                : "move endpoints changed since the transaction; reversal would destroy or invent bytes",
      });
      continue;
    }
    if (state !== "restorable") {
      execution.moveFailures.push({
        oldUri: move.oldUri,
        newUri: move.newUri,
        reason: "move preconditions unreadable; reversal aborted for this file",
      });
      continue;
    }
    if (!hooks.reverseResourceMove || !move.oldPath || !move.newPath) {
      execution.moveFailures.push({
        oldUri: move.oldUri,
        newUri: move.newUri,
        reason: !hooks.reverseResourceMove
          ? "workspace cannot reverse file moves on this build"
          : "journalled move has no resolvable path pair",
      });
      continue;
    }
    // RC-03: prove the move preserves bytes. Re-read the source endpoint now,
    // record the hash that actually matched, reverse, then prove the bytes at
    // home equal the pre-reverse hash (plus the journal proof). A move that
    // fails here must block its associated text documents below.
    const proof = resolveRecoveryMoveProof(move, entry.documents ?? []);
    if (proof.kind === "ambiguous") {
      execution.moveFailures.push({
        oldUri: move.oldUri,
        newUri: move.newUri,
        reason: "multiple journal documents match the same file move; reversal refused to guess",
      });
      continue;
    }
    let preReverseHash: string | null = null;
    if (proof.kind !== "unverified") {
      try {
        const preReverse = hooks.readMoveText ? await hooks.readMoveText(move.newPath) : null;
        if (preReverse === null) {
          execution.moveFailures.push({
            oldUri: move.oldUri,
            newUri: move.newUri,
            reason: "bytes at the new path unreadable before reversal; content proof failed",
          });
          continue;
        }
        if (!recoveryMoveProofMatches(proof, preReverse.text)) {
          execution.moveFailures.push({
            oldUri: move.oldUri,
            newUri: move.newUri,
            reason: "bytes at the new path changed since the transaction; reversal would destroy third-party content",
          });
          continue;
        }
        preReverseHash = sha256Hex(preReverse.text);
      } catch {
        execution.moveFailures.push({
          oldUri: move.oldUri,
          newUri: move.newUri,
          reason: "bytes at the new path unreadable before reversal; content proof failed",
        });
        continue;
      }
    }
    try {
      await hooks.reverseResourceMove(move);
      const oldPresent = await checkOldExists(move.oldPath);
      let newGone = false;
      try {
        newGone = hooks.pathExists ? !(await hooks.pathExists(move.newPath)) : false;
      } catch {
        newGone = false;
      }
      if (!oldPresent || !newGone) {
        execution.moveFailures.push({
          oldUri: move.oldUri,
          newUri: move.newUri,
          reason: !oldPresent
            ? "reversal did not bring the old path back"
            : "reversal left the new path behind",
        });
        continue;
      }
      if (proof.kind === "unverified") {
        execution.contentUnverifiedMoves.push(move.newPath);
      } else {
        let postHash: string | null = null;
        let postText: string | null = null;
        try {
          const current = hooks.readMoveText ? await hooks.readMoveText(move.oldPath) : null;
          postText = current === null ? null : current.text;
          postHash = current === null ? null : sha256Hex(current.text);
        } catch {
          postHash = null;
        }
        if (postHash === null || postText === null) {
          execution.moveFailures.push({
            oldUri: move.oldUri,
            newUri: move.newUri,
            reason: "moved-home bytes unreadable; content proof failed",
          });
          continue;
        }
        // The reversal must preserve the exact bytes observed before the
        // move; afterwards those bytes must still satisfy the journal proof.
        if (preReverseHash !== null && postHash !== preReverseHash) {
          execution.moveFailures.push({
            oldUri: move.oldUri,
            newUri: move.newUri,
            reason: "moved-home bytes differ from the pre-reversal bytes; move altered content",
          });
          continue;
        }
        if (!recoveryMoveProofMatches(proof, postText)) {
          execution.moveFailures.push({
            oldUri: move.oldUri,
            newUri: move.newUri,
            reason: "moved-home bytes do not match the journalled content proof",
          });
          continue;
        }
      }
      execution.reversedMoves.push(move.newPath);
      oldExistsLive.set(keyOfLive(move.oldPath), true);
    } catch (error) {
      execution.moveFailures.push({
        oldUri: move.oldUri,
        newUri: move.newUri,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  // RC-03: a text document linked to a failed/conflicted move must not be
  // written to the wrong path after the reversal failed.
  const blockedDocKeys = new Set<string>();
  const failedMoves = [
    ...execution.moveConflicts.map((m) => ({ oldUri: m.oldUri, newUri: m.newUri })),
    ...execution.moveFailures.map((m) => ({ oldUri: m.oldUri, newUri: m.newUri })),
  ];
  for (const failed of failedMoves) {
    const failedMove = moves.find((m) => m.oldUri === failed.oldUri && m.newUri === failed.newUri);
    if (!failedMove) continue;
    for (const raw of [failedMove.oldPath, failedMove.oldUri, failedMove.newPath, failedMove.newUri]) {
      if (!raw) continue;
      try {
        blockedDocKeys.add(fsPathComparisonKey(raw));
      } catch {
        blockedDocKeys.add(raw);
      }
    }
  }
  const docBlockedByMove = (doc: RefactorRecoveryDocumentSnapshotV2): boolean => {
    for (const raw of [doc.canonicalPath, doc.uri]) {
      if (!raw) continue;
      try {
        if (blockedDocKeys.has(fsPathComparisonKey(raw))) return true;
      } catch {
        if (blockedDocKeys.has(raw)) return true;
      }
    }
    return false;
  };
  for (const doc of entry.documents) {
    const precondition = byUri.get(doc.uri);
    const state = precondition?.state ?? "unreadable";
    if (docBlockedByMove(doc)) {
      execution.failures.push({
        uri: doc.uri,
        canonicalPath: doc.canonicalPath,
        reason: "associated file move failed; text restore skipped to avoid writing to the wrong path",
      });
      continue;
    }
    if (state === "already-restored") {
      execution.skippedUris.push(doc.uri);
      continue;
    }
    if (state === "conflict") {
      execution.conflicts.push({
        uri: doc.uri,
        canonicalPath: doc.canonicalPath,
        currentHash: precondition?.currentHash ?? null,
      });
      continue;
    }
    if (state === "unreadable") {
      execution.failures.push({
        uri: doc.uri,
        canonicalPath: doc.canonicalPath,
        reason: "current content unreadable; restore aborted for this file",
      });
      continue;
    }
    try {
      await hooks.restoreText(doc);
      const readBack = await hooks.readBack(doc);
      const restoredHash = readBack === null ? null : sha256Hex(readBack.text);
      const preHashMatched = restoredHash === doc.preHash
        || (doc.eol && restoredHash !== null ? sha256Hex(normalizeLineEndings(doc.preText, doc.eol)) === restoredHash : false);
      if (!preHashMatched) {
        execution.failures.push({
          uri: doc.uri,
          canonicalPath: doc.canonicalPath,
          reason: restoredHash === null
            ? "read-back after restore failed"
            : "read-back hash does not match the recorded preimage",
        });
        continue;
      }
      execution.restoredUris.push(doc.uri);
    } catch (error) {
      execution.failures.push({
        uri: doc.uri,
        canonicalPath: doc.canonicalPath,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const complete = execution.restoredUris.length + execution.skippedUris.length === entry.documents.length
    && execution.conflicts.length === 0
    && execution.failures.length === 0
    && execution.moveConflicts.length === 0
    && execution.moveFailures.length === 0
    && execution.reversedMoves.length + preconditions.moves.filter((move) => move.state === "already-restored").length === moves.length;
  execution.state = complete ? "rolled-back" : "pending";
  return execution;
}

/**
 * ED-AUDIT-014 watcher-echo suppressor for restore-owned writes.
 *
 * Restoring a CLOSED file writes disk bytes the file watcher then reports
 * back as an external change. Without suppression that echo overwrites the
 * "Refactor recovery complete" status with a misleading "File changed on
 * disk" note for a change the restore itself just made. The suppressor
 * records comparison keys of just-restored paths; the shell skips only the
 * STATUS message for a matching echo inside a short window (tree refresh
 * and index invalidation still run). A genuinely later third-party change
 * falls outside the window and is reported normally.
 */
export interface RestoreEchoSuppressor {
  /** Record a successful restore-owned write of an already-keyed path. */
  markRestored: (comparisonKey: string, now?: number) => void;
  /**
   * True when `comparisonKey` was restore-written within `windowMs`
   * (consumes the mark so a second echo for the same write is not needed
   * but a later real change still reports).
   */
  shouldSuppress: (comparisonKey: string, now?: number, windowMs?: number) => boolean;
}

export const RESTORE_ECHO_SUPPRESS_WINDOW_MS = 10_000;

export function createRestoreEchoSuppressor(): RestoreEchoSuppressor {
  const marks = new Map<string, number>();
  return {
    markRestored(comparisonKey: string, now: number = Date.now()) {
      marks.set(comparisonKey, now);
    },
    shouldSuppress(comparisonKey: string, now: number = Date.now(), windowMs: number = RESTORE_ECHO_SUPPRESS_WINDOW_MS) {
      const markedAt = marks.get(comparisonKey);
      if (markedAt === undefined) return false;
      marks.delete(comparisonKey);
      return now - markedAt >= 0 && now - markedAt <= windowMs;
    },
  };
}
