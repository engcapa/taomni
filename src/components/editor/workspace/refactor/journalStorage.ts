import {
  type RefactorRecoveryJournalEntryV2,
  type RefactorRecoveryDocumentSnapshotV2,
  type RefactorRecoveryResourceMoveV1,
  type RefactorJournalWriteResult,
  type RefactorRecoveryJournalListingV2,
} from "./types";
import { RECOVERY_STORAGE_PREFIX } from "./legacyJournal";

export const RECOVERY_STORAGE_PREFIX_V2 = "taomni.refactor.recovery.v2:";

export function defaultRecoveryStorage(): Storage {
  return typeof window !== "undefined" ? window.localStorage : ({} as Storage);
}

export function isRefactorRecoveryJournalEntryV2(
  value: unknown,
): value is RefactorRecoveryJournalEntryV2 {
  if (!value || typeof value !== "object") return false;
  const entry = value as RefactorRecoveryJournalEntryV2;
  if (entry.schemaVersion !== 2) return false;
  if (typeof entry.recoveryId !== "string" || !entry.recoveryId) return false;
  if (typeof entry.transactionId !== "string" || !entry.transactionId) return false;
  if (typeof entry.actionId !== "string" || !entry.actionId) return false;
  if (typeof entry.kind !== "string") return false;
  if (typeof entry.workspaceRoot !== "string") return false;
  if (typeof entry.createdAt !== "number" || typeof entry.updatedAt !== "number") return false;
  if (
    entry.status !== "prepared" && entry.status !== "recovery-required"
    && entry.status !== "committed" && entry.status !== "rolled-back"
  ) {
    return false;
  }
  if (entry.appliedOperationIndex !== null && typeof entry.appliedOperationIndex !== "number") return false;
  if (!Array.isArray(entry.documents)) return false;
  for (const doc of entry.documents) {
    if (!doc || typeof doc !== "object") return false;
    const snapshot = doc as RefactorRecoveryDocumentSnapshotV2;
    if (typeof snapshot.uri !== "string" || !snapshot.uri) return false;
    if (typeof snapshot.preText !== "string" || typeof snapshot.preHash !== "string") return false;
    if (typeof snapshot.postText !== "string" || typeof snapshot.postHash !== "string") return false;
    if (typeof snapshot.encoding !== "string" || typeof snapshot.bom !== "boolean") return false;
  }
  // ED-FOLLOW-001: resourceMoves is optional so pre-move entries stay
  // readable; when present every move must carry its path pair.
  if (entry.resourceMoves !== undefined) {
    if (!Array.isArray(entry.resourceMoves)) return false;
    for (const move of entry.resourceMoves) {
      if (!move || typeof move !== "object") return false;
      const candidate = move as RefactorRecoveryResourceMoveV1;
      if (typeof candidate.oldUri !== "string" || typeof candidate.newUri !== "string") return false;
      if (
        candidate.oldPath !== null && typeof candidate.oldPath !== "string"
        || candidate.newPath !== null && typeof candidate.newPath !== "string"
        || candidate.contentHash !== null && typeof candidate.contentHash !== "string"
      ) return false;
    }
  }
  // RC-02: optional user resolution; absent on historical entries. When
  // present it must be a well-formed user-dismissed record; anything else
  // keeps the entry readable but invalid so it is never silently dropped.
  if (entry.resolution !== undefined) {
    if (!entry.resolution || typeof entry.resolution !== "object") return false;
    const resolution = entry.resolution as NonNullable<RefactorRecoveryJournalEntryV2["resolution"]>;
    if (resolution.kind !== "user-dismissed") return false;
    if (resolution.reason !== "keep-current-state") return false;
    if (typeof resolution.resolvedAt !== "number") return false;
  }
  if (!entry.verification || typeof entry.verification !== "object") return false;
  if (!Array.isArray(entry.verification.mismatchedUris)) return false;
  return true;
}

