import { useCallback } from "react";
import { useCodeWorkspaceStore,type CodeWorkspaceEditorGroupState,type EditorGroupId,type EditorSplitOrientation } from "../../../../stores/codeWorkspaceStore";
import { getAllLeafNodes,navigateLeafOrder } from "../recursiveLayoutTree";


export interface UseWorkspaceSplitsContext {
  updateEditorGroup: (groupId: EditorGroupId,updater: CodeWorkspaceEditorGroupState|((prev: CodeWorkspaceEditorGroupState) => CodeWorkspaceEditorGroupState)) => void;
  closeFile: (key: string,groupId?: EditorGroupId,options?: { discard?: boolean; }) => Promise<void>;
  activeKey: string|null;
  activeEditorGroupId: string;
  openFilesRef: import("react").RefObject<Record<string,import("../editorGroupTypes").OpenFileViewModel>>;
  splitLayoutLeaf: (instanceId: string,leafId: string,orientation: "horizontal"|"vertical",newFileKey?: string) => void;
  workspaceInstanceId: string;
  closeLayoutLeaf: (instanceId: string,leafId: string) => void;
  workspaceUi: Omit<import("../../../../stores/codeWorkspaceStore").CodeWorkspaceInstanceUi, "treeSelection">;
  setStoreActiveEditorGroup: (instanceId: string,groupId: EditorGroupId) => void;
  setStatusMessage: (message: string) => void;
  moveLayoutTabStore: (instanceId: string,sourceLeafId: string,targetLeafId: string,fileKey: string) => void;
  equalizeLayoutRatiosStore: (instanceId: string,leafId: string) => void;
  stretchLayoutLeafStore: (instanceId: string,leafId: string,options?: { step?: number; max?: number; }) => void;
  unsplitAllLayoutStore: (instanceId: string) => void;
}

