import type {
  RefactorRecoveryDocumentSnapshotV2,
  RefactorRecoveryJournalEntryV2,
  RefactorRecoveryResourceMoveV1,
} from "./refactorPlan";
import { resolveRecoveryDocTarget } from "./refactorPlan";
import { sha256Hex } from "./projectAnalysisModel";

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
  const existence = new Map<string, boolean>();
  const checkExists = async (path: string): Promise<boolean | null> => {
    const cached = existence.get(path);
    if (cached !== undefined) return cached;
    if (hooks.pathExists) {
      try {
        const result = await hooks.pathExists(path);
        if (result !== null) existence.set(path, result);
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
  const oldExists = (oldPath: string): boolean => existence.get(oldPath) === true;
  const documents: RefactorRecoveryPrecondition[] = [];
  let sawConflict = false;
  let sawUnreadable = false;
  let sawRestorable = false;
  const movePreconditions: RefactorRecoveryMovePrecondition[] = [];
  for (const move of moves) {
    movePreconditions.push(await classifyRecoveryMove(move, readText, checkExists));
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
        if (currentHash === doc.preHash) {
          state = "already-restored";
        } else if (currentHash === doc.postHash) {
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
    documents.push({ uri: doc.uri, canonicalPath: doc.canonicalPath, state, currentHash });
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
  return { documents, moves: movePreconditions, overall };
}

async function classifyRecoveryMove(
  move: RefactorRecoveryResourceMoveV1,
  readText: (canonicalPath: string) => Promise<{ text: string } | null>,
  checkExists: (path: string) => Promise<boolean | null>,
): Promise<RefactorRecoveryMovePrecondition> {
  const base: RefactorRecoveryMovePrecondition = {
    oldUri: move.oldUri,
    newUri: move.newUri,
    oldPath: move.oldPath,
    newPath: move.newPath,
    state: "unreadable",
    currentHash: null,
    contentVerified: move.contentHash !== null,
  };
  if (!move.oldPath || !move.newPath) return base;
  const [oldKnown, newKnown] = await Promise.all([
    checkExists(move.oldPath),
    checkExists(move.newPath),
  ]);
  if (oldKnown === null || newKnown === null) return base;
  if (oldKnown && !newKnown) return { ...base, state: "already-restored" };
  if (!oldKnown && newKnown) {
    if (move.contentHash === null) return { ...base, state: "restorable" };
    try {
      const current = await readText(move.newPath);
      if (current === null) return base;
      const currentHash = sha256Hex(current.text);
      if (currentHash !== move.contentHash) {
        return { ...base, state: "conflict", currentHash };
      }
      return { ...base, state: "restorable", currentHash };
    } catch {
      return base;
    }
  }
  // Both present, or both missing: reversing would destroy or invent bytes.
  return { ...base, state: "conflict" };
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
  const checkOldExists = async (oldPath: string): Promise<boolean> => {
    const cached = oldExistsLive.get(oldPath);
    if (cached !== undefined) return cached;
    if (!hooks.pathExists) return false;
    try {
      const result = await hooks.pathExists(oldPath);
      oldExistsLive.set(oldPath, result);
      return result;
    } catch {
      return false;
    }
  };
  for (const move of moves) {
    const precondition = move.newUri ? moveByNewUri.get(move.newUri) : undefined;
    const state = precondition?.state ?? "unreadable";
    if (state === "already-restored") {
      if (move.oldPath) oldExistsLive.set(move.oldPath, true);
      continue;
    }
    if (state === "conflict") {
      execution.moveConflicts.push({
        oldUri: move.oldUri,
        newUri: move.newUri,
        reason: "move endpoints changed since the transaction; reversal would destroy or invent bytes",
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
      if (move.contentHash !== null) {
        let currentHash: string | null = null;
        try {
          const current = hooks.readMoveText ? await hooks.readMoveText(move.oldPath) : null;
          currentHash = current === null ? null : sha256Hex(current.text);
        } catch {
          currentHash = null;
        }
        if (currentHash !== move.contentHash) {
          execution.moveFailures.push({
            oldUri: move.oldUri,
            newUri: move.newUri,
            reason: currentHash === null
              ? "moved-home bytes unreadable; content proof failed"
              : "moved-home bytes do not match the journalled content proof",
          });
          continue;
        }
      } else {
        execution.contentUnverifiedMoves.push(move.newPath);
      }
      execution.reversedMoves.push(move.newPath);
      oldExistsLive.set(move.oldPath, true);
    } catch (error) {
      execution.moveFailures.push({
        oldUri: move.oldUri,
        newUri: move.newUri,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  for (const doc of entry.documents) {
    const precondition = byUri.get(doc.uri);
    const state = precondition?.state ?? "unreadable";
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
      if (restoredHash !== doc.preHash) {
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
