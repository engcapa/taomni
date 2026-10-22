import { useCallback } from "react";
import { workspaceReadFileWithEncoding, workspaceReadLooseFileWithEncoding, type WorkspaceFile } from "../../../../lib/editor/workspace";
import { lspReloadProject, type LspDocumentDescriptor } from "../../../../lib/editor/lsp";
import { type ExplicitIndentationOverride } from "../codeStyleModel";
import type { ResolvedCodeStyle } from "../editorConfigResolver";
import { type PreparedSaveCommitter, type WorkspaceStyleController } from "../workspaceStyleController";
import { resolveUnknownDiskResolution, SaveTransactionRegistry, type DiskResolution, type PreparedSave, type SaveCommitResult } from "../saveCommit";
import { type SaveObservationRecord } from "../saveObservationContract";
import { recordDiskEffectLedgerEntry, workspaceFileIdentity, type WorkspaceDiskEffectLedgerEntryV4 } from "../workspaceRecovery";
import { type CodeStyleSchemeStoreState } from "../workspaceCodeStyleSchemes";
import { confirmAppDialog } from "../../../../lib/appDialogs";
import { WorkspaceObservationBridge } from "../workspaceObservationBridge";
import { type WorkspaceIntelligencePreferences } from "../intelligencePreferences";
import { CanonicalCodeActionService } from "../codeActionProviderAdapter";
import type { CodeWorkspaceRootInfo } from "../../../../types";
import { type LspFileState, type OpenFileState, errorMessage } from "../codeWorkspaceModel";
import { createCommitClosedFilePreparedSave, createSaveFile } from "../controller/saveActions";
import { createCommitOpenBufferPreparedSave } from "../controller/openBufferSave";
import { createWriteTextSnapshot, createSaveOpenBufferText, createFormatFileText, createReloadFile } from "../controller/bufferMutations";

export interface UseWorkspaceSaveContext {
  openFilesRef: import("react").RefObject<Record<string, import("../editorGroupTypes").OpenFileViewModel>>;
  rootsRef: import("react").RefObject<CodeWorkspaceRootInfo[]>;
  bumpDiskEffectLedger: () => void;
  saveTransactionRegistryRef: import("react").RefObject<SaveTransactionRegistry>;
  mutateOpenBuffer: (key: string, patch: import("../controller/mutationTypes").BufferMutationPatch, reason: import("../controller/mutationTypes").MutationReason) => OpenFileState | null;
  absolutePathForOpenFile: (file: OpenFileState) => string | null;
  workspaceStyleControllerRef: import("react").RefObject<WorkspaceStyleController>;
  notifyWorkspacePathGitChanged: (rootId: string, path: string) => void;
  semanticIndex: import("../useWorkspaceSemanticIndex").WorkspaceSemanticIndexController;
  saveLspDocument: (file: OpenFileState, text: string) => Promise<void>;
  syncLspDocument: (file: OpenFileState, mode: "open" | "change") => Promise<void>;
  workspaceInstanceId: string;
  lspDescriptorForFile: (file: OpenFileState) => LspDocumentDescriptor | null;
  lspFilesRef: import("react").RefObject<Record<string, LspFileState>>;
  indentationOverridesRef: import("react").RefObject<Record<string, ExplicitIndentationOverride | null>>;
  codeStyleSchemesRef: import("react").RefObject<CodeStyleSchemeStoreState>;
  resolvedCodeStylesRef: import("react").RefObject<Record<string, ResolvedCodeStyle>>;
  updateLspStatusForFile: (file: OpenFileState, status: import("../../../../lib/editor/lsp").LspDocumentStatus) => void;
  findRoot: (rootId: string) => CodeWorkspaceRootInfo | null;
  setStatusMessage: (message: string) => void;
  activeKey: string | null;
  lspSessionGeneration: () => number;
  projectAnalysisSnapshot: import("../projectAnalysisModel").JavaProjectAnalysisSnapshotV1 | null;
  intelligencePreferences: WorkspaceIntelligencePreferences;
  canonicalCodeActionServiceRef: import("react").RefObject<CanonicalCodeActionService | null>;
  setSaveObservations: import("react").Dispatch<import("react").SetStateAction<Record<string, SaveObservationRecord>>>;
  publishWorkspaceObservation: (update: (bridge: WorkspaceObservationBridge) => void) => void;
  setOpenFiles: (updater: Record<string, OpenFileState> | ((prev: Record<string, OpenFileState>) => Record<string, OpenFileState>)) => void;
}

