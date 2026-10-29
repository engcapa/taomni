import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CodeWorkspaceLooseFileInfo, CodeWorkspaceRootInfo } from "../../../../types";
import { initialLooseFiles, initialRoots, rootDirKey, writeCodeWorkspaceTreeViewMode, type TreeViewMode } from "../codeWorkspaceModel";
import { TREE_DETAILS_STORAGE_KEY } from "../controller/model";
import { useWorkspaceTreeData } from "../useWorkspaceTreeData";
import { useWorkspaceStoreActions } from "./useWorkspaceStoreActions";
import { readExplorerSort, writeExplorerSort, type ExplorerSort } from "../explorerPreferences";
import { useWorkspaceFileWatcher } from "./useWorkspaceFileWatcher";


export interface UseWorkspaceTreeModelContext {
  workspaceUi: Omit<import("../../../../stores/codeWorkspaceStore").CodeWorkspaceInstanceUi, "treeSelection">;
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
  // A platform sidebar can edit the project definition while this editor stays
  // mounted. Only new input definitions replace local state; internal edits
  // still publish through the normal workspace context without resetting buffers.
  const inputRoots = JSON.stringify(initialRoots(workspace));
  const [previousInputRoots, setPreviousInputRoots] = useState(inputRoots);
  if (previousInputRoots !== inputRoots) {
    // Apply a new host definition before committing effects. An effect-based
    // update publishes the previous roots alongside the new repoRoot, which
    // can overwrite the host definition and start a registration feedback loop.
    setPreviousInputRoots(inputRoots);
    setRoots((current) => JSON.stringify(current) === inputRoots ? current : initialRoots(workspace));
  }
  const knownRootIds = useRef(new Set(roots.map((root) => root.id)));
  useEffect(() => {
    const added = roots.filter((root) => !knownRootIds.current.has(root.id));
    knownRootIds.current = new Set(roots.map((root) => root.id));
    if (!added.length) return;
    storeActions.updateStoreExpandedRootIds(workspaceInstanceId, (current) => [...new Set([...current, ...added.map((root) => root.id)])]);
    storeActions.updateStoreExpandedDirKeys(workspaceInstanceId, (current) => [...new Set([...current, ...added.map((root) => rootDirKey(root.id, ""))])]);
  }, [roots, storeActions.updateStoreExpandedRootIds, storeActions.updateStoreExpandedDirKeys, workspaceInstanceId]);
  const treeData = useWorkspaceTreeData({
    roots,
    expandedRootIds: expandedRoots,
    expandedDirKeys: expandedDirs,
    treeViewMode: workspaceUi.treeViewMode,
    treeFilter: workspaceUi.treeFilter,
    onError: setStatusMessage,
  });
  const rootsRef = useRef(roots);
  const looseFilesRef = useRef(looseFiles);

  useEffect(() => {
    rootsRef.current = roots;
  }, [roots]);

  useWorkspaceFileWatcher({ roots, looseFiles, workspaceUi, setStatusMessage, workspaceInstanceId });

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
  const [treeSort, setTreeSortState] = useState(readExplorerSort);
  const setTreeSort = useCallback((value: ExplorerSort) => {
    setTreeSortState(value);
    writeExplorerSort(value);
  }, []);
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
    treeSort,
    setTreeSort,
  };
}
