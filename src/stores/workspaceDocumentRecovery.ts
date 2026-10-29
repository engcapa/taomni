import type { WorkspaceDocumentState } from "./workspaceEditorStore";

export const WORKSPACE_DOCUMENT_RECOVERY_KEY = "taomni.workspaceDocuments.recovery.v1";

/** Only fields consumed during recovery need a synchronous journal write. */
export function workspaceDocumentRecoveryChanged(
  previous: WorkspaceDocumentState | undefined,
  next: WorkspaceDocumentState | undefined,
): boolean {
  if (!previous?.dirty && !next?.dirty) return false;
  if (!previous?.dirty || !next?.dirty) return true;
  return previous.path !== next.path || previous.text !== next.text
    || previous.savedText !== next.savedText || previous.savedHash !== next.savedHash
    || previous.language !== next.language;
}

export function readWorkspaceDocumentRecovery(): Record<string, WorkspaceDocumentState> {
  try {
    const data: unknown = JSON.parse(window.localStorage.getItem(WORKSPACE_DOCUMENT_RECOVERY_KEY) ?? "{}");
    if (!data || typeof data !== "object" || Array.isArray(data)) return {};
    const documents: Record<string, WorkspaceDocumentState> = {};
    for (const [id, value] of Object.entries(data)) {
      const entry = value as Partial<WorkspaceDocumentState> | null;
      if (!entry || typeof entry.path !== "string" || typeof entry.text !== "string" || typeof entry.savedText !== "string" || !entry.dirty) continue;
      documents[id] = {
        tabId: id, path: entry.path, text: entry.text, savedText: entry.savedText,
        savedHash: typeof entry.savedHash === "string" ? entry.savedHash : null,
        language: typeof entry.language === "string" ? entry.language : "plaintext",
        dirty: true, loading: false, error: null,
      };
    }
    return documents;
  } catch {
    return {};
  }
}

/** Synchronous writes include the last keystroke even when the app closes immediately. */
export function persistWorkspaceDocumentRecovery(documents: Record<string, WorkspaceDocumentState>): string | null {
  try {
    const dirty = Object.fromEntries(Object.entries(documents).filter(([, document]) => document.dirty));
    window.localStorage.setItem(WORKSPACE_DOCUMENT_RECOVERY_KEY, JSON.stringify(dirty));
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}
