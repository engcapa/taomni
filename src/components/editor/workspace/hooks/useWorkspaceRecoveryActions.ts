import { useCallback } from "react";
import { type EditorGroupId } from "../../../../stores/codeWorkspaceStore";
import type { CodeWorkspaceFileRef, CodeWorkspaceRootInfo } from "../../../../types";
import { errorMessage, normalizeEditorText, type LspFileState, type OpenFileState } from "../codeWorkspaceModel";
import {
  readWorkspaceRecoveryEntries,
  removeWorkspaceRecoveryEntry,
  resolveDiskEffectLedgerEntry,
  writeWorkspaceRecoveryEntries,
  type WorkspaceDiskEffectLedgerEntryV4,
  type WorkspaceRecoveryEntry,
} from "../workspaceRecovery";
import { useWorkspaceRecoveryState } from "./useWorkspaceRecoveryState";


export interface UseWorkspaceRecoveryActionsContext {
  recoveryState: ReturnType<typeof useWorkspaceRecoveryState>;
  workspaceInstanceId: string;
  setStatusMessage: (message: string) => void;
  openFile: (ref: CodeWorkspaceFileRef, options?: { preview?: boolean; groupId?: EditorGroupId; activate?: boolean; restoring?: boolean; isCurrent?: () => boolean; }) => Promise<{ canonicalFileKey: string; groupId: string; error: string | null; } | null>;
  openFilesRef: import("react").RefObject<Record<string, import("../editorGroupTypes").OpenFileViewModel>>;
  setOpenFiles: (updater: Record<string, OpenFileState> | ((prev: Record<string, OpenFileState>) => Record<string, OpenFileState>)) => void;
  lspFilesRef: import("react").RefObject<Record<string, LspFileState>>;
  syncLspDocument: (file: OpenFileState, mode: "open" | "change") => Promise<void>;
  roots: CodeWorkspaceRootInfo[];
}

