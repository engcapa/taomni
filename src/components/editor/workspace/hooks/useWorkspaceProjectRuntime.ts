import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useProjectDescriptorDiscovery } from "../../../../hooks/useProjectDescriptorDiscovery";
import { useProjectFacts } from "../../../../hooks/useProjectFacts";
import { fsPathComparisonKey, lspPresetIdForPath } from "../codeWorkspaceModel";
import { createWorkspaceLocationController, type WorkspaceLocationController } from "../navigationHistoryModel";
import { useWorkspaceGitSnapshots } from "../useWorkspaceGitSnapshots";
import { useWorkspaceHost } from "../workspaceHostIntegration";
import { useWorkspaceLspSession } from "../useWorkspaceLspSession";
import { useWorkspaceProjectAnalysis } from "../useWorkspaceProjectAnalysis";
import { useWorkspaceActionPorts } from "./useWorkspaceActionPorts";
import { useWorkspaceAppearance } from "./useWorkspaceAppearance";
import { useWorkspaceBufferStore } from "./useWorkspaceBufferStore";
import { useWorkspaceBuildTools } from "./useWorkspaceBuildTools";
import { useWorkspaceCodeStyle } from "./useWorkspaceCodeStyle";
import { useWorkspaceEditState } from "./useWorkspaceEditState";
import { useWorkspaceEditorTelemetry } from "./useWorkspaceEditorTelemetry";
import { useWorkspaceInspections } from "./useWorkspaceInspections";
import { useWorkspaceIntelligencePreferences } from "./useWorkspaceIntelligencePreferences";
import { useWorkspaceRecoveryState } from "./useWorkspaceRecoveryState";
import { useWorkspaceSemanticQueries } from "./useWorkspaceSemanticQueries";
import { useWorkspaceSession } from "./useWorkspaceSession";
import { useWorkspaceSurfaceState } from "./useWorkspaceSurfaceState";
import { useWorkspaceToolWindowRouting } from "./useWorkspaceToolWindowRouting";
import { useWorkspaceTreeModel } from "./useWorkspaceTreeModel";
import { useWorkspaceUiActions } from "./useWorkspaceUiActions";
import { useWorkspaceUsagesState } from "./useWorkspaceUsagesState";


export interface UseWorkspaceProjectRuntimeContext {
  session: ReturnType<typeof useWorkspaceSession>;
  surfaceState: ReturnType<typeof useWorkspaceSurfaceState>;
  workspace: import("../../../../types").CodeWorkspaceTabInfo;
  visible: boolean;
  ports: ReturnType<typeof useWorkspaceActionPorts>;
}

