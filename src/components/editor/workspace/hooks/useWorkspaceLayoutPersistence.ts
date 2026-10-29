import { useCallback,useEffect,useMemo,useState } from "react";
import { useWorkspaceHost } from "../workspaceHostIntegration";
import { type BottomDockTabId,type CodeWorkspaceEditorGroupState,type EditorGroupId,type EditorSplitOrientation,type RightPaneTabId } from "../../../../stores/codeWorkspaceStore";
import { type WorkspaceTabPolicyV3 } from "../workspaceTabPolicy";
import { isPathContainedInRoot,NavigationHistoryFacade,workspacePathComparisonKey,type BackForwardHistoryBridge,type WorkspaceLocationController } from "../navigationHistoryModel";
import { readWorkspaceLayoutSnapshot,uniqueOrderedKeys,type WorkspaceViewStates } from "../workspaceLayoutPersistence";
import type { CodeWorkspaceFileRef,CodeWorkspaceLooseFileInfo,CodeWorkspaceRootInfo } from "../../../../types";
import { type LibraryBufferInfo,fileKey,initialFileRef } from "../codeWorkspaceModel";
import { createRestoreTimingRecorder,executeBoundedAsyncQueue,planWorkspaceRestore } from "../workspaceRestoreModel";
import { createPersistWorkspaceLayoutNow } from "../controller/layoutPersistence";
import type { WorkspaceViewStateChanges } from "../workspaceViewStateChanges";
import { useWorkspaceLayoutSaveScheduler } from "./useWorkspaceLayoutSaveScheduler";


export interface UseWorkspaceLayoutPersistenceContext {
  rootsRef: import("react").RefObject<CodeWorkspaceRootInfo[]>;
  workspaceLocationControllerRef: import("react").RefObject<WorkspaceLocationController>;
  removeNavigationLocations: (match: (location: { ref: CodeWorkspaceFileRef; line: number; character: number; }) => boolean) => void;
  reconcileNavigationFileReferences: (transform: (ref: CodeWorkspaceFileRef) => CodeWorkspaceFileRef|null) => void;
  layoutRestoredOpenFilesRef: import("react").RefObject<boolean>;
  workspaceInstanceId: string;
  initialOpenedKeyRef: import("react").RefObject<string|null>;
  restoreRunRef: import("react").RefObject<{ workspaceInstanceId: string; cancelled: boolean; cancelPending: boolean; }|null>;
  looseFiles: CodeWorkspaceLooseFileInfo[];
  activateEditorGroup: (groupId: EditorGroupId) => void;
  openFile: (ref: CodeWorkspaceFileRef,options?: { preview?: boolean; groupId?: EditorGroupId; activate?: boolean; restoring?: boolean; isCurrent?: () => boolean; }) => Promise<{ canonicalFileKey: string; groupId: string; error: string|null; }|null>;
  workspace: import("../../../../types").CodeWorkspaceTabInfo;
  roots: CodeWorkspaceRootInfo[];
  editorGroups: Record<string,CodeWorkspaceEditorGroupState>;
  libraryBuffersRef: import("react").RefObject<Record<string,LibraryBufferInfo>>;
  bottomDockOpen: boolean;
  bottomDockTab: BottomDockTabId;
  rightPaneOpen: boolean;
  rightPaneTab: RightPaneTabId;
  languagePanelOpen: boolean;
  splitOrientation: EditorSplitOrientation|null;
  activeEditorGroupId: string;
  expandedRootIds: string[];
  expandedDirKeys: string[];
  workspaceUi: import("../../../../stores/codeWorkspaceStore").CodeWorkspaceInstanceUi;
  tabPolicyRef: import("react").RefObject<WorkspaceTabPolicyV3>;
  viewStatesRef: import("react").RefObject<WorkspaceViewStates>;
  openFilesRef: import("react").RefObject<Record<string,import("../editorGroupTypes").OpenFileViewModel>>;
  setStatusMessage: (message: string) => void;
  persistWorkspaceLayoutNowRef: import("react").RefObject<((targetInstanceId?: string) => void)|null>;
  tabPolicyRevision: number;
  viewStateChanges: WorkspaceViewStateChanges;
  workspaceInstanceIdRef: import("react").RefObject<string>;
}