export function useWorkspaceRecoveryActions(context: UseWorkspaceRecoveryActionsContext) {
  const { recoveryState, workspaceInstanceId, setStatusMessage, openFile, openFilesRef, setOpenFiles, lspFilesRef, syncLspDocument, roots } = context;

  const removeRecoveryEntry = useCallback((entry: WorkspaceRecoveryEntry) => {
    recoveryState.pendingWorkspaceRecoveryKeysRef.current.delete(entry.key);
    const next = removeWorkspaceRecoveryEntry(workspaceInstanceId, entry.key);
    recoveryState.setWorkspaceRecoveryEntries(next);
    if (next.length === 0) recoveryState.setWorkspaceRecoveryOpen(false);
  }, [workspaceInstanceId]);

  const discardWorkspaceRecoveryEntry = useCallback((entry: WorkspaceRecoveryEntry) => {
    removeRecoveryEntry(entry);
    setStatusMessage(`Discarded recovery snapshot for ${entry.path}`);
  }, [removeRecoveryEntry, setStatusMessage]);

  const discardAllWorkspaceRecoveryEntries = useCallback(() => {
    recoveryState.pendingWorkspaceRecoveryKeysRef.current.clear();
    writeWorkspaceRecoveryEntries(workspaceInstanceId, []);
    recoveryState.setWorkspaceRecoveryEntries([]);
    recoveryState.setWorkspaceRecoveryOpen(false);
    setStatusMessage("Discarded workspace recovery snapshots");
  }, [setStatusMessage, workspaceInstanceId]);

  const recoverWorkspaceEntry = useCallback(async (entry: WorkspaceRecoveryEntry): Promise<boolean> => {
    try {
      await openFile(entry.ref, { preview: false });
      const latest = openFilesRef.current[entry.key]
        ?? Object.values(openFilesRef.current).find((candidate) => (
          candidate.ref.kind === entry.ref.kind
          && candidate.ref.path === entry.ref.path
          && (candidate.ref.kind === "root"
            ? entry.ref.kind === "root" && candidate.ref.rootId === entry.ref.rootId
            : entry.ref.kind === "loose" && candidate.ref.id === entry.ref.id)
        ));
      if (!latest || latest.loading || latest.error) {
        throw new Error(latest?.error ?? `Cannot open ${entry.path}`);
      }
      const recovered = normalizeEditorText(entry.text).text;
      const next: OpenFileState = {
        ...latest,
        text: recovered,
        eol: entry.eol,
        encoding: entry.encoding ?? latest.encoding ?? "UTF-8",
        bom: entry.bom ?? latest.bom ?? false,
        dirty: recovered !== latest.savedText,
        error: null,
      };
      setOpenFiles((current) => ({ ...current, [latest.key]: next }));
      if (latest.text !== next.text && lspFilesRef.current[latest.key]?.status?.active) {
        void syncLspDocument(next, "change");
      }
      removeRecoveryEntry(entry);
      setStatusMessage(`Recovered unsaved changes for ${latest.subtitle}`);
      return true;
    } catch (error) {
      setStatusMessage(`Cannot recover ${entry.path}: ${errorMessage(error)}`);
      return false;
    }
  }, [openFile, removeRecoveryEntry, setOpenFiles, setStatusMessage, syncLspDocument]);

  const recoverAllWorkspaceEntries = useCallback(async () => {
    const entries = readWorkspaceRecoveryEntries(workspaceInstanceId);
    let recovered = 0;
    for (const entry of entries) {
      if (await recoverWorkspaceEntry(entry)) recovered += 1;
    }
    const remaining = readWorkspaceRecoveryEntries(workspaceInstanceId);
    recoveryState.setWorkspaceRecoveryEntries(remaining);
    recoveryState.setWorkspaceRecoveryOpen(remaining.length > 0);
    if (recovered > 1) setStatusMessage(`Recovered ${recovered} unsaved files`);
  }, [recoverWorkspaceEntry, setStatusMessage, workspaceInstanceId]);

  /** §8.19.1: Acknowledge clears only the explicitly selected ledger row. */
  const acknowledgeDiskEffectLedgerEntry = useCallback((entry: WorkspaceDiskEffectLedgerEntryV4) => {
    resolveDiskEffectLedgerEntry(entry.workspaceId, entry.transactionId, entry.path);
    recoveryState.bumpDiskEffectLedger();
    setStatusMessage(`Acknowledged disk result for ${entry.path}`);
  }, [recoveryState.bumpDiskEffectLedger, setStatusMessage]);

  /** §8.19.1: Reopen loads the file as it exists on disk right now. */
  const reopenDiskEffectLedgerFile = useCallback((entry: WorkspaceDiskEffectLedgerEntryV4) => {
    // fileIdentity is `root:<rootId>:<path>` / `loose:<id>:<path>`; fall back
    // to a root scan when only the absolute path is known.
    const identity = entry.fileIdentity;
    let ref: CodeWorkspaceFileRef | null = null;
    if (identity.startsWith("root:")) {
      const [, rootId, ...rest] = identity.split(":");
      if (rootId && rest.length > 0) ref = { kind: "root", rootId, path: rest.join(":") };
    } else if (identity.startsWith("loose:")) {
      const [, id, ...rest] = identity.split(":");
      if (id && rest.length > 0) ref = { kind: "loose", id, path: rest.join(":") };
    }
    if (!ref) {
      const matchingRoot = roots.find(
        (root) => entry.path.startsWith(root.path + "/") || entry.path === root.path,
      );
      if (matchingRoot) {
        ref = {
          kind: "root",
          rootId: matchingRoot.id,
          path: entry.path.slice(matchingRoot.path.length).replace(/^\/+/, ""),
        };
      }
    }
    if (!ref) {
      setStatusMessage(`Cannot reopen ${entry.path}: it is outside the workspace roots`);
      return;
    }
    void openFile(ref, { preview: true });
    setStatusMessage(`Opened ${entry.path} from disk; compare it with your editor state before acknowledging`);
  }, [openFile, roots, setStatusMessage]);
  return {
    recoverWorkspaceEntry,
    discardWorkspaceRecoveryEntry,
    recoverAllWorkspaceEntries,
    discardAllWorkspaceRecoveryEntries,
    acknowledgeDiskEffectLedgerEntry,
    reopenDiskEffectLedgerFile,
  };
}