export function useWorkspaceProjectRuntime(context: UseWorkspaceProjectRuntimeContext) {
  const { session, surfaceState, workspace, visible, ports } = context;
  const sourcePresets = Object.values(session.workspaceUi.openFiles).map((file) => (
    lspPresetIdForPath(file.library?.originFilePath ?? file.languagePath)
  ));
  const hasSourceBuffers = sourcePresets.some(Boolean);
  const hasJavaBuffers = sourcePresets.includes("java");
  const workspaceVisible = useWorkspaceHost()?.active ?? visible;
  const editState = useWorkspaceEditState({
    publishWorkspaceObservation: session.publishWorkspaceObservation,
    workspaceInstanceId: session.workspaceInstanceId,
    setStatusMessage: session.setStatusMessage,
    searchEverywhereTriggerRef: session.searchEverywhereTriggerRef,
  });
  const invalidateSemanticAfterLspRestart = useCallback(() => {
    session.semanticIndex.invalidate("language-server-restarted");
  }, [session.semanticIndex.invalidate]);
  const toolWindowRouting = useWorkspaceToolWindowRouting({
    patchWorkspaceUi: session.storeActions.patchWorkspaceUi,
    workspaceInstanceId: session.workspaceInstanceId,
    languagePanelOpen: session.workspaceUi.languagePanelOpen,
    bottomDockOpen: session.workspaceUi.bottomDockOpen,
    bottomDockTab: session.workspaceUi.bottomDockTab,
    rightPaneOpenStored: session.workspaceUi.rightPaneOpen,
    rightPaneTab: session.workspaceUi.rightPaneTab,
  });
  const uiActions = useWorkspaceUiActions({
    workspaceInstanceId: session.workspaceInstanceId,
    searchEverywhereTriggerRef: session.searchEverywhereTriggerRef,
    patchWorkspaceUi: session.storeActions.patchWorkspaceUi,
    setStoreOpenOrder: session.storeActions.setStoreOpenOrder,
    setStoreActiveKey: session.storeActions.setStoreActiveKey,
    updateStoreEditorGroup: session.storeActions.updateStoreEditorGroup,
    setStoreActiveEditorGroup: session.storeActions.setStoreActiveEditorGroup,
    updateStoreExpandedRootIds: session.storeActions.updateStoreExpandedRootIds,
    updateStoreExpandedDirKeys: session.storeActions.updateStoreExpandedDirKeys,
  });
  const recoveryState = useWorkspaceRecoveryState({
    workspaceInstanceId: session.workspaceInstanceId,
    setTabPolicyReceipt: session.tabPolicyOwner.setTabPolicyReceipt,
    setStatusMessage: session.setStatusMessage,
    openFilesRef: session.bufferState.openFilesRef,
    openFiles: session.workspaceUi.openFiles,
  });
  const buffers = useWorkspaceBufferStore({
    pendingEditorTextTimerRef: session.bufferState.pendingEditorTextTimerRef,
    pendingEditorTextByFileRef: session.bufferState.pendingEditorTextByFileRef,
    flushPendingEditLocationsRef: session.bufferState.flushPendingEditLocationsRef,
    workspaceInstanceId: session.workspaceInstanceId,
    openFilesRef: session.bufferState.openFilesRef,
    updateStoreOpenFiles: session.storeActions.updateStoreOpenFiles,
    semanticIndex: session.semanticIndex,
    pendingWorkspaceRecoveryKeysRef: recoveryState.pendingWorkspaceRecoveryKeysRef,
    liveLspSyncTimersRef: session.bufferState.liveLspSyncTimersRef,
    disposeWorkspaceUi: session.storeActions.disposeWorkspaceUi,
    lspFilesRef: session.bufferState.lspFilesRef,
    updateStoreLspFiles: session.storeActions.updateStoreLspFiles,
    replaceStoreFileState: session.storeActions.replaceStoreFileState,
  });
  const appearance = useWorkspaceAppearance({
    workspaceInstanceId: session.workspaceInstanceId,
    clipboardHandle: session.clipboard.clipboardHandle,
    setStatusMessage: session.setStatusMessage,
    activeEditorGroupIdRef: surfaceState.activeEditorGroupIdRef,
    activeEditorGroupId: session.workspaceUi.activeEditorGroupId,
    activeKey: session.workspaceUi.activeKey,
    openFilesRef: session.bufferState.openFilesRef,
  });
  const projectTree = useWorkspaceTreeModel({
    workspaceUi: session.workspaceUi,
    workspace,
    setStatusMessage: session.setStatusMessage,
    workspaceInstanceId: session.workspaceInstanceId,
    storeActions: session.storeActions,
  });
  const projectFactsRoot = projectTree.roots[0]?.path ?? "";
  const projectDescriptorDiscovery = useProjectDescriptorDiscovery(projectFactsRoot, {
    autoRefresh: visible,
    autoScope: hasSourceBuffers ? "recursive" : "root",
  });
  const hasBuildTooling = projectDescriptorDiscovery.discovery?.descriptors.some((descriptor) => (
    descriptor.buildSystem === "maven" || descriptor.buildSystem === "gradle"
  )) ?? false;
  const projectFacts = useProjectFacts(projectFactsRoot, {
    autoFetch: visible && (hasJavaBuffers || hasBuildTooling),
  });
  const refreshProjectFacts = useCallback(() => {
    void Promise.allSettled([
      projectFacts.refresh(),
      projectDescriptorDiscovery.refresh(),
    ]);
  }, [projectDescriptorDiscovery.refresh, projectFacts.refresh]);
  const gitSnapshotOwner = useWorkspaceGitSnapshots({
    roots: projectTree.roots,
    onError: session.setStatusMessage,
    visible: workspaceVisible,
  });
  const telemetry = useWorkspaceEditorTelemetry({
    activeKey: session.workspaceUi.activeKey,
    activeEditorGroupId: session.workspaceUi.activeEditorGroupId,
  });
  const inspections = useWorkspaceInspections({
    workspaceInstanceId: session.workspaceInstanceId,
    openFilesRef: session.bufferState.openFilesRef,
    rootsRef: projectTree.rootsRef,
    setStatusMessage: session.setStatusMessage,
  });
  const intelligence = useWorkspaceIntelligencePreferences({
    workspaceInstanceId: session.workspaceInstanceId,
    parameterInfoSession: session.referenceSessions.parameterInfoSession,
  });
  const usages = useWorkspaceUsagesState();
  const initialOpenedKeyRef = useRef<string | null>(null);
  const restoreRunRef = useRef<{
    workspaceInstanceId: string;
    cancelled: boolean;
    cancelPending: boolean;
  } | null>(null);

  useEffect(() => {
    const run = restoreRunRef.current;
    // React StrictMode immediately re-runs effects after cleanup. Re-arm the
    // current restore before the deferred cancellation callback can fire so
    // the in-flight native read is shared by both effect passes.
    if (run?.workspaceInstanceId === session.workspaceInstanceId) run.cancelPending = false;
    return () => {
      const cleanupRun = restoreRunRef.current;
      if (cleanupRun?.workspaceInstanceId !== session.workspaceInstanceId) return;
      cleanupRun.cancelPending = true;
      queueMicrotask(() => {
        if (restoreRunRef.current !== cleanupRun || !cleanupRun.cancelPending) return;
        cleanupRun.cancelled = true;
        restoreRunRef.current = null;
      });
    };
  }, [session.workspaceInstanceId]);

  const workspaceLocationControllerRef = useRef<WorkspaceLocationController>(
    createWorkspaceLocationController(session.workspaceInstanceId),
  );

  useEffect(() => {
    workspaceLocationControllerRef.current = createWorkspaceLocationController(session.workspaceInstanceId);
    return () => {
      workspaceLocationControllerRef.current.dispose();
    };
  }, [session.workspaceInstanceId]);
  const codeStyle = useWorkspaceCodeStyle({
    workspaceInstanceId: session.workspaceInstanceId,
    rootsRef: projectTree.rootsRef,
    roots: projectTree.roots,
  });
  const buildTools = useWorkspaceBuildTools({
    workspaceInstanceId: session.workspaceInstanceId,
    terminalDockRef: ports.terminalDockRef,
    toolWindowRouting,
  });
  const lsp = useWorkspaceLspSession({
    workspaceInstanceId: session.workspaceInstanceId,
    roots: projectTree.roots,
    openFilesRef: session.bufferState.openFilesRef,
    updateLspFiles: buffers.setLspFiles,
    onError: session.setStatusMessage,
    onRestart: invalidateSemanticAfterLspRestart,
    visible,
    autoDiscover: hasSourceBuffers,
  });
  // §8.20.3 W2: provider-owned Project Analysis snapshot (phase/progress/
  // modules/classpath fingerprint). The generation resync rides the statuses
  // identity — a restart refreshes them, which re-probes on the new session.
  const [projectAnalysisGeneration, setProjectAnalysisGeneration] = useState(0);
  useEffect(() => {
    setProjectAnalysisGeneration(lsp.sessionGeneration());
  }, [lsp.serverStatuses, lsp.sessionGeneration]);
  const projectAnalysisRoots = useMemo(
    () => projectTree.roots.map((root) => root.path),
    [projectTree.roots],
  );
  const projectAnalysisDescriptorForRoot = useCallback(
    (root: string) => lsp.descriptorForPath(root, root),
    [lsp.descriptorForPath],
  );
  const javaServerStatus = useMemo(
    () => lsp.serverStatuses.find((server) => server.presetId === "java") ?? null,
    [lsp.serverStatuses],
  );
  const projectAnalysis = useWorkspaceProjectAnalysis({
    workspaceInstanceId: session.workspaceInstanceId,
    roots: projectAnalysisRoots,
    provider: {
      configured: !!(javaServerStatus?.available || javaServerStatus?.active),
      active: !!javaServerStatus?.active,
      opening: false,
      lastError: javaServerStatus?.error ?? null,
    },
    progresses: session.lspClientEvents.progresses,
    sessionGeneration: projectAnalysisGeneration,
    descriptorForRoot: projectAnalysisDescriptorForRoot,
    autoResolveSdk: visible && hasJavaBuffers,
  });

  const semanticRootsFingerprint = useMemo(
    () => projectTree.roots.map((root) => `${root.id}:${fsPathComparisonKey(root.path)}`).sort().join("\u0000"),
    [projectTree.roots],
  );
  const previousSemanticRootsFingerprintRef = useRef(semanticRootsFingerprint);
  useEffect(() => {
    if (previousSemanticRootsFingerprintRef.current === semanticRootsFingerprint) return;
    previousSemanticRootsFingerprintRef.current = semanticRootsFingerprint;
    session.semanticIndex.invalidate("roots-changed", projectTree.roots.map((root) => root.path));
  }, [projectTree.roots, session.semanticIndex.invalidate, semanticRootsFingerprint]);
  const semanticQueries = useWorkspaceSemanticQueries({
    publishWorkspaceObservation: session.publishWorkspaceObservation,
    workspaceInstanceId: session.workspaceInstanceId,
    openFilesRef: session.bufferState.openFilesRef,
    lspSessionGeneration: lsp.sessionGeneration,
    rootsRef: projectTree.rootsRef,
    projectFactsRoot,
    lspDescriptorForFile: lsp.descriptorForFile,
  });
  return {
    hasSourceBuffers,
    semanticQueries,
    appearance,
    buffers,
    uiActions,
    lsp,
    projectTree,
    recoveryState,
    workspaceLocationControllerRef,
    toolWindowRouting,
    initialOpenedKeyRef,
    restoreRunRef,
    editState,
    gitSnapshotOwner,
    telemetry,
    codeStyle,
    projectAnalysis,
    intelligence,
    inspections,
    projectFactsRoot,
    usages,
    projectDescriptorDiscovery,
    projectFacts,
    buildTools,
    refreshProjectFacts,
  };
}
