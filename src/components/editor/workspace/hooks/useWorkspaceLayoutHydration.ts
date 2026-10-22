import { useEffect, useRef, useState } from "react";
import { createEditorGroup, selectCodeWorkspaceUi, useCodeWorkspaceStore } from "../../../../stores/codeWorkspaceStore";
import { DEFAULT_WORKSPACE_TAB_POLICY_V3, type WorkspaceTabPolicyV3 } from "../workspaceTabPolicy";
import { createSingleLeafLayout } from "../recursiveLayoutTree";
import {
  defaultWorkspaceLayoutSnapshot,
  layoutSnapshotHasOpenFiles,
  readWorkspaceLayoutSnapshot,
  uniqueOrderedKeys,
  writeWorkspaceLayoutSnapshot,
  type WorkspaceViewStates,
} from "../workspaceLayoutPersistence";
import { initialRoots, rootDirKey } from "../codeWorkspaceModel";


export interface UseWorkspaceLayoutHydrationContext {
  workspaceInstanceId: string;
  setStatusMessage: (message: string) => void;
  lastProjectPanelSizeRef: import("react").RefObject<number>;
  setTabPolicy: import("react").Dispatch<import("react").SetStateAction<WorkspaceTabPolicyV3>>;
  patchWorkspaceUi: (instanceId: string, patch: Partial<import("../../../../stores/codeWorkspaceStore").CodeWorkspaceInstanceUi>) => void;
  workspace: import("../../../../types").CodeWorkspaceTabInfo;
  seedTreeExpandIfEmpty: (instanceId: string, rootIds: string[], dirKeys: string[]) => void;
}

export function useWorkspaceLayoutHydration(context: UseWorkspaceLayoutHydrationContext) {
  const { workspaceInstanceId, setStatusMessage, lastProjectPanelSizeRef, setTabPolicy, patchWorkspaceUi, workspace, seedTreeExpandIfEmpty } = context;

  // Restore chrome/layout once per instance, then seed expand keys only when empty.
  const layoutHydratedRef = useRef<string | null>(null);
  const layoutRestoredOpenFilesRef = useRef(false);
  // ED-IMPROVE-007: in-memory per-leaf/file view snapshots; hydrated from the
  // layout snapshot before the first editor mounts so a reopen/restart applies
  // the right leaf's caret, selection, scroll and folds.
  const [hydratedViewStates] = useState<WorkspaceViewStates>(() => (
    readWorkspaceLayoutSnapshot(workspaceInstanceId)?.viewStates ?? {}
  ));
  const viewStatesRef = useRef<WorkspaceViewStates>(hydratedViewStates);
  const [viewStateRevision, setViewStateRevision] = useState(0);
  useEffect(() => {
    if (layoutHydratedRef.current === workspaceInstanceId) return;
    layoutHydratedRef.current = workspaceInstanceId;
    layoutRestoredOpenFilesRef.current = false;
    viewStatesRef.current = {};
    const snapshot = readWorkspaceLayoutSnapshot(workspaceInstanceId);
    if (snapshot) {
      viewStatesRef.current = snapshot.viewStates ?? {};
      if (snapshot.layoutRecovered) {
        setStatusMessage("Recovered invalid workspace layout into a single editor leaf");
      }
      if (snapshot.shellChromeState?.projectWidthPx) {
        lastProjectPanelSizeRef.current = snapshot.shellChromeState.projectWidthPx;
      }
      setTabPolicy(snapshot.tabPolicy ?? { ...DEFAULT_WORKSPACE_TAB_POLICY_V3 });
      patchWorkspaceUi(workspaceInstanceId, {
        bottomDockOpen: snapshot.bottomDockOpen,
        bottomDockTab: snapshot.bottomDockTab,
        rightPaneOpen: snapshot.rightPaneOpen,
        rightPaneTab: snapshot.rightPaneTab,
        languagePanelOpen: snapshot.languagePanelOpen,
        splitOrientation: snapshot.splitOrientation,
        activeEditorGroupId: snapshot.activeEditorGroupId,
        expandedRootIds: snapshot.expandedRootIds,
        expandedDirKeys: snapshot.expandedDirKeys,
        layoutTreeV2: snapshot.layoutTreeV2,
        shellChromeState: snapshot.shellChromeState,
        editorGroups: Object.fromEntries(
          Object.entries(snapshot.editorGroups).map(([id, g]) => [
            id,
            {
              id,
              openOrder: g.openOrder,
              activeKey: g.activeKey,
              previewKey: g.previewKey,
              pinnedKeys: g.pinnedKeys,
            },
          ]),
        ),
        openOrder: uniqueOrderedKeys(snapshot.editorGroups),
        activeKey: snapshot.editorGroups[snapshot.activeEditorGroupId]?.activeKey
          ?? snapshot.editorGroups.primary?.activeKey
          ?? snapshot.editorGroups.secondary?.activeKey
          ?? null,
      });
      writeWorkspaceLayoutSnapshot(workspaceInstanceId, snapshot);
      layoutRestoredOpenFilesRef.current = layoutSnapshotHasOpenFiles(snapshot);
      return;
    }
    const seedRoots = initialRoots(workspace);
    // §8.16.4 N6.6: fresh mounts materialize a single-leaf v2 tree
    // immediately so the recursive renderer is the only production layout
    // path from first paint; the primary/secondary fallback never renders.
    // The dormant "secondary" group stays present-but-empty: empty legacy
    // slots carry no layout truth (see validateTreeGroupConsistency).
    const uiNow = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), workspaceInstanceId);
    patchWorkspaceUi(workspaceInstanceId, {
      layoutTreeV2: createSingleLeafLayout(
        "primary",
        uiNow.editorGroups.primary?.openOrder ?? [],
        uiNow.editorGroups.primary?.activeKey ?? null,
      ),
      editorGroups: {
        primary: uiNow.editorGroups.primary ?? createEditorGroup("primary"),
        secondary: createEditorGroup("secondary"),
      },
      activeEditorGroupId: "primary",
    });
    writeWorkspaceLayoutSnapshot(workspaceInstanceId, defaultWorkspaceLayoutSnapshot());
    if (seedRoots.length === 0) return;
    seedTreeExpandIfEmpty(
      workspaceInstanceId,
      seedRoots.map((root) => root.id),
      seedRoots.map((root) => rootDirKey(root.id, "")),
    );
  }, [patchWorkspaceUi, seedTreeExpandIfEmpty, workspace, workspaceInstanceId]);
  return { viewStatesRef, setViewStateRevision, layoutRestoredOpenFilesRef, viewStateRevision };
}