export function useWorkspaceSave(context: UseWorkspaceSaveContext) {
  const {
    openFilesRef,
    rootsRef,
    bumpDiskEffectLedger,
    saveTransactionRegistryRef,
    mutateOpenBuffer,
    absolutePathForOpenFile,
    workspaceStyleControllerRef,
    notifyWorkspacePathGitChanged,
    semanticIndex,
    saveLspDocument,
    syncLspDocument,
    workspaceInstanceId,
    lspDescriptorForFile,
    lspFilesRef,
    indentationOverridesRef,
    codeStyleSchemesRef,
    resolvedCodeStylesRef,
    updateLspStatusForFile,
    findRoot,
    setStatusMessage,
    activeKey,
    lspSessionGeneration,
    projectAnalysisSnapshot,
    intelligencePreferences,
    setSaveObservations,
    publishWorkspaceObservation,
    setOpenFiles,
  } = context;

  const writeTextSnapshot = useCallback(createWriteTextSnapshot({
    openFilesRef,
    rootsRef,
  }), []);

  /**
   * Re-read verification for an unknown-effect IPC failure (§8.18.1): the
   * native layer could not prove whether bytes landed, so the frontend reads
   * the real file back and classifies against the intended/old hashes.
   * Returns null when even the read fails — that stays `unknown`.
   */
  const readBackDiskSnapshot = useCallback(async (
    prepared: PreparedSave,
  ): Promise<Pick<WorkspaceFile, "hash" | "text" | "encoding" | "bom" | "size" | "mtime"> | null> => {
    try {
      const matchingRoot = rootsRef.current.find(
        (r) => prepared.filePath.startsWith(r.path + "/") || prepared.filePath === r.path,
      );
      if (matchingRoot) {
        const relPath = prepared.filePath.slice(matchingRoot.path.length).replace(/^\/+/, "");
        const read = await workspaceReadFileWithEncoding(matchingRoot.path, relPath, prepared.policy.encoding);
        return read ?? null;
      }
      return await workspaceReadLooseFileWithEncoding(prepared.filePath, prepared.policy.encoding);
    } catch {
      return null;
    }
  }, []);

  /**
   * Record one unresolved unknown-effect ledger row for the recovery center
   * (§8.19.1): the row carries the native intent hash (non-null whenever the
   * encoded bytes were computed) and its blocking is decided by `resolution`
   * — a foreign observed hash never counts as verified.
   */
  const recordUnknownDiskEffect = useCallback((
    prepared: PreparedSave,
    observedHash: string | null,
    intendedNewHash: string | null,
  ): void => {
    const resolution: DiskResolution = resolveUnknownDiskResolution({
      intendedNewHash,
      expectedOldHash: prepared.expectedDiskHash,
      observedHash,
    });
    recordDiskEffectLedgerEntry({
      schemaVersion: 4,
      workspaceId: prepared.workspaceId,
      transactionId: prepared.transactionId,
      operationId: "save",
      path: prepared.filePath,
      fileIdentity: (() => {
        const file = openFilesRef.current[prepared.fileKey];
        return file ? workspaceFileIdentity(file.ref) : prepared.filePath;
      })(),
      expectedOldHash: prepared.expectedDiskHash,
      intendedNewHash,
      observedHash,
      diskEffect: "unknown",
      memoryEffect: "unchanged",
      providerEffect: "unknown",
      resolution,
      createdAt: Date.now(),
      // Only confirmed resolutions may claim verification; blocked rows keep
      // a null timestamp so no legacy field can act as "unblocked".
      verifiedAt: resolution === "confirmed-committed" || resolution === "confirmed-none"
        ? Date.now()
        : null,
      resolvedAt: null,
    });
    bumpDiskEffectLedger();
  }, [bumpDiskEffectLedger]);

  /**
   * Record the fact that bytes provably landed on disk but every editor
   * writeback was discarded (§8.19.1): the recovery center shows
   * "saved to disk, buffer state discarded" with Reopen/Acknowledge instead
   * of silently dropping a real disk effect.
   */
  const recordCommittedDiscardLedgerEntry = useCallback((
    prepared: PreparedSave,
    writtenHash: string,
  ): void => {
    const now = Date.now();
    const entry: WorkspaceDiskEffectLedgerEntryV4 = {
      schemaVersion: 4,
      workspaceId: prepared.workspaceId,
      transactionId: prepared.transactionId,
      operationId: "save",
      path: prepared.filePath,
      fileIdentity: prepared.fileKey.startsWith("closed:")
        ? prepared.fileKey.slice("closed:".length)
        : (() => {
          const file = openFilesRef.current[prepared.fileKey];
          return file ? workspaceFileIdentity(file.ref) : prepared.filePath;
        })(),
      expectedOldHash: prepared.expectedDiskHash,
      intendedNewHash: writtenHash,
      observedHash: writtenHash,
      diskEffect: "committed",
      memoryEffect: "writeback-discarded",
      providerEffect: "discarded",
      resolution: "confirmed-committed",
      createdAt: now,
      verifiedAt: now,
      resolvedAt: null,
    };
    recordDiskEffectLedgerEntry(entry);
    bumpDiskEffectLedger();
  }, [bumpDiskEffectLedger]);

  /**
   * Shared closed-file committer (§8.19.1). Closed-file WorkspaceEdit writes
   * go through the same PreparedSave identity, byte writer, unknown-effect
   * read-back, recovery ledger and generation-gated watcher effects as
   * open-buffer saves, and return the full typed result — callers must never
   * treat an uncertain write as success.
   */
  const commitClosedFilePreparedSave = useCallback(createCommitClosedFilePreparedSave({
    saveTransactionRegistryRef,
    rootsRef,
    get cancelledSaveCommit() { return cancelledSaveCommit; },
    writeTextSnapshot,
    readBackDiskSnapshot,
    recordUnknownDiskEffect,
    recordCommittedDiscardLedgerEntry,
  }), [
    readBackDiskSnapshot,
    recordCommittedDiscardLedgerEntry,
    recordUnknownDiskEffect,
    writeTextSnapshot,
  ]);

  /** Typed cancellation with provably zero disk effect (§8.18.1). */
  function cancelledSaveCommit(
    prepared: PreparedSave,
    phase: "prepare" | "pre-write",
    reason: string,
  ): SaveCommitResult {
    return {
      kind: "cancelled",
      transactionId: prepared.transactionId,
      diskEffect: "none",
      memoryEffect: "unchanged",
      providerEffect: "not-sent",
      phase,
      reason,
    };
  }

  /**
   * Single open-buffer save commit core (§8.18.1). Takes an immutable
   * PreparedSave, registers a transaction owner, runs the synchronous
   * pre-write boundary, invokes the one byte writer in the same turn, then is
   * the ONLY result classifier: it reports disk / memory / provider effects
   * verbatim. Bytes landed can never yield plain `cancelled`;
   * close/rename/unmount after the write yields
   * `committed-writeback-discarded`; an uncertain IPC failure is re-read
   * against hashes instead of pretending zero side effects.
   */
  const commitOpenBufferPreparedSave = useCallback(createCommitOpenBufferPreparedSave({
    saveTransactionRegistryRef,
    openFilesRef,
    cancelledSaveCommit,
    mutateOpenBuffer,
    absolutePathForOpenFile,
    workspaceStyleControllerRef,
    writeTextSnapshot,
    readBackDiskSnapshot,
    recordUnknownDiskEffect,
    recordCommittedDiscardLedgerEntry,
    notifyWorkspacePathGitChanged,
    semanticIndex,
    saveLspDocument,
    syncLspDocument,
  }), [
    absolutePathForOpenFile,
    mutateOpenBuffer,
    notifyWorkspacePathGitChanged,
    readBackDiskSnapshot,
    recordCommittedDiscardLedgerEntry,
    recordUnknownDiskEffect,
    saveLspDocument,
    semanticIndex.invalidate,
    syncLspDocument,
    writeTextSnapshot,
  ]) as PreparedSaveCommitter;

  /** Public open-buffer save: prepares one transaction, then commits it. */
  const saveOpenBufferText = useCallback(createSaveOpenBufferText({
    openFilesRef,
    absolutePathForOpenFile,
    workspaceInstanceId,
    workspaceStyleControllerRef,
    commitOpenBufferPreparedSave,
  }), [
    absolutePathForOpenFile,
    commitOpenBufferPreparedSave,
    workspaceInstanceId,
  ]);

  const formatFileText = useCallback(createFormatFileText({
    lspDescriptorForFile,
    lspFilesRef,
    absolutePathForOpenFile,
    workspaceStyleControllerRef,
    indentationOverridesRef,
    codeStyleSchemesRef,
    resolvedCodeStylesRef,
    updateLspStatusForFile,
  }), [absolutePathForOpenFile, findRoot, lspDescriptorForFile, updateLspStatusForFile, workspaceInstanceId]);

  const promptReloadProject = useCallback(
    async (key: string, subtitle: string) => {
      const file = openFilesRef.current[key];
      if (!file) return;
      const descriptor = lspDescriptorForFile(file);
      if (!descriptor) return;
      const confirmed = await confirmAppDialog({
        title: "Reload Java project",
        message: `${subtitle} changed. Reload the project so the language server picks up dependency and classpath changes?`,
        confirmLabel: "Reload",
      });
      if (!confirmed) return;
      try {
        await lspReloadProject(descriptor);
        setStatusMessage("Reloading Java project…");
      } catch (err) {
        setStatusMessage(errorMessage(err));
      }
    },
    [lspDescriptorForFile, setStatusMessage],
  );

  const saveFile = useCallback(
    createSaveFile({
    activeKey,
    openFilesRef,
    absolutePathForOpenFile,
    workspaceInstanceId,
    setStatusMessage,
    workspaceStyleControllerRef,
    lspDescriptorForFile,
    lspFilesRef,
    findRoot,
    lspSessionGeneration,
    projectAnalysisSnapshot,
    indentationOverridesRef,
    codeStyleSchemesRef,
    intelligencePreferences,
    commitOpenBufferPreparedSave,
    formatFileText,
    get canonicalCodeActionServiceRef() { return context.canonicalCodeActionServiceRef; },
    setSaveObservations,
    publishWorkspaceObservation,
    promptReloadProject,
  }),
    [
      activeKey,
      commitOpenBufferPreparedSave,
      formatFileText,
      findRoot,
      intelligencePreferences.formatOnSave,
      lspDescriptorForFile,
      lspSessionGeneration,
      publishWorkspaceObservation,
      promptReloadProject,
      projectAnalysisSnapshot?.projectFingerprint,
      setStatusMessage,
      workspaceInstanceId,
    ],
  );

  const reloadFile = useCallback(
    createReloadFile({
    activeKey,
    openFilesRef,
    setStatusMessage,
    setOpenFiles,
    findRoot,
    mutateOpenBuffer,
  }),
    [activeKey, findRoot, mutateOpenBuffer, setStatusMessage],
  );
  return {
    formatFileText,
    saveOpenBufferText,
    commitClosedFilePreparedSave,
    saveFile,
    reloadFile,
  };
}
