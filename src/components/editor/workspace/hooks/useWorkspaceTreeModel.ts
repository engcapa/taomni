import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { lspStartWorkspaceWatcher, lspStopWorkspaceWatcher } from "../../../../lib/editor/lsp";
import { isTauriRuntime } from "../../../../lib/runtime";
import type { CodeWorkspaceLooseFileInfo, CodeWorkspaceRootInfo } from "../../../../types";
import { errorMessage, initialLooseFiles, initialRoots, writeCodeWorkspaceTreeViewMode, type TreeViewMode } from "../codeWorkspaceModel";
import { TREE_DETAILS_STORAGE_KEY } from "../controller/model";
import { useWorkspaceTreeData } from "../useWorkspaceTreeData";
import { useWorkspaceStoreActions } from "./useWorkspaceStoreActions";


export interface UseWorkspaceTreeModelContext {
  workspaceUi: import("../../../../stores/codeWorkspaceStore").CodeWorkspaceInstanceUi;
  workspace: import("../../../../types").CodeWorkspaceTabInfo;
  setStatusMessage: (message: string) => void;
  workspaceInstanceId: string;
  storeActions: ReturnType<typeof useWorkspaceStoreActions>;
}

export function useWorkspaceTreeModel(context: UseWorkspaceTreeModelContext) {
  const { workspaceUi, workspace, setStatusMessage, workspaceInstanceId, storeActions } = context;

  const expandedRoots = useMemo(() => new Set(workspaceUi.expandedRootIds), [workspaceUi.expandedRootIds]);
  const expandedDirs = useMemo(() => new Set(workspaceUi.expandedDirKeys), [workspaceUi.expandedDirKeys]);
  const [roots, setRoots] = useState<CodeWorkspaceRootInfo[]>(() => initialRoots(workspace));
  const [looseFiles, setLooseFiles] = useState<CodeWorkspaceLooseFileInfo[]>(() => initialLooseFiles(workspace));
  const treeData = useWorkspaceTreeData({
    roots,
    expandedRootIds: expandedRoots,
    treeViewMode: workspaceUi.treeViewMode,
    treeFilter: workspaceUi.treeFilter,
    onError: setStatusMessage,
  });
  const rootsRef = useRef(roots);
  const looseFilesRef = useRef(looseFiles);

  // Platform workspaces add/remove roots while this editor stays mounted, so
  // the `useState` seed above is not enough: re-seed whenever the workspace
  // root list actually changes and expand the newly added roots. Without this
  // the Project tool window kept reporting "No project roots" after the user
  // added folders in the workspace sidebar (v6.1 review H4).
  const workspaceRootsSignature = useMemo(
    () => (workspace.roots ?? []).map((root) => `${root.id}:${root.path}`).join("|"),
    [workspace.roots],
  );
  const workspaceRef = useRef(workspace);
  const storeActionsRef = useRef(storeActions);
  useEffect(() => {
    workspaceRef.current = workspace;
    storeActionsRef.current = storeActions;
  }, [storeActions, workspace]);
  const initialRootsSignatureRef = useRef(workspaceRootsSignature);
  useEffect(() => {
    const next = initialRoots(workspaceRef.current);
    setRoots((current) => (
      current.length === next.length
        && current.every((root, index) => root.id === next[index].id && root.path === next[index].path)
        ? current
        : next
    ));
    // The editor's own layout hydration owns the initial expansion state; only
    // roots added later (the platform sidebar) are auto-expanded here.
    if (workspaceRootsSignature === initialRootsSignatureRef.current) return;
    if (next.length === 0) return;
    const nextRootIds = next.map((root) => root.id);
    storeActionsRef.current.updateStoreExpandedRootIds(workspaceInstanceId, (current) => {
      const missing = nextRootIds.filter((rootId) => !current.includes(rootId));
      return missing.length === 0 ? current : [...current, ...missing];
    });
  }, [workspaceInstanceId, workspaceRootsSignature]);

  useEffect(() => {
    rootsRef.current = roots;
  }, [roots]);

  useEffect(() => {
    if (!isTauriRuntime()) return undefined;
    const watchPaths = [
      ...roots.map((root) => root.path),
      ...looseFiles.map((file) => file.path),
    ];
    let disposed = false;
    void lspStartWorkspaceWatcher(workspaceInstanceId, watchPaths).catch((error) => {
      if (!disposed) {
        setStatusMessage(`File watcher unavailable: ${errorMessage(error)}`);
      }
    });
    return () => {
      disposed = true;
      void lspStopWorkspaceWatcher(workspaceInstanceId).catch(() => undefined);
    };
  }, [looseFiles, roots, setStatusMessage, workspaceInstanceId]);

  useEffect(() => {
    looseFilesRef.current = looseFiles;
  }, [looseFiles]);

  const setTreeViewMode = useCallback((mode: TreeViewMode) => {
    storeActions.patchWorkspaceUi(workspaceInstanceId, { treeViewMode: mode });
    writeCodeWorkspaceTreeViewMode(mode);
    setStatusMessage(`File tree view: ${mode}`);
  }, [storeActions.patchWorkspaceUi, setStatusMessage, workspaceInstanceId]);

  // IDEA Project view Appearance › Details (file time and size); a per-viewer
  // preference, so browser storage is enough and failures fall back to off.
  const [treeShowDetails, setTreeShowDetailsState] = useState(() => {
    try { return localStorage.getItem(TREE_DETAILS_STORAGE_KEY) === "true"; }
    catch { return false; }
  });
  const setTreeShowDetails = useCallback((value: boolean) => {
    setTreeShowDetailsState(value);
    try { localStorage.setItem(TREE_DETAILS_STORAGE_KEY, value ? "true" : "false"); }
    catch { /* storage unavailable: keep the in-memory choice */ }
  }, []);

  const findRoot = useCallback((rootId: string) => rootsRef.current.find((root) => root.id === rootId) ?? null, []);
  return {
    roots,
    rootsRef,
    looseFilesRef,
    findRoot,
    treeData,
    looseFiles,
    expandedRoots,
    expandedDirs,
    setRoots,
    setLooseFiles,
    setTreeViewMode,
    treeShowDetails,
    setTreeShowDetails,
  };
}
