import { type BottomDockTabId, type CodeWorkspaceEditorGroupState, type EditorGroupId, type EditorSplitOrientation, type RightPaneTabId } from "../../../../stores/codeWorkspaceStore";
import { type WorkspaceTabPolicyV3 } from "../workspaceTabPolicy";
import { enrichViewStatesWithIdentity, snapshotFromWorkspaceUi, writeWorkspaceLayoutSnapshot, type WorkspaceViewStates } from "../workspaceLayoutPersistence";
import { type LibraryBufferInfo } from "../codeWorkspaceModel";



export interface PersistWorkspaceLayoutNowContext {
  workspaceInstanceId: string;
  layoutRestoredOpenFilesRef: import("react").RefObject<boolean>;
  editorGroups: Record<string, CodeWorkspaceEditorGroupState>;
  libraryBuffersRef: import("react").RefObject<Record<string, LibraryBufferInfo>>;
  bottomDockOpen: boolean;
  bottomDockTab: BottomDockTabId;
  rightPaneOpen: boolean;
  rightPaneTab: RightPaneTabId;
  languagePanelOpen: boolean;
  splitOrientation: EditorSplitOrientation | null;
  activeEditorGroupId: string;
  expandedRootIds: string[];
  expandedDirKeys: string[];
  workspaceUi: import("../../../../stores/codeWorkspaceStore").CodeWorkspaceInstanceUi;
  tabPolicyRef: import("react").RefObject<WorkspaceTabPolicyV3>;
  viewStatesRef: import("react").RefObject<WorkspaceViewStates>;
  openFilesRef: import("react").RefObject<Record<string, import("../editorGroupTypes").OpenFileViewModel>>;
  setStatusMessage: (message: string) => void;
}


export function createPersistWorkspaceLayoutNow(controllerContext: PersistWorkspaceLayoutNowContext): (targetInstanceId?: string) => void {
  return (targetInstanceId = controllerContext.workspaceInstanceId) => {
    if (!targetInstanceId) return;
    if (controllerContext.layoutRestoredOpenFilesRef.current) return;
    // Library buffers come from a live language server, so they cannot be
    // restored on the next launch — keep them out of the persisted layout.
    const persistableGroups = Object.fromEntries(
      (Object.entries(controllerContext.editorGroups) as Array<[EditorGroupId, typeof controllerContext.editorGroups.primary]>)
        .map(([groupId, group]) => [groupId, {
          ...group,
          openOrder: group.openOrder.filter((key) => !controllerContext.libraryBuffersRef.current[key]),
          pinnedKeys: group.pinnedKeys.filter((key) => !controllerContext.libraryBuffersRef.current[key]),
          activeKey: group.activeKey && controllerContext.libraryBuffersRef.current[group.activeKey]
            ? null
            : group.activeKey,
          previewKey: group.previewKey && controllerContext.libraryBuffersRef.current[group.previewKey]
            ? null
            : group.previewKey,
        }]),
    ) as typeof controllerContext.editorGroups;
    writeWorkspaceLayoutSnapshot(targetInstanceId, snapshotFromWorkspaceUi({
      bottomDockOpen: controllerContext.bottomDockOpen,
      bottomDockTab: controllerContext.bottomDockTab,
      rightPaneOpen: controllerContext.rightPaneOpen,
      rightPaneTab: controllerContext.rightPaneTab,
      languagePanelOpen: controllerContext.languagePanelOpen,
      splitOrientation: controllerContext.splitOrientation,
      activeEditorGroupId: controllerContext.activeEditorGroupId,
      expandedRootIds: controllerContext.expandedRootIds,
      expandedDirKeys: controllerContext.expandedDirKeys,
      editorGroups: persistableGroups,
      layoutTreeV2: controllerContext.workspaceUi.layoutTreeV2,
      tabPolicy: controllerContext.tabPolicyRef.current,
      shellChromeState: controllerContext.workspaceUi.shellChromeState,
      // ED-REPAIR-009: Preserve captured snapshot identities without re-stamping from live text.
      viewStates: enrichViewStatesWithIdentity(
        controllerContext.viewStatesRef.current,
        (fileKey) => controllerContext.openFilesRef.current[fileKey]?.text,
      ),
    }), {
      // §8.17.4 step 3: persistence refusals surface as a recovery
      // diagnostic, not only a console line.
      onIssue: (message) => controllerContext.setStatusMessage(message),
    });
  };
}
