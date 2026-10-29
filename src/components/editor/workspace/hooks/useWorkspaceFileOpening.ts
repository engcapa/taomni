import { useCallback, useRef } from "react";
import { type LspWorkspaceEditOperation } from "../../../../lib/editor/lsp";
import { type EditorGroupId } from "../../../../stores/codeWorkspaceStore";
import { absoluteWorkspacePath, basename, parentPath } from "../codeWorkspaceModel";
import { createOpenFile } from "../controller/fileActions";
import { extractContextSnippet, type PendingClosedFile } from "../controller/model";
import { isPathContainedInRoot } from "../navigationHistoryModel";
import { useWorkspaceFileActions } from "../useWorkspaceFileActions";
import { useWorkspaceNavigation } from "../useWorkspaceNavigation";
import { type PersistedEditorViewState } from "../workspaceLayoutPersistence";
import { useWorkspaceActionPorts } from "./useWorkspaceActionPorts";
import { useWorkspaceKeyboard } from "./useWorkspaceKeyboard";
import { useWorkspaceLayoutPersistence } from "./useWorkspaceLayoutPersistence";
import { useWorkspaceProjectRuntime } from "./useWorkspaceProjectRuntime";
import { useWorkspaceRecoveryActions } from "./useWorkspaceRecoveryActions";
import { useWorkspaceSession } from "./useWorkspaceSession";
import { useWorkspaceSurfaceState } from "./useWorkspaceSurfaceState";
import { useWorkspaceTreeInteractions } from "./useWorkspaceTreeInteractions";
import { useWorkspaceTreeOpening } from "./useWorkspaceTreeOpening";
import { useWorkspaceZoom } from "./useWorkspaceZoom";
import { useWorkspaceHost } from "../workspaceHostIntegration";


export interface UseWorkspaceFileOpeningContext {
  project: ReturnType<typeof useWorkspaceProjectRuntime>;
  session: ReturnType<typeof useWorkspaceSession>;
  visible: boolean;
  surfaceState: ReturnType<typeof useWorkspaceSurfaceState>;
  keyboard: ReturnType<typeof useWorkspaceKeyboard>;
  ports: ReturnType<typeof useWorkspaceActionPorts>;
  workspace: import("../../../../types").CodeWorkspaceTabInfo;
}