export function useWorkspaceLayoutPersistence(context: UseWorkspaceLayoutPersistenceContext) {
  const host = useWorkspaceHost();
  const [restoreReady, setRestoreReady] = useState(false);
  const {
    rootsRef,
    workspaceLocationControllerRef,
    removeNavigationLocations,
    reconcileNavigationFileReferences,
    layoutRestoredOpenFilesRef,
    workspaceInstanceId,
    initialOpenedKeyRef,
    restoreRunRef,
    looseFiles,
    activateEditorGroup,
    openFile,
    workspace,
    roots,
    editorGroups,
    libraryBuffersRef,
    bottomDockOpen,
    bottomDockTab,
    rightPaneOpen,
    rightPaneTab,
    languagePanelOpen,
    splitOrientation,
    activeEditorGroupId,
    expandedRootIds,
    expandedDirKeys,
    workspaceUi,
    tabPolicyRef,
    viewStatesRef,
    openFilesRef,
    setStatusMessage,
    persistWorkspaceLayoutNowRef,
    tabPolicyRevision,
    viewStateChanges,
    workspaceInstanceIdRef,
  }=context;

  // §8.16.5 N2.6: single facade for Recent Locations + Back/Forward so
  // rename/delete/remove operations keep both histories in sync.
  const navigationPathForRef=useCallback((ref: CodeWorkspaceFileRef): string|null => {
    if(ref.kind==="loose") return ref.path;
    const root=rootsRef.current.find((candidate) => candidate.id===ref.rootId);
    if(!root) return null;
    return `${root.path}/${ref.path}`;
  },[]);

  const navigationHistoryFacade=useMemo(() => {
    const controller=workspaceLocationControllerRef.current;
    const remapRef=(ref: CodeWorkspaceFileRef,fromPath: string,toPath: string): CodeWorkspaceFileRef|null => {
      const refPath=navigationPathForRef(ref);
      if(refPath==null) return ref;
      const fromKey=workspacePathComparisonKey(fromPath);
      if(workspacePathComparisonKey(refPath)!==fromKey) return ref;
      if(ref.kind==="loose") return { ...ref,path: toPath };
      const nextRel=toPath.split("/").slice(-ref.path.split("/").length).join("/");
      return { ...ref,path: nextRel };
    };
    const bridge: BackForwardHistoryBridge={
      removeLocation: (identity) => {
        removeNavigationLocations((loc) => {
          const locPath=navigationPathForRef(loc.ref);
          return (identity.fileKey!==null&&fileKey(loc.ref)===identity.fileKey)
            ||(locPath!==null
              &&workspacePathComparisonKey(locPath)===workspacePathComparisonKey(identity.canonicalPath));
        });
      },
      relocateFile: (fromPath,toPath) => {
        reconcileNavigationFileReferences((ref) => remapRef(ref,fromPath,toPath));
      },
      removeDirectorySubtree: (dirPath) => {
        removeNavigationLocations((loc) => {
          const locPath=navigationPathForRef(loc.ref);
          return locPath!==null&&isPathContainedInRoot(locPath,dirPath);
        });
      },
    };
    return new NavigationHistoryFacade(controller,undefined,bridge);
  },[
    navigationPathForRef,
    reconcileNavigationFileReferences,
    removeNavigationLocations,
  ]);

  useEffect(() => {
    if(layoutRestoredOpenFilesRef.current) {
      const snapshot=readWorkspaceLayoutSnapshot(workspaceInstanceId);
      if(!snapshot) {
        layoutRestoredOpenFilesRef.current=false;
      } else {
        const keys=uniqueOrderedKeys(snapshot.editorGroups);
        if(keys.length===0) {
          layoutRestoredOpenFilesRef.current=false;
        } else {
          // StrictMode cleans up the first effect pass before running the
          // second one. A run that survived deferred cleanup is reused so
          // the second pass does not issue duplicate native reads.
          if(
            initialOpenedKeyRef.current===`restored:${workspaceInstanceId}`
            &&restoreRunRef.current
          ) return;
          initialOpenedKeyRef.current=`restored:${workspaceInstanceId}`;
          const plan=planWorkspaceRestore(snapshot,looseFiles);
          const restoreRun={ workspaceInstanceId,cancelled: false,cancelPending: false };
          restoreRunRef.current=restoreRun;
          const isCurrent=() => restoreRunRef.current===restoreRun&&!restoreRun.cancelled;
          // ED-AUDIT-013: app-clock restore milestones for the performance
          // contract (request -> active ready -> all ready). activeReady
          // marks the active-open drain; the case proves editability with a
          // real keystroke right after, and the completion line below lands
          // in the run console artifact for aggregation. Durations derive
          // from these marks, never from runner step timings.
          const restoreTimings=createRestoreTimingRecorder(
            plan.activeTargets.length,
            plan.backgroundTargets.length,
          );
          restoreTimings.markRequested();

          // Restore active group selection
          if(plan.activeGroupId) {
            activateEditorGroup(plan.activeGroupId);
          }

          // Restore active tabs before starting background work. Both phases
          // use the same bounded queue so multiple split leaves cannot add
          // unbounded active reads on top of the background pool.
          void executeBoundedAsyncQueue(
            plan.activeTargets,
            (target) => openFile(target.ref,{
              groupId: target.groupId,
              preview: target.preview,
              activate: true,
              restoring: true,
              isCurrent,
            }),
            3,
          ).then((activeOutcomes) => {
            restoreTimings.markActiveReady();
            if(!isCurrent()) restoreTimings.markCancelled();
            if(plan.backgroundTargets.length===0) {
              restoreTimings.markAllReady();
              console.log(`[restore-timings] ${JSON.stringify({
                workspaceInstanceId,
                ...restoreTimings.toJSON(),
                activeSettled: activeOutcomes.length,
                backgroundSettled: 0,
              })}`);
              return [];
            }
            return executeBoundedAsyncQueue(
              plan.backgroundTargets,
              (target) => openFile(target.ref,{
                groupId: target.groupId,
                preview: target.preview,
                activate: false,
                restoring: true,
                isCurrent,
              }),
              3,
            ).then((backgroundOutcomes) => {
              restoreTimings.markAllReady();
              if(!isCurrent()) restoreTimings.markCancelled();
              console.log(`[restore-timings] ${JSON.stringify({
                workspaceInstanceId,
                ...restoreTimings.toJSON(),
                activeSettled: activeOutcomes.length,
                backgroundSettled: backgroundOutcomes.length,
              })}`);
              return backgroundOutcomes;
            });
          }).finally(() => {
            layoutRestoredOpenFilesRef.current=false;
            setRestoreReady(true);
          });
          return;
        }
      }
    }
    setRestoreReady(true);
    if (host && !host.showEditorTabs) return;
    const ref=initialFileRef(workspace,roots,looseFiles);
    if(!ref) return;
    // Root-file requests belong to the host. Its active-file publications are
    // recent-workspace metadata, not another open command during transactions.
    // Loose files still use the editor's initial target once per lifetime.
    if (host && (ref.kind === "root" || initialOpenedKeyRef.current !== null)) return;
    const key=fileKey(ref);
    if(initialOpenedKeyRef.current===key) return;
    initialOpenedKeyRef.current=key;
    void openFile(ref);
  },[looseFiles,openFile,roots,workspace,workspaceInstanceId]);

  const persistWorkspaceLayoutNow=useCallback(createPersistWorkspaceLayoutNow({
    workspaceInstanceId,
    layoutRestoredOpenFilesRef,
    editorGroups,
    libraryBuffersRef,
    bottomDockOpen,
    bottomDockTab,
    rightPaneOpen,
    rightPaneTab,
    languagePanelOpen,
    splitOrientation,
    activeEditorGroupId,
    expandedRootIds,
    expandedDirKeys,
    workspaceUi,
    tabPolicyRef,
    viewStatesRef,
    openFilesRef,
    setStatusMessage,
  }),[
    activeEditorGroupId,
    bottomDockOpen,
    bottomDockTab,
    editorGroups,
    expandedDirKeys,
    expandedRootIds,
    languagePanelOpen,
    rightPaneOpen,
    rightPaneTab,
    splitOrientation,
    workspaceInstanceId,
    workspaceUi.layoutTreeV2,
    workspaceUi.shellChromeState,
  ]);

  persistWorkspaceLayoutNowRef.current=persistWorkspaceLayoutNow;

  const { schedule: scheduleLayoutSave, cancel: cancelLayoutSave } = useWorkspaceLayoutSaveScheduler(
    workspaceInstanceId, persistWorkspaceLayoutNowRef, viewStateChanges,
  );

  useEffect(() => {
    if(!workspaceInstanceId) return;
    scheduleLayoutSave();
    return cancelLayoutSave;
  },[
    activeEditorGroupId,
    bottomDockOpen,
    bottomDockTab,
    editorGroups,
    expandedDirKeys,
    expandedRootIds,
    languagePanelOpen,
    rightPaneOpen,
    rightPaneTab,
    splitOrientation,
    workspaceInstanceId,
    workspaceUi.layoutTreeV2,
    workspaceUi.shellChromeState,
    tabPolicyRevision,
    scheduleLayoutSave,
    cancelLayoutSave,
  ]);

  // ED-REPAIR-009: Flush layout snapshot on workspace unmount / window close
  useEffect(() => {
    const handleBeforeUnload=() => {
      persistWorkspaceLayoutNowRef.current?.(workspaceInstanceIdRef.current);
    };
    window.addEventListener("beforeunload",handleBeforeUnload);
    return () => {
      window.removeEventListener("beforeunload",handleBeforeUnload);
      persistWorkspaceLayoutNowRef.current?.(workspaceInstanceId);
    };
  },[workspaceInstanceId]);
  return { navigationHistoryFacade, restoreReady };
}
