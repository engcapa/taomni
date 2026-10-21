import { useCallback, useEffect, useRef, useState } from "react";
import { lspCodeActionResolve, type LspCodeAction, type LspWorkspaceEdit } from "../../../../lib/editor/lsp";
import { CanonicalCodeActionService } from "../codeActionProviderAdapter";
import { type OpenFileState } from "../codeWorkspaceModel";
import { createRequestCodeActions, createRunCodeAction } from "../controller/codeActionActions";
import { type WorkspaceEditApplyOptions } from "../controller/mutationTypes";
import { diagnosticInspectionId } from "../inspectionProfile";
import { IntentionSession } from "../intentionSession";
import { type RefactorPlanV3 } from "../refactorPlan";
import { useWorkspaceLspSession } from "../useWorkspaceLspSession";
import { useWorkspaceProjectAnalysis } from "../useWorkspaceProjectAnalysis";
import { useWorkspaceSemanticIndex } from "../useWorkspaceSemanticIndex";
import { type WorkspaceEditPreview } from "../workspaceEditPreview";
import { useSymbolRefactoring } from "./useSymbolRefactoring";
import { useWorkspaceBufferState } from "./useWorkspaceBufferState";
import { useWorkspaceDocumentSync } from "./useWorkspaceDocumentSync";
import { useWorkspaceEditSnapshots } from "./useWorkspaceEditSnapshots";
import { useWorkspaceEditState } from "./useWorkspaceEditState";
import { useWorkspaceInspections } from "./useWorkspaceInspections";
import { useWorkspaceTreeModel } from "./useWorkspaceTreeModel";


export interface UseWorkspaceCodeActionsContext {
  bufferState: ReturnType<typeof useWorkspaceBufferState>;
  semanticIndex: ReturnType<typeof useWorkspaceSemanticIndex>;
  documents: ReturnType<typeof useWorkspaceDocumentSync>;
  setStatusMessage: (message: string) => void;
  lsp: ReturnType<typeof useWorkspaceLspSession>;
  projectAnalysis: ReturnType<typeof useWorkspaceProjectAnalysis>;
  workspaceInstanceId: string;
  inspections: ReturnType<typeof useWorkspaceInspections>;
  projectTree: ReturnType<typeof useWorkspaceTreeModel>;
  editSnapshots: ReturnType<typeof useWorkspaceEditSnapshots>;
  applyLspWorkspaceEdit: (edit: LspWorkspaceEdit, options?: WorkspaceEditApplyOptions) => Promise<import("../workspaceEditApply").WorkspaceEditApplyOutcome[]>;
  refactoring: ReturnType<typeof useSymbolRefactoring>;
  editState: ReturnType<typeof useWorkspaceEditState>;
}