/** Typed, non-swallowing journal write: quota and serialization errors surface. */
export function recordRefactorRecoveryJournalV2(
  entry: RefactorRecoveryJournalEntryV2,
  storage: Storage = defaultRecoveryStorage(),
): RefactorJournalWriteResult {
  try {
    storage.setItem?.(`${RECOVERY_STORAGE_PREFIX_V2}${entry.recoveryId}`, JSON.stringify(entry));
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

export function getRefactorRecoveryJournalV2(
  recoveryId: string,
  storage: Storage = defaultRecoveryStorage(),
): RefactorRecoveryJournalEntryV2 | null {
  try {
    const raw = storage.getItem?.(`${RECOVERY_STORAGE_PREFIX_V2}${recoveryId}`);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return isRefactorRecoveryJournalEntryV2(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function listRefactorRecoveryJournalsV2(
  workspaceRoot?: string,
  storage: Storage = defaultRecoveryStorage(),
): RefactorRecoveryJournalListingV2 {
  const entries: RefactorRecoveryJournalEntryV2[] = [];
  let legacyCount = 0;
  let invalidCount = 0;
  try {
    const len = storage.length ?? 0;
    for (let i = 0; i < len; i += 1) {
      const key = storage.key?.(i);
      if (key?.startsWith(RECOVERY_STORAGE_PREFIX_V2)) {
        const raw = storage.getItem?.(key);
        if (!raw) continue;
        let parsed: unknown = null;
        try {
          parsed = JSON.parse(raw);
        } catch {
          invalidCount += 1;
          continue;
        }
        if (!isRefactorRecoveryJournalEntryV2(parsed)) {
          invalidCount += 1;
          continue;
        }
        if (!workspaceRoot || parsed.workspaceRoot === workspaceRoot) {
          entries.push(parsed);
        }
      } else if (key?.startsWith(RECOVERY_STORAGE_PREFIX)) {
        legacyCount += 1;
      }
    }
  } catch {
    // Storage itself unavailable; return whatever was collected so far.
  }
  return {
    entries: entries.sort((a, b) => b.createdAt - a.createdAt),
    legacyCount,
    invalidCount,
  };
}

/** Applies a status/field patch and persists it with a typed result. */
export function updateRefactorRecoveryJournalV2(
  recoveryId: string,
  patch: (entry: RefactorRecoveryJournalEntryV2) => RefactorRecoveryJournalEntryV2,
  storage: Storage = defaultRecoveryStorage(),
): RefactorJournalWriteResult {
  const current = getRefactorRecoveryJournalV2(recoveryId, storage);
  if (!current) return { ok: false, reason: `recovery journal ${recoveryId} is missing or invalid` };
  return recordRefactorRecoveryJournalV2(
    { ...patch(current), updatedAt: Date.now() },
    storage,
  );
}

export function clearRefactorRecoveryJournalV2(
  recoveryId: string,
  storage: Storage = defaultRecoveryStorage(),
): RefactorJournalWriteResult {
  try {
    storage.removeItem?.(`${RECOVERY_STORAGE_PREFIX_V2}${recoveryId}`);
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * RC-02: single pending predicate for v2 recovery entries. `prepared` and
 * `recovery-required` with no valid `user-dismissed` resolution are pending;
 * committed/rolled-back or dismissed entries are not. All auto-discover,
 * command-palette, and status surfaces must use this predicate instead of
 * copying the status filter expression.
 */
export function isPendingRefactorRecoveryEntry(entry: RefactorRecoveryJournalEntryV2): boolean {
  if (entry.status !== "prepared" && entry.status !== "recovery-required") return false;
  const resolution = entry.resolution;
  if (!resolution) return true;
  return !(
    resolution.kind === "user-dismissed"
    && resolution.reason === "keep-current-state"
    && typeof resolution.resolvedAt === "number"
  );
}

/**
 * RC-02: synchronously dismiss one pending entry (abandon this recovery
 * reminder, keep the current on-disk state). The read-compare-write happens
 * with no `await` in between so a single JS instance cannot interleave a
 * second dismiss/recover of the same record mid-flight; callers must still
 * serialize recover-vs-dismiss ownership per entry at the UI layer and
 * re-fetch the latest entry before calling (stale `expectedUpdatedAt`
 * fails instead of overwriting a newer transaction/recovery state).
 * The journal facts (status/pre/post/moves/verification) are preserved;
 * only the `resolution` marker and `updatedAt` change. Zero file writes.
 */
export function dismissRefactorRecoveryEntry(
  recoveryId: string,
  expectedUpdatedAt: number,
  storage: Storage = defaultRecoveryStorage(),
  now: number = Date.now(),
): RefactorJournalWriteResult {
  const current = getRefactorRecoveryJournalV2(recoveryId, storage);
  if (!current) return { ok: false, reason: `recovery journal ${recoveryId} is missing or invalid` };
  if (current.updatedAt !== expectedUpdatedAt) {
    return { ok: false, reason: "recovery entry changed since it was reviewed; refresh and confirm again" };
  }
  if (!isPendingRefactorRecoveryEntry(current)) {
    return { ok: false, reason: "recovery entry is no longer pending" };
  }
  return recordRefactorRecoveryJournalV2(
    {
      ...current,
      updatedAt: now,
      resolution: {
        kind: "user-dismissed",
        resolvedAt: now,
        reason: "keep-current-state",
      },
    },
    storage,
  );
}
