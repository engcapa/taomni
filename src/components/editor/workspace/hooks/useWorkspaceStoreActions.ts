import { useCodeWorkspaceStore } from "../../../../stores/codeWorkspaceStore";


export interface UseWorkspaceStoreActionsContext {

}

export function useWorkspaceStoreActions(context: UseWorkspaceStoreActionsContext) {
  const { } = context;
  const ensureWorkspaceUi = useCodeWorkspaceStore((s) => s.ensureInstance);
  const disposeWorkspaceUi = useCodeWorkspaceStore((s) => s.disposeInstance);
  const patchWorkspaceUi = useCodeWorkspaceStore((s) => s.patchInstance);
  const setStoreActiveKey = useCodeWorkspaceStore((s) => s.setActiveKey);
  const setStoreOpenOrder = useCodeWorkspaceStore((s) => s.setOpenOrder);
  const updateStoreOpenFiles = useCodeWorkspaceStore((s) => s.updateOpenFiles);
  const updateStoreLspFiles = useCodeWorkspaceStore((s) => s.updateLspFiles);
  const replaceStoreFileState = useCodeWorkspaceStore((s) => s.replaceFileState);
  const updateStoreExpandedRootIds = useCodeWorkspaceStore((s) => s.updateExpandedRootIds);
  const updateStoreExpandedDirKeys = useCodeWorkspaceStore((s) => s.updateExpandedDirKeys);
  const updateStoreEditorGroup = useCodeWorkspaceStore((s) => s.updateEditorGroup);
  const setStoreActiveEditorGroup = useCodeWorkspaceStore((s) => s.setActiveEditorGroup);
  const splitLayoutLeaf = useCodeWorkspaceStore((s) => s.splitLayoutLeaf);
  const closeLayoutLeaf = useCodeWorkspaceStore((s) => s.closeLayoutLeaf);
  const moveLayoutTabStore = useCodeWorkspaceStore((s) => s.moveLayoutTab);
  const equalizeLayoutRatiosStore = useCodeWorkspaceStore((s) => s.equalizeLayoutRatios);
  const stretchLayoutLeafStore = useCodeWorkspaceStore((s) => s.stretchLayoutLeaf);
  const unsplitAllLayoutStore = useCodeWorkspaceStore((s) => s.unsplitAllLayout);
  const setLayoutTreeV2Store = useCodeWorkspaceStore((s) => s.setLayoutTreeV2);
  const closeLayoutTabInLeaf = useCodeWorkspaceStore((s) => s.closeLayoutTabInLeaf);
  const setLeafActiveTab = useCodeWorkspaceStore((s) => s.setLeafActiveTab);
  const setLayoutNodeRatios = useCodeWorkspaceStore((s) => s.setLayoutNodeRatios);
  const seedTreeExpandIfEmpty = useCodeWorkspaceStore((s) => s.seedTreeExpandIfEmpty);
  const setShellChromeState = useCodeWorkspaceStore((s) => s.setShellChromeState);
  const setBottomDockHeightForTool = useCodeWorkspaceStore((s) => s.setBottomDockHeightForTool);
  const restoreDefaultToolWindowLayout = useCodeWorkspaceStore((s) => s.restoreDefaultToolWindowLayout);
  return {
    ensureWorkspaceUi,
    patchWorkspaceUi,
    seedTreeExpandIfEmpty,
    setStoreOpenOrder,
    setStoreActiveKey,
    updateStoreEditorGroup,
    setStoreActiveEditorGroup,
    updateStoreExpandedRootIds,
    updateStoreExpandedDirKeys,
    updateStoreOpenFiles,
    disposeWorkspaceUi,
    updateStoreLspFiles,
    replaceStoreFileState,
    splitLayoutLeaf,
    setLayoutTreeV2Store,
    closeLayoutTabInLeaf,
    closeLayoutLeaf,
    moveLayoutTabStore,
    equalizeLayoutRatiosStore,
    stretchLayoutLeafStore,
    unsplitAllLayoutStore,
    setBottomDockHeightForTool,
    restoreDefaultToolWindowLayout,
    setLeafActiveTab,
    setLayoutNodeRatios,
    setShellChromeState,
  };
}