export function useWorkspaceCodeActions(context: UseWorkspaceCodeActionsContext) {
  const {
    bufferState,
    semanticIndex,
    documents,
    setStatusMessage,
    lsp,
    projectAnalysis,
    workspaceInstanceId,
    inspections,
    projectTree,
    editSnapshots,
    applyLspWorkspaceEdit,
    editState,
  } = context;

  const requestCodeActions = useCallback(createRequestCodeActions({
    lspFilesRef: bufferState.lspFilesRef,
    semanticIndex,
    ensureWorkspaceSemanticDocumentsSynced: documents.ensureWorkspaceSemanticDocumentsSynced,
    setStatusMessage,
    lspDescriptorForFile: lsp.descriptorForFile,
    lspSessionGeneration: lsp.sessionGeneration,
    projectAnalysisSnapshot: projectAnalysis.snapshot,
    updateLspStatusForFile: lsp.updateStatus,
    get canonicalCodeActionServiceRef() { return canonicalCodeActionServiceRef; },
  }), [
    documents.ensureWorkspaceSemanticDocumentsSynced,
    lsp.descriptorForFile,
    lsp.sessionGeneration,
    projectAnalysis.snapshot?.projectFingerprint,
    semanticIndex.beginBuild,
    semanticIndex.current,
    semanticIndex.failBuild,
    semanticIndex.finishQuery,
    setStatusMessage,
    lsp.updateStatus,
  ]);

  // §8.20.4 W3: ONE frozen Intention session per request, shared by Alt+Enter,
  // the gutter bulb, Problems quick fix and Search Actions. Candidates carry
  // stable ids; resolve state and disabled reasons live here, not in UI copies.
  const intentionSessionRef = useRef<IntentionSession | null>(null);
  const canonicalCodeActionServiceRef = useRef<CanonicalCodeActionService | null>(null);
  if (!canonicalCodeActionServiceRef.current) canonicalCodeActionServiceRef.current = new CanonicalCodeActionService();
  const intentionRequestAbortRef = useRef<AbortController | null>(null);
  useEffect(() => {
    // StrictMode replays setup after cleanup in tauri dev. A disposed session
    // cannot be reused: each setup owns a fresh session and cleans up exactly
    // that instance, including requests from a previous workspace binding.
    const session = new IntentionSession();
    intentionSessionRef.current = session;
    return () => {
      intentionRequestAbortRef.current?.abort();
      intentionRequestAbortRef.current = null;
      session.dispose();
      if (intentionSessionRef.current === session) intentionSessionRef.current = null;
    };
  }, [workspaceInstanceId]);
  // Diagnostics whose provider suppression edit applied successfully
  // ("Suppressed in source"); distinct from local hide (profile suppressions).
  const [suppressedInSourceKeys, setSuppressedInSourceKeys] = useState<Set<string>>(new Set());
  const markProviderSuppressionApplied = useCallback((action: LspCodeAction, file: OpenFileState) => {
    if (!/suppress/i.test(`${action.kind ?? ""} ${action.title}`)) return;
    const path = inspections.inspectionPathForFileKey(file.key);
    const diagnostics = bufferState.lspFilesRef.current[file.key]?.diagnostics ?? [];
    setSuppressedInSourceKeys((current) => {
      const next = new Set(current);
      for (const diagnostic of diagnostics) {
        next.add(`${path}:${diagnosticInspectionId(diagnostic)}:${diagnostic.range.start.line}`);
      }
      return next;
    });
    setStatusMessage("Suppressed in source by the language server");
  }, [inspections.inspectionPathForFileKey, setStatusMessage]);

  const runCodeAction = useCallback(createRunCodeAction({
    semanticIndex,
    lspDescriptorForFile: lsp.descriptorForFile,
    setStatusMessage,
    intentionSessionRef,
    lspFilesRef: bufferState.lspFilesRef,
    lspSessionGeneration: lsp.sessionGeneration,
    projectAnalysisSnapshot: projectAnalysis.snapshot,
    updateLspStatusForFile: lsp.updateStatus,
    openFilesRef: bufferState.openFilesRef,
    canonicalCodeActionServiceRef,
    rootsRef: projectTree.rootsRef,
    captureCodeActionTransactionSnapshot: editSnapshots.captureCodeActionTransactionSnapshot,
    restoreCodeActionTransactionSnapshot: editSnapshots.restoreCodeActionTransactionSnapshot,
    applyLspWorkspaceEdit,
    get extractSessionRef() { return context.refactoring.extractSessionRef; },
    providerCommandSemanticGuardRef: editState.providerCommandSemanticGuardRef,
    providerCommandQueueRef: editState.providerCommandQueueRef,
    workspaceEditHistory: editState.workspaceEditHistory,
    setWorkspaceEditHistoryRevision: editState.setWorkspaceEditHistoryRevision,
    markProviderSuppressionApplied,
  }), [
    applyLspWorkspaceEdit,
    editSnapshots.captureCodeActionTransactionSnapshot,
    lspCodeActionResolve,
    lsp.descriptorForFile,
    markProviderSuppressionApplied,
    projectAnalysis.snapshot?.projectFingerprint,
    editSnapshots.restoreCodeActionTransactionSnapshot,
    semanticIndex.current,
    setStatusMessage,
    lsp.updateStatus,
    editState.workspaceEditHistory,
  ]);

  /** Interactive refactoring usages preview modal state. */
  const [refactoringPreviewModal, setRefactoringPreviewModal] = useState<{
    title: string;
    preview: WorkspaceEditPreview;
    originalEdit: LspWorkspaceEdit;
    plan?: RefactorPlanV3;
    sourceTexts?: Record<string, string | null>;
    resolve: (filtered: LspWorkspaceEdit | boolean) => void;
  } | null>(null);
  return {
    canonicalCodeActionServiceRef,
    setRefactoringPreviewModal,
    requestCodeActions,
    runCodeAction,
    intentionRequestAbortRef,
    intentionSessionRef,
    suppressedInSourceKeys,
    refactoringPreviewModal,
  };
}