export function useWorkspaceFileOpening(context: UseWorkspaceFileOpeningContext) {
  const { project, session, visible, surfaceState, ports, workspace } = context;
  const host = useWorkspaceHost();

  const persistWorkspaceLayoutNowRef = useRef<((targetInstanceId?: string) => void) | null>(null);

  // ED-IMPROVE-007: view snapshots stay in memory and persist with the next
  // debounced layout write. A late report from a replaced view/workspace is
  // dropped instead of resurrecting an old leaf's caret.
  // ED-REPAIR-009: ensure unmount tail captures update viewStatesRef even
  // when the component is in unmount phase, flushing to disk immediately.
  const handleViewStateChange = useCallback((
    groupId: EditorGroupId,
    fileKey: string,
    state: PersistedEditorViewState,
  ) => {
    if (project.semanticQueries.workspaceInstanceIdRef.current !== session.workspaceInstanceId) return;
    const current = session.layoutHydration.viewStatesRef.current;
    const leaf = current[groupId];
    if (leaf?.[fileKey] === state) return;
    session.layoutHydration.viewStatesRef.current = {
      ...current,
      [groupId]: { ...(leaf ?? {}), [fileKey]: state },
    };
    if (session.mountedRef.current) {
      session.layoutHydration.setViewStateRevision((revision) => revision + 1);
    } else {
      persistWorkspaceLayoutNowRef.current?.(session.workspaceInstanceId);
    }
  }, [session.workspaceInstanceId, session.mountedRef]);
  useWorkspaceZoom({
    treeFocus: session.treeFocus,
    visible,
    preferences: session.preferences,
    appearance: project.appearance,
    rootRef: surfaceState.rootRef,
  });

  // §8.18.5: openFile enforces the tab limit through the closer defined
  // later in the component; the ref bridges the declaration order.
  const closeFileRef = useRef<
    ((key: string, groupId?: EditorGroupId, options?: { discard?: boolean; }) => Promise<void>) | null
  >(null);
  const pendingClosedFilesRef = useRef(new Map<string, PendingClosedFile>());

  const openFileInternal = useCallback(
    createOpenFile({
      flushPendingEditorText: project.buffers.flushPendingEditorText,
      pendingClosedFilesRef,
      workspaceInstanceId: session.workspaceInstanceId,
      updateEditorGroup: project.uiActions.updateEditorGroup,
      tabPolicyRef: session.tabPolicyOwner.tabPolicyRef,
      activateEditorGroup: project.uiActions.activateEditorGroup,
      openFilesRef: session.bufferState.openFilesRef,
      get mruFileKeysRef() { return context.keyboard.mruFileKeysRef; },
      closeFileRef,
      setStatusMessage: session.setStatusMessage,
      syncLspDocument: project.lsp.syncDocument,
      libraryBuffersRef: session.bufferState.libraryBuffersRef,
      setOpenFiles: project.buffers.setOpenFiles,
      lspDescriptorForPath: project.lsp.descriptorForPath,
      rootsRef: project.projectTree.rootsRef,
      looseFilesRef: project.projectTree.looseFilesRef,
      findRoot: project.projectTree.findRoot,
      restoreBookmarksForFileKey: session.preferences.restoreBookmarksForFileKey,
    }),
    [
      project.uiActions.activateEditorGroup,
      project.projectTree.findRoot,
      project.buffers.flushPendingEditorText,
      project.lsp.descriptorForPath,
      session.preferences.restoreBookmarksForFileKey,
      session.setStatusMessage,
      project.lsp.syncDocument,
      project.uiActions.updateEditorGroup,
      session.workspaceInstanceId,
    ],
  );
  const openFile = useCallback<typeof openFileInternal>(async (ref, options) => {
    const result = await openFileInternal(ref, options);
    if (result && result.activated !== false && options?.activate !== false && !options?.restoring) host?.onActivateFile(ref);
    return result;
  }, [openFileInternal, host?.onActivateFile]);
  const treeOpening = useWorkspaceTreeOpening({
    treeFocus: session.treeFocus,
    workspaceInstanceId: session.workspaceInstanceId,
    editorCommands: session.editorCommands,
    buffers: project.buffers,
    splitLayoutLeaf: session.storeActions.splitLayoutLeaf,
    openFile,
  });
  const recoveryActions = useWorkspaceRecoveryActions({
    recoveryState: project.recoveryState,
    workspaceInstanceId: session.workspaceInstanceId,
    setStatusMessage: session.setStatusMessage,
    openFile,
    openFilesRef: session.bufferState.openFilesRef,
    setOpenFiles: project.buffers.setOpenFiles,
    lspFilesRef: session.bufferState.lspFilesRef,
    syncLspDocument: project.lsp.syncDocument,
    roots: project.projectTree.roots,
  });

  const revealNavLocation = useCallback((key: string, position: { line: number; character: number; }) => {
    surfaceState.revealNonceRef.current += 1;
    surfaceState.setRevealTarget({
      key,
      line: position.line,
      character: position.character,
      nonce: surfaceState.revealNonceRef.current,
    });
  }, []);

  const navigation = useWorkspaceNavigation({
    workspaceInstanceId: session.workspaceInstanceId,
    activeKey: session.workspaceUi.activeKey,
    roots: project.projectTree.roots,
    flatFiles: project.projectTree.treeData.flatFiles,
    visible,
    rootsRef: project.projectTree.rootsRef,
    looseFilesRef: project.projectTree.looseFilesRef,
    openFilesRef: session.bufferState.openFilesRef,
    loadFlatFiles: project.projectTree.treeData.loadFlatFiles,
    openFile,
    revealLocation: revealNavLocation,
    setSearchEverywhereMode: project.uiActions.setSearchEverywhereMode,
    setSearchEverywhereOpen: project.uiActions.setSearchEverywhereOpen,
    setRecentEntries: project.uiActions.setRecentEntries,
    setRecentFilesOpen: project.uiActions.setRecentFilesOpen,
  });

  // Recent Locations is metadata, not part of the live editing contract. Build
  // its line/context snapshot once per settled input burst so a caret near the
  // end of a large source file does not rescan the entire prefix on every key.
  session.bufferState.flushPendingEditLocationsRef.current = () => {
    for (const [key, file] of session.bufferState.pendingEditorTextByFileRef.current) {
      const caret = session.bufferState.pendingEditorCaretByFileRef.current.get(key);
      if (!caret) continue;
      const activeFilePath = file.path ?? file.title;
      const { position, offset } = caret;
      const { lineText, contextSnippet } = extractContextSnippet(file.text, position.line, offset);
      const isInsideAnyRoot = project.projectTree.rootsRef.current.some((root) => (
        isPathContainedInRoot(activeFilePath, root.path)
      ));
      project.workspaceLocationControllerRef.current.recordUserEdit({
        fileKey: file.key,
        filePath: activeFilePath,
        title: file.title,
        line: position.line,
        character: position.character,
        lineText,
        contextSnippet,
        sourceOwnership: file.library ? "library" : isInsideAnyRoot ? "workspace" : "external",
      });
      navigation.recordEditLocation(file.ref, position);
    }
    session.bufferState.pendingEditorCaretByFileRef.current.clear();
  };

  const openFindInFiles = useCallback((focusTarget: "query" | "replace" = "query") => {
    project.toolWindowRouting.setBottomDockOpen(true);
    project.toolWindowRouting.setBottomDockTab("search");
    session.setSearchFocusTarget(focusTarget);
    project.uiActions.setSearchFocusNonce((nonce) => nonce + 1);
  }, []);

  const findInDirectory = useCallback((path: string) => {
    project.toolWindowRouting.setBottomDockOpen(true);
    project.toolWindowRouting.setBottomDockTab("search");
    project.uiActions.setSearchIncludePreset((current) => ({
      value: path ? `${path}/**` : "",
      nonce: current.nonce + 1,
    }));
  }, []);

  const openTerminalAt = useCallback((rootId: string, path: string, pathIsFile = false) => {
    const root = project.projectTree.findRoot(rootId);
    if (!root) return;
    const relativeDirectory = pathIsFile ? parentPath(path) : path;
    const cwd = absoluteWorkspacePath(root, relativeDirectory);
    project.toolWindowRouting.setBottomDockTab("terminal");
    project.toolWindowRouting.setBottomDockOpen(true);
    ports.terminalDockRef.current?.openAt(cwd, relativeDirectory ? basename(relativeDirectory) : root.name);
  }, [project.projectTree.findRoot]);
  const { navigationHistoryFacade, restoreReady } = useWorkspaceLayoutPersistence({
    rootsRef: project.projectTree.rootsRef,
    workspaceLocationControllerRef: project.workspaceLocationControllerRef,
    removeNavigationLocations: navigation.removeNavigationLocations,
    reconcileNavigationFileReferences: navigation.reconcileFileReferences,
    layoutRestoredOpenFilesRef: session.layoutHydration.layoutRestoredOpenFilesRef,
    workspaceInstanceId: session.workspaceInstanceId,
    initialOpenedKeyRef: project.initialOpenedKeyRef,
    restoreRunRef: project.restoreRunRef,
    looseFiles: project.projectTree.looseFiles,
    activateEditorGroup: project.uiActions.activateEditorGroup,
    openFile,
    workspace,
    roots: project.projectTree.roots,
    editorGroups: session.workspaceUi.editorGroups,
    libraryBuffersRef: session.bufferState.libraryBuffersRef,
    bottomDockOpen: session.workspaceUi.bottomDockOpen,
    bottomDockTab: session.workspaceUi.bottomDockTab,
    rightPaneOpen: project.toolWindowRouting.rightPaneOpen,
    rightPaneTab: session.workspaceUi.rightPaneTab,
    languagePanelOpen: session.workspaceUi.languagePanelOpen,
    splitOrientation: session.workspaceUi.splitOrientation,
    activeEditorGroupId: session.workspaceUi.activeEditorGroupId,
    expandedRootIds: session.workspaceUi.expandedRootIds,
    expandedDirKeys: session.workspaceUi.expandedDirKeys,
    workspaceUi: session.workspaceUi,
    tabPolicyRef: session.tabPolicyOwner.tabPolicyRef,
    viewStatesRef: session.layoutHydration.viewStatesRef,
    openFilesRef: session.bufferState.openFilesRef,
    setStatusMessage: session.setStatusMessage,
    persistWorkspaceLayoutNowRef,
    tabPolicyRevision: session.tabPolicyOwner.tabPolicyRevision,
    viewStateRevision: session.layoutHydration.viewStateRevision,
    workspaceInstanceIdRef: project.semanticQueries.workspaceInstanceIdRef,
  });

  const applyFileActionResourceOperation = useCallback((
    operation: Exclude<LspWorkspaceEditOperation, { kind: "text"; }>,
  ) => {
    const apply = project.editState.fileActionResourceOperationRef.current;
    if (!apply) {
      return Promise.reject(new Error("Workspace resource operations are not ready"));
    }
    return apply(operation);
  }, []);

  const onRootAdded = useCallback((root: import("../../../../types").CodeWorkspaceRootInfo) => {
    project.toolWindowRouting.toolWindowLayoutRef.current.show("project");
    host?.onFolderOpened?.(root.id);
  }, [host?.onFolderOpened, project.toolWindowRouting.toolWindowLayoutRef]);

  const fileActions = useWorkspaceFileActions({
    onRootAdded,
    workspaceId: session.workspaceInstanceId,
    locationController: project.workspaceLocationControllerRef.current,
    roots: project.projectTree.roots,
    gitRoots: project.gitSnapshotOwner.gitRoots,
    selected: session.workspaceUi.treeSelection,
    activeKey: session.workspaceUi.activeKey,
    openFiles: session.workspaceUi.openFiles,
    directories: project.projectTree.treeData.directories,
    expandedRoots: project.projectTree.expandedRoots,
    expandedDirs: project.projectTree.expandedDirs,
    treeViewMode: session.workspaceUi.treeViewMode,
    rootsRef: project.projectTree.rootsRef,
    looseFilesRef: project.projectTree.looseFilesRef,
    openFilesRef: session.bufferState.openFilesRef,
    openOrderRef: session.bufferState.openOrderRef,
    setRoots: project.projectTree.setRoots,
    setLooseFiles: project.projectTree.setLooseFiles,
    setSelected: project.uiActions.setSelected,
    setExpandedRoots: project.uiActions.setExpandedRoots,
    setExpandedDirs: project.uiActions.setExpandedDirs,
    setOpenFiles: project.buffers.setOpenFiles,
    setOpenOrder: project.uiActions.setOpenOrder,
    setActiveKey: project.uiActions.setActiveKey,
    loadDir: project.projectTree.treeData.loadDir,
    loadFlatFiles: project.projectTree.treeData.loadFlatFiles,
    resetTreeData: project.projectTree.treeData.reset,
    removeTreeDataRoot: project.projectTree.treeData.removeRoot,
    openFile,
    applyResourceOperation: applyFileActionResourceOperation,
    notifyWorkspacePathGitChanged: project.gitSnapshotOwner.notifyWorkspacePathGitChanged,
    onStatus: session.setStatusMessage,
  });
  const treeInteractions = useWorkspaceTreeInteractions({
    treeFocus: session.treeFocus,
    openFilesRef: session.bufferState.openFilesRef,
    fileActions,
    setStatusMessage: session.setStatusMessage,
    toolWindowRouting: project.toolWindowRouting,
    uiActions: project.uiActions,
    treeData: project.projectTree.treeData,
    roots: project.projectTree.roots,
    rootsRef: project.projectTree.rootsRef,
    openFile,
    openTerminalAt,
    terminalDockRef: ports.terminalDockRef,
    selected: session.workspaceUi.treeSelection,
    treeOpening,
    editorCommands: session.editorCommands,
    workspaceCommandRunnerRef: ports.workspaceCommandRunnerRef,
    workspaceInstanceId: session.workspaceInstanceId,
  });
  return {
    openFile,
    fileActions,
    pendingClosedFilesRef,
    closeFileRef,
    navigation,
    treeInteractions,
    openFindInFiles,
    treeOpening,
    findInDirectory,
    revealNavLocation,
    handleViewStateChange,
    recoveryActions,
    navigationHistoryFacade,
    restoreReady,
  };
}
