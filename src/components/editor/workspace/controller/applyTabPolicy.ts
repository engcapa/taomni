import { selectCodeWorkspaceUi, useCodeWorkspaceStore, type BottomDockTabId, type EditorGroupId, type EditorSplitOrientation, type RightPaneTabId } from "../../../../stores/codeWorkspaceStore";
import { SaveTransactionRegistry } from "../saveCommit";
import { workspaceFileIdentity } from "../workspaceRecovery";
import { applyTabPolicyGroupImagesToLayout, applyWorkspaceTabPolicyTransaction, pushClosedTab, buildReopenTreeRoute, type ClosedTabEntry, type WorkspaceTabPolicyV3 } from "../workspaceTabPolicy";
import { findLeafNode } from "../recursiveLayoutTree";
import { snapshotFromWorkspaceUi, writeWorkspaceLayoutSnapshot } from "../workspaceLayoutPersistence";
import { confirmAppDialog } from "../../../../lib/appDialogs";
import { WorkspaceResourceRecoveryCoordinator, type ResourceCleanupHandlers, type ResourceCleanupOutcome } from "../workspaceResourceRecoveryCoordinator";
import { type LibraryBufferInfo, type LspFileState, type MarkdownViewMode, type OpenFileState } from "../codeWorkspaceModel";
import { type PendingExternalFileEvent, type TabPolicyLifecycleReceiptView } from "./model";


export interface ApplyTabPolicyContext {
  workspaceInstanceId: string;
  tabPolicyRef: import("react").RefObject<WorkspaceTabPolicyV3>;
  openFilesRef: import("react").RefObject<Record<string, import("../editorGroupTypes").OpenFileViewModel>>;
  mruFileKeysRef: import("react").RefObject<string[]>;
  baseLayoutRevision: number;
  resourceRecoveryCoordinatorRef: import("react").RefObject<WorkspaceResourceRecoveryCoordinator>;
  activeEditorGroupId: string;
  closeLspDocumentAndWait: (file: OpenFileState) => Promise<void>;
  pendingExternalFileEventsRef: import("react").RefObject<Map<string, PendingExternalFileEvent>>;
  saveTransactionRegistryRef: import("react").RefObject<SaveTransactionRegistry>;
  setOpenFiles: (updater: Record<string, OpenFileState> | ((prev: Record<string, OpenFileState>) => Record<string, OpenFileState>)) => void;
  setMarkdownModes: (updater: Record<string, MarkdownViewMode> | ((prev: Record<string, MarkdownViewMode>) => Record<string, MarkdownViewMode>)) => void;
  setLspFiles: (updater: Record<string, LspFileState> | ((prev: Record<string, LspFileState>) => Record<string, LspFileState>)) => void;
  setClosedTabsStack: import("react").Dispatch<import("react").SetStateAction<readonly ClosedTabEntry[]>>;
  observeResourceCleanupOutcome: (outcome: ResourceCleanupOutcome, handlers: ResourceCleanupHandlers) => void;
  setTabPolicy: import("react").Dispatch<import("react").SetStateAction<WorkspaceTabPolicyV3>>;
  setTabPolicyRevision: import("react").Dispatch<import("react").SetStateAction<number>>;
  libraryBuffersRef: import("react").RefObject<Record<string, LibraryBufferInfo>>;
  bottomDockOpen: boolean;
  bottomDockTab: BottomDockTabId;
  rightPaneOpen: boolean;
  rightPaneTab: RightPaneTabId;
  languagePanelOpen: boolean;
  splitOrientation: EditorSplitOrientation | null;
  expandedRootIds: string[];
  expandedDirKeys: string[];
  workspaceUi: Omit<import("../../../../stores/codeWorkspaceStore").CodeWorkspaceInstanceUi, "treeSelection">;
  setStatusMessage: (message: string) => void;
  setTabPolicyReceipt: import("react").Dispatch<import("react").SetStateAction<TabPolicyLifecycleReceiptView | null>>;
}


