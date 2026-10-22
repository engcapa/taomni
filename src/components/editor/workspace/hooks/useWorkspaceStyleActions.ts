import { useCallback } from "react";
import { type LspRange } from "../../../../lib/editor/lsp";
import { type EditorSelectionRange } from "../CodeMirrorHost";
import { errorMessage, type OpenFileState } from "../codeWorkspaceModel";
import { createExecuteAutoImportOnTheFly, createExecutePasteWithAutoImport, createRunCleanupExecute, createRunRearrangeExecute } from "../controller/styleActions";
import { useWorkspaceLspSession } from "../useWorkspaceLspSession";
import { useWorkspaceBufferState } from "./useWorkspaceBufferState";
import { useWorkspaceClipboard } from "./useWorkspaceClipboard";
import { useWorkspaceCodeActions } from "./useWorkspaceCodeActions";
import { useWorkspaceDocumentLanguage } from "./useWorkspaceDocumentLanguage";
import { useWorkspaceEditorCommands } from "./useWorkspaceEditorCommands";
import { useWorkspaceEditState } from "./useWorkspaceEditState";
import { useWorkspaceEditTransactions } from "./useWorkspaceEditTransactions";
import { useWorkspaceJavaCreation } from "./useWorkspaceJavaCreation";
import { useWorkspaceSave } from "./useWorkspaceSave";
import { useWorkspaceSemanticQueries } from "./useWorkspaceSemanticQueries";


export interface UseWorkspaceStyleActionsContext {
  documentLanguage: ReturnType<typeof useWorkspaceDocumentLanguage>;
  setStatusMessage: (message: string) => void;
  absolutePathForOpenFile: (file: OpenFileState) => string | null;
  editState: ReturnType<typeof useWorkspaceEditState>;
  saves: ReturnType<typeof useWorkspaceSave>;
  editorSelectionRef: import("react").RefObject<EditorSelectionRange>;
  updateFileText: (key: string, text: string) => void;
  codeActions: ReturnType<typeof useWorkspaceCodeActions>;
  bufferState: ReturnType<typeof useWorkspaceBufferState>;
  projectFactsRoot: string;
  javaCreation: ReturnType<typeof useWorkspaceJavaCreation>;
  clipboard: ReturnType<typeof useWorkspaceClipboard>;
  editorCommands: ReturnType<typeof useWorkspaceEditorCommands>;
  workspaceInstanceId: string;
  lsp: ReturnType<typeof useWorkspaceLspSession>;
  semanticQueries: ReturnType<typeof useWorkspaceSemanticQueries>;
  editTransactions: ReturnType<typeof useWorkspaceEditTransactions>;
}

