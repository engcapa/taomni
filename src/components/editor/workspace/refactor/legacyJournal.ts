import { sha256Hex } from "../projectAnalysisModel";
import { applyLspTextEditsToString } from "../lspTextEdits";
import { type RefactorPlanV4, type RefactorRecoveryJournalEntry, type RefactorRecoveryDocumentSnapshot } from "./types";

export function buildRefactorRecoveryJournalEntry(
  plan: RefactorPlanV4,
  preTexts: Record<string, string>,
  workspaceRoot: string,
): RefactorRecoveryJournalEntry | null {
  const documents: RefactorRecoveryDocumentSnapshot[] = [];
  for (const doc of plan.documents) {
    const text = preTexts[doc.uri] ?? (doc.canonicalPath ? preTexts[doc.canonicalPath] : undefined);
    if (text === undefined) return null;
    const preHash = sha256Hex(text);
    const docEdits = plan.operations.flatMap((op) => {
      if (op.kind === "text") {
        const opUri = op.document.uri || "";
        const opPath = op.document.path || "";
        if (opUri === doc.uri || (doc.canonicalPath && opPath === doc.canonicalPath)) {
          return op.document.edits;
        }
      }
      return [];
    });
    const postText = docEdits.length > 0 ? applyLspTextEditsToString(text, docEdits) : text;
    const postHash = sha256Hex(postText);
    documents.push({
      uri: doc.uri,
      canonicalPath: doc.canonicalPath,
      preText: text,
      preHash,
      postText,
      postHash,
    });
  }
  return {
    recoveryId: `ref-rec-${sha256Hex(`${plan.actionId}:${Date.now()}`).slice(0, 16)}`,
    actionId: plan.actionId,
    kind: plan.kind,
    workspaceRoot,
    createdAt: Date.now(),
    status: "prepared",
    documents: Object.freeze(documents),
  };
}

export const RECOVERY_STORAGE_PREFIX = "taomni.refactor.recovery.v1:";

export function recordRefactorRecoveryJournal(
  entry: RefactorRecoveryJournalEntry,
  storage: Storage = typeof window !== "undefined" ? window.localStorage : ({} as Storage),
): void {
  try {
    storage.setItem?.(`${RECOVERY_STORAGE_PREFIX}${entry.recoveryId}`, JSON.stringify(entry));
  } catch {
    // Non-blocking quota failure
  }
}

export function getRefactorRecoveryJournal(
  recoveryId: string,
  storage: Storage = typeof window !== "undefined" ? window.localStorage : ({} as Storage),
): RefactorRecoveryJournalEntry | null {
  try {
    const raw = storage.getItem?.(`${RECOVERY_STORAGE_PREFIX}${recoveryId}`);
    return raw ? (JSON.parse(raw) as RefactorRecoveryJournalEntry) : null;
  } catch {
    return null;
  }
}

export function listRefactorRecoveryJournals(
  workspaceRoot?: string,
  storage: Storage = typeof window !== "undefined" ? window.localStorage : ({} as Storage),
): RefactorRecoveryJournalEntry[] {
  const entries: RefactorRecoveryJournalEntry[] = [];
  try {
    const len = storage.length ?? 0;
    for (let i = 0; i < len; i += 1) {
      const key = storage.key?.(i);
      if (key?.startsWith(RECOVERY_STORAGE_PREFIX)) {
        const raw = storage.getItem?.(key);
        if (raw) {
          const parsed = JSON.parse(raw) as RefactorRecoveryJournalEntry;
          if (!workspaceRoot || parsed.workspaceRoot === workspaceRoot) {
            entries.push(parsed);
          }
        }
      }
    }
  } catch {
    // Return available entries
  }
  return entries.sort((a, b) => b.createdAt - a.createdAt);
}

export function clearRefactorRecoveryJournal(
  recoveryId: string,
  storage: Storage = typeof window !== "undefined" ? window.localStorage : ({} as Storage),
): void {
  try {
    storage.removeItem?.(`${RECOVERY_STORAGE_PREFIX}${recoveryId}`);
  } catch {
    // Ignore storage deletion errors
  }
}