export function createApplyTabPolicy(controllerContext: ApplyTabPolicyContext): (policy: WorkspaceTabPolicyV3) => boolean | void | Promise<boolean | void> {
  return async (nextPolicyRaw) => {
    const currentUi = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), controllerContext.workspaceInstanceId);
    const cleanupOutcomes: ResourceCleanupOutcome[] = [];
    const result = await applyWorkspaceTabPolicyTransaction({
      workspaceInstanceId: controllerContext.workspaceInstanceId,
      nextPolicyRaw,
      currentPolicy: controllerContext.tabPolicyRef.current,
      currentGroups: currentUi.editorGroups,
      openFiles: controllerContext.openFilesRef.current,
      mruFileKeys: controllerContext.mruFileKeysRef.current,
      baseLayoutRevision: controllerContext.baseLayoutRevision,
      currentLayoutRevision: currentUi.layoutRevision,
      getLiveLayoutRevision: () => selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), controllerContext.workspaceInstanceId).layoutRevision,
      confirmDirtyClose: async (dirtyKeys) => {
        const names = dirtyKeys.map((k) => controllerContext.openFilesRef.current[k]?.title ?? k).join(", ");
        return confirmAppDialog({
          title: "Apply editor tab policy",
          message: `The following files have unsaved changes:\n${names}\n\nApply tab limit policy and discard changes?`,
          confirmLabel: "Apply and discard",
          danger: true,
        });
      },
      onEvictClosedFile: async (evictedKey) => {
        const file = controllerContext.openFilesRef.current[evictedKey];
        const coordinator = controllerContext.resourceRecoveryCoordinatorRef.current;
        const currentUiNow = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), controllerContext.workspaceInstanceId);
        const currentTree = currentUiNow.layoutTreeV2;
        const activeLeaf = findLeafNode(currentTree, controllerContext.activeEditorGroupId);

        const cleanupHandlers: ResourceCleanupHandlers = {
          didClose: async () => {
            if (file) await controllerContext.closeLspDocumentAndWait(file);
          },
          watcher: () => {
            const pending = controllerContext.pendingExternalFileEventsRef.current.get(evictedKey);
            if (pending) {
              window.clearTimeout(pending.timer);
              controllerContext.pendingExternalFileEventsRef.current.delete(evictedKey);
            }
          },
          buffer: () => {
            controllerContext.saveTransactionRegistryRef.current.discardFile(
              controllerContext.workspaceInstanceId,
              evictedKey,
              `Buffer ${file?.subtitle ?? evictedKey} was evicted`,
            );
            controllerContext.setOpenFiles((prev) => {
              if (!(evictedKey in prev)) return prev;
              const next = { ...prev };
              delete next[evictedKey];
              return next;
            });
            controllerContext.setMarkdownModes((prev) => {
              if (!(evictedKey in prev)) return prev;
              const next = { ...prev };
              delete next[evictedKey];
              return next;
            });
            controllerContext.setLspFiles((prev) => {
              if (!(evictedKey in prev)) return prev;
              const next = { ...prev };
              delete next[evictedKey];
              return next;
            });
          },
          history: () => {
            if (file) {
              controllerContext.setClosedTabsStack((stack) =>
                pushClosedTab(stack, {
                  fileIdentity: workspaceFileIdentity(file.ref),
                  ref: file.ref,
                  title: file.title,
                  subtitle: file.subtitle,
                  leafPath: [controllerContext.activeEditorGroupId],
                  closedAt: Date.now(),
                  location: {
                    leafId: controllerContext.activeEditorGroupId,
                    treeRoute: buildReopenTreeRoute(currentTree, controllerContext.activeEditorGroupId),
                    siblingFileKeys: (activeLeaf?.openFileKeys ?? []).filter((k) => k !== evictedKey),
                  },
                }),
              );
            }
          },
        };
        const outcome = await coordinator.executeResourceCleanup(evictedKey, cleanupHandlers);
        cleanupOutcomes.push(outcome);
        controllerContext.observeResourceCleanupOutcome(outcome, cleanupHandlers);
      },
      commitAtomicUpdate: ({ nextGroups, policy }) => {
        const committedGroups = Object.fromEntries(
          Object.entries(nextGroups).map(([groupId, group]) => [groupId, {
            id: groupId,
            openOrder: [...group.openOrder],
            pinnedKeys: [...group.pinnedKeys],
            activeKey: group.activeKey,
            previewKey: group.previewKey,
          }]),
        ) as typeof currentUi.editorGroups;
        const nextLayoutTreeV2 = applyTabPolicyGroupImagesToLayout(
          currentUi.layoutTreeV2,
          committedGroups,
        );
        const nextActiveGroup = committedGroups[currentUi.activeEditorGroupId];
        useCodeWorkspaceStore.getState().patchInstance(controllerContext.workspaceInstanceId, {
          editorGroups: committedGroups,
          layoutTreeV2: nextLayoutTreeV2,
          openOrder: nextActiveGroup?.openOrder ?? currentUi.openOrder,
          activeKey: nextActiveGroup?.activeKey ?? currentUi.activeKey,
          layoutRevision: currentUi.layoutRevision + 1,
        });
        controllerContext.setTabPolicy(policy);
        controllerContext.tabPolicyRef.current = policy;
        controllerContext.setTabPolicyRevision((r) => r + 1);

        const persistableGroups = Object.fromEntries(
          (Object.entries(committedGroups) as Array<[EditorGroupId, typeof currentUi.editorGroups.primary]>)
            .map(([groupId, group]) => [groupId, {
              ...group,
              openOrder: group.openOrder.filter((key) => !controllerContext.libraryBuffersRef.current[key]),
              pinnedKeys: group.pinnedKeys.filter((key) => !controllerContext.libraryBuffersRef.current[key]),
              activeKey: group.activeKey && controllerContext.libraryBuffersRef.current[group.activeKey] ? null : group.activeKey,
              previewKey: group.previewKey && controllerContext.libraryBuffersRef.current[group.previewKey] ? null : group.previewKey,
            }]),
        ) as typeof currentUi.editorGroups;

        let persistenceIssue: string | null = null;
        writeWorkspaceLayoutSnapshot(controllerContext.workspaceInstanceId, snapshotFromWorkspaceUi({
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
          layoutTreeV2: nextLayoutTreeV2,
          tabPolicy: policy,
          shellChromeState: controllerContext.workspaceUi.shellChromeState,
        }), {
          onIssue: (message) => {
            persistenceIssue = message;
            controllerContext.setStatusMessage(message);
          },
        });
        return {
          persisted: persistenceIssue === null,
          persistenceIssue,
        };
      },
    });
    const liveUi = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), controllerContext.workspaceInstanceId);
    controllerContext.setTabPolicyReceipt({
      status: result.status,
      layoutRevision: liveUi.layoutRevision,
      activeKey: liveUi.activeKey,
      evictedCount: result.allEvictedKeys.length,
      cleanupCount: cleanupOutcomes.length,
      cleanupCommittedCount: cleanupOutcomes.filter((outcome) => outcome.status === "committed").length,
      cleanupRecoveryCount: cleanupOutcomes.filter((outcome) => outcome.status === "committed-with-recovery").length,
      openResourceCount: Object.keys(controllerContext.openFilesRef.current).length,
    });
    const recoveryOutcome = cleanupOutcomes.find((outcome) => outcome.status === "committed-with-recovery");
    controllerContext.setStatusMessage(recoveryOutcome?.status === "committed-with-recovery"
      ? `${result.message}; ${recoveryOutcome.message}`
      : result.message);
    return result.status === "applied" || result.status === "no-op";
          };
}