export function useWorkspaceStyleActions(context: UseWorkspaceStyleActionsContext) {
  const {
    documentLanguage,
    setStatusMessage,
    absolutePathForOpenFile,
    editState,
    saves,
    editorSelectionRef,
    updateFileText,
    codeActions,
    bufferState,
    projectFactsRoot,
    javaCreation,
    clipboard,
    editorCommands,
    workspaceInstanceId,
    lsp,
    semanticQueries,
    editTransactions,
  } = context;

  const formatActiveFile = useCallback(async () => {
    const file = documentLanguage.activeFile;
    if (!file || file.loading) {
      setStatusMessage("No formattable file is open");
      return false;
    }
    const absPath = absolutePathForOpenFile(file) ?? file.languagePath;
    if (file.library || editState.workspaceResourceOperationLockedRef.current) {
      setStatusMessage(`${absPath} is read-only and cannot be reformatted`);
      return false;
    }
    try {
      const outcome = await saves.formatFileText(file, editorSelectionRef.current);
      if (outcome.state === "unavailable") {
        setStatusMessage(outcome.reason);
        return false;
      }
      if (outcome.state === "unchanged") {
        setStatusMessage(`${file.title} is already formatted`);
        return false;
      }
      updateFileText(file.key, outcome.text);
      setStatusMessage(`Formatted ${file.title}`);
      return true;
    } catch (error) {
      setStatusMessage(`Format failed: ${errorMessage(error)}`);
      return false;
    }
  }, [absolutePathForOpenFile, documentLanguage.activeFile, saves.formatFileText, setStatusMessage, updateFileText]);

  const optimizeImports = useCallback(async () => {
    const file = documentLanguage.activeFile;
    if (!file) return;
    const wholeFileRange: LspRange = {
      start: { line: 0, character: 0 },
      end: { line: file.text.split("\n").length, character: 0 },
    };
    const requested = await codeActions.requestCodeActions(
      file,
      wholeFileRange,
      [],
      ["source.organizeImports"],
    );
    if (requested.requestFailure) {
      // Stale keeps its context-specific wording; every other failure kind
      // already surfaced its accurate message on the status line.
      if (requested.requestFailure.kind === "stale") {
        setStatusMessage("Import optimization became stale because the workspace changed; request it again");
      }
      return;
    }
    if (!requested.actions.length) {
      setStatusMessage("No import optimization available from language server");
      return;
    }
    await codeActions.runCodeAction(requested.actions[0], file, requested.semanticToken);
    setStatusMessage("Imports organized");
  }, [documentLanguage.activeFile, codeActions.requestCodeActions, codeActions.runCodeAction, setStatusMessage]);

  /**
   * ED-IMPORT-001: Provider-backed on-the-fly auto-import.
   * Resolves unresolved symbol diagnostics against provider code actions,
   * enforces package priorities/exclusions, validates project facts generation (A3),
   * and auto-applies unambiguous imports or prompts for ambiguous candidates (A1).
   */
  const executeAutoImportOnTheFly = useCallback(createExecuteAutoImportOnTheFly({
    activeFile: documentLanguage.activeFile,
    lspFilesRef: bufferState.lspFilesRef,
    projectFactsRoot,
    requestCodeActions: codeActions.requestCodeActions,
    runCodeAction: codeActions.runCodeAction,
    setStatusMessage,
    setAutoImportCandidatePrompt: javaCreation.setAutoImportCandidatePrompt,
  }), [documentLanguage.activeFile, projectFactsRoot, codeActions.requestCodeActions, codeActions.runCodeAction, setStatusMessage]);

  /**
   * ED-IMPORT-001: Paste with auto-import resolution.
   * Scans pasted text for type tokens, resolves candidates via provider/classpath,
   * enforces independent paste preferences (A2), rejects stale generation (A3),
   * and executes paste + import statements in a single atomic transaction (A4).
   */
  const executePasteWithAutoImport = useCallback(createExecutePasteWithAutoImport({
    activeFile: documentLanguage.activeFile,
    clipboardHandle: clipboard.clipboardHandle,
    executeActiveEditorCommand: editorCommands.executeActiveEditorCommand,
    lspFilesRef: bufferState.lspFilesRef,
    projectFactsRoot,
    updateFileText,
    setStatusMessage,
    setAutoImportCandidatePrompt: javaCreation.setAutoImportCandidatePrompt,
  }), [
    documentLanguage.activeFile,
    clipboard.clipboardHandle,
    editorCommands.executeActiveEditorCommand,
    projectFactsRoot,
    setStatusMessage,
    updateFileText,
  ]);

  // ED-AUDIT-015: production execute owner for Rearrange Code. The action
  // entry below only checks that a file is open; every capability decision,
  // provider request, preview confirm, apply and postcondition check lives
  // here and in executeRearrangeTransaction, so a supported decision can
  // never again degrade to a bare status message plus `return true`.
  const runRearrangeExecute = useCallback(createRunRearrangeExecute({
    workspaceInstanceId,
    rearrangeRequestTokenRef: editState.rearrangeRequestTokenRef,
    absolutePathForOpenFile,
    lspDescriptorForFile: lsp.descriptorForFile,
    setStatusMessage,
    lspFilesRef: bufferState.lspFilesRef,
    openFilesRef: bufferState.openFilesRef,
    workspaceInstanceIdRef: semanticQueries.workspaceInstanceIdRef,
    requestCodeActions: codeActions.requestCodeActions,
    lspDocumentVersion: lsp.documentVersion,
    workspaceResourceOperationLockedRef: editState.workspaceResourceOperationLockedRef,
    lspSessionGeneration: lsp.sessionGeneration,
    applyLspWorkspaceEdit: editTransactions.applyLspWorkspaceEdit,
    activeCapabilities: documentLanguage.activeCapabilities,
    activeLspState: documentLanguage.activeLspState,
  }), [
    absolutePathForOpenFile,
    documentLanguage.activeCapabilities,
    documentLanguage.activeLspState,
    editTransactions.applyLspWorkspaceEdit,
    lsp.descriptorForFile,
    lsp.documentVersion,
    lsp.sessionGeneration,
    codeActions.requestCodeActions,
    workspaceInstanceId,
  ]);

  // ED-AUDIT-016: production execute owner for Code Cleanup. The fake
  // success stub is gone: the file-scope default-profile branch performs a
  // real request or a real typed failure, mirroring the rearrange owner.
  const runCleanupExecute = useCallback(createRunCleanupExecute({
    workspaceInstanceId,
    cleanupRequestTokenRef: editState.cleanupRequestTokenRef,
    absolutePathForOpenFile,
    lspDescriptorForFile: lsp.descriptorForFile,
    setStatusMessage,
    lspFilesRef: bufferState.lspFilesRef,
    openFilesRef: bufferState.openFilesRef,
    workspaceInstanceIdRef: semanticQueries.workspaceInstanceIdRef,
    requestCodeActions: codeActions.requestCodeActions,
    lspDocumentVersion: lsp.documentVersion,
    workspaceResourceOperationLockedRef: editState.workspaceResourceOperationLockedRef,
    lspSessionGeneration: lsp.sessionGeneration,
    applyLspWorkspaceEdit: editTransactions.applyLspWorkspaceEdit,
    activeCapabilities: documentLanguage.activeCapabilities,
    activeLspState: documentLanguage.activeLspState,
  }), [
    absolutePathForOpenFile,
    documentLanguage.activeCapabilities,
    documentLanguage.activeLspState,
    editTransactions.applyLspWorkspaceEdit,
    lsp.descriptorForFile,
    lsp.documentVersion,
    lsp.sessionGeneration,
    codeActions.requestCodeActions,
    workspaceInstanceId,
  ]);
  return {
    executeAutoImportOnTheFly,
    executePasteWithAutoImport,
    optimizeImports,
    runRearrangeExecute,
    runCleanupExecute,
    formatActiveFile,
  };
}