export function useWorkspaceSplits(context: UseWorkspaceSplitsContext) {
  const {
    updateEditorGroup,
    closeFile,
    activeKey,
    activeEditorGroupId,
    openFilesRef,
    splitLayoutLeaf,
    workspaceInstanceId,
    closeLayoutLeaf,
    workspaceUi,
    setStoreActiveEditorGroup,
    setStatusMessage,
    moveLayoutTabStore,
    equalizeLayoutRatiosStore,
    stretchLayoutLeafStore,
    unsplitAllLayoutStore,
  }=context;

  const promotePreviewTab=useCallback((groupId: EditorGroupId,key: string) => {
    updateEditorGroup(groupId,(group) => ({
      ...group,
      previewKey: group.previewKey===key? null:group.previewKey,
    }));
  },[updateEditorGroup]);

  const setTabPinned=useCallback((groupId: EditorGroupId,key: string,pinned: boolean) => {
    updateEditorGroup(groupId,(group) => ({
      ...group,
      previewKey: pinned&&group.previewKey===key? null:group.previewKey,
      pinnedKeys: pinned
        ? [...group.pinnedKeys.filter((entry) => entry!==key),key]
        :group.pinnedKeys.filter((entry) => entry!==key),
    }));
  },[updateEditorGroup]);

  const closeGroupFiles=useCallback(async (groupId: EditorGroupId,keys: string[]) => {
    for(const key of keys) await closeFile(key,groupId);
  },[closeFile]);

  const splitEditor=useCallback((
    orientation: EditorSplitOrientation,
    key=activeKey,
    sourceGroupId=activeEditorGroupId,
  ) => {
    if(!key||!openFilesRef.current[key]) return;
    splitLayoutLeaf(workspaceInstanceId,sourceGroupId,orientation,key);
  },[activeEditorGroupId,activeKey,splitLayoutLeaf,workspaceInstanceId]);

  const closeSplit=useCallback(() => {
    closeLayoutLeaf(workspaceInstanceId,activeEditorGroupId);
  },[activeEditorGroupId,closeLayoutLeaf,workspaceInstanceId]);

  // §8.19.6 R5-b: split management actions — navigation, tab moves between
  // splits, equalize/stretch proportions and unsplit-all. All layout truth
  // flows through the recursive-tree store reducers.
  const goToAdjacentSplit=useCallback((direction: 1|-1): boolean => {
    const target=navigateLeafOrder(workspaceUi.layoutTreeV2,activeEditorGroupId,direction);
    if(!target||target.id===activeEditorGroupId) return false;
    setStoreActiveEditorGroup(workspaceInstanceId,target.id);
    setStatusMessage(`${direction===1? "Next":"Previous"} editor: ${target.id}`);
    return true;
  },[activeEditorGroupId,setStoreActiveEditorGroup,setStatusMessage,workspaceInstanceId,workspaceUi.layoutTreeV2]);

  const moveActiveTabToAdjacentSplit=useCallback((direction: 1|-1): boolean => {
    // Read through the store so a stale closure never moves the wrong tab.
    const liveUi=useCodeWorkspaceStore.getState().byInstanceId[workspaceInstanceId];
    const sourceId=liveUi?.activeEditorGroupId??activeEditorGroupId;
    const key=sourceId? (liveUi?.editorGroups[sourceId]?.activeKey??null):null;
    if(!key) return false;
    const target=navigateLeafOrder(workspaceUi.layoutTreeV2,sourceId,direction);
    if(!target||target.id===sourceId) return false;
    moveLayoutTabStore(workspaceInstanceId,sourceId,target.id,key);
    setStatusMessage(`Moved ${openFilesRef.current[key]?.title??key} to the ${direction===1? "next":"previous"} split`);
    return true;
  },[activeEditorGroupId,moveLayoutTabStore,openFilesRef,setStatusMessage,workspaceInstanceId,workspaceUi.layoutTreeV2]);

  const moveTabToAdjacentSplitFrom=useCallback((
    sourceLeafId: EditorGroupId,
    key: string,
    direction: 1|-1,
  ): boolean => {
    const target=navigateLeafOrder(workspaceUi.layoutTreeV2,sourceLeafId,direction);
    if(!target||target.id===sourceLeafId) return false;
    moveLayoutTabStore(workspaceInstanceId,sourceLeafId,target.id,key);
    return true;
  },[moveLayoutTabStore,workspaceInstanceId,workspaceUi.layoutTreeV2]);

  const equalizeActiveSplitRatios=useCallback((): boolean => {
    equalizeLayoutRatiosStore(workspaceInstanceId,activeEditorGroupId);
    setStatusMessage("Split proportions equalized");
    return true;
  },[activeEditorGroupId,equalizeLayoutRatiosStore,setStatusMessage,workspaceInstanceId]);

  const stretchActiveSplit=useCallback((): boolean => {
    stretchLayoutLeafStore(workspaceInstanceId,activeEditorGroupId);
    return true;
  },[activeEditorGroupId,stretchLayoutLeafStore,workspaceInstanceId]);

  const unsplitAllWindows=useCallback((): boolean => {
    if(getAllLeafNodes(useCodeWorkspaceStore.getState().byInstanceId[workspaceInstanceId]?.layoutTreeV2
      ??workspaceUi.layoutTreeV2).length<=1) {
      setStatusMessage("No splits to close");
      return false;
    }
    unsplitAllLayoutStore(workspaceInstanceId);
    setStatusMessage("Closed all splits — tabs kept in one editor");
    return true;
  },[setStatusMessage,unsplitAllLayoutStore,workspaceInstanceId,workspaceUi.layoutTreeV2]);
  return { splitEditor,goToAdjacentSplit,moveActiveTabToAdjacentSplit,equalizeActiveSplitRatios,stretchActiveSplit,unsplitAllWindows,setTabPinned,promotePreviewTab,closeGroupFiles,moveTabToAdjacentSplitFrom,closeSplit };
}
