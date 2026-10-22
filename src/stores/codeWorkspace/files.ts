import type { StoreApi } from "zustand";
import { remapLayoutTreeKeys } from "../../components/editor/workspace/recursiveLayoutTree";
import { createDefaultCodeWorkspaceUi, createEditorGroup } from "./defaults";
import { type CodeWorkspaceInstanceUi, type CodeWorkspaceStoreState } from "./model";
import { reconcileEditorGroupFiles, remapMarkdownModes, resolveUpdater } from "./updates";

export function createWorkspaceFileActions(set: StoreApi<CodeWorkspaceStoreState>["setState"], get: StoreApi<CodeWorkspaceStoreState>["getState"]): Pick<CodeWorkspaceStoreState, "setMarkdownMode" | "replaceFileState" | "bumpLayoutRevision" | "updateOpenFiles" | "updateLspFiles" | "updateExpandedRootIds" | "updateExpandedDirKeys" | "seedTreeExpandIfEmpty"> {
  return {

    setMarkdownMode: (instanceId, fileKey, mode) => {
      get().ensureInstance(instanceId);
      set((state) => {
        const current = state.byInstanceId[instanceId] ?? createDefaultCodeWorkspaceUi();
        return {
          byInstanceId: {
            ...state.byInstanceId,
            [instanceId]: {
              ...current,
              markdownModes: { ...current.markdownModes, [fileKey]: mode },
            },
          },
        };
      });
    },

    replaceFileState: (instanceId, replacement) => {
      get().ensureInstance(instanceId);
      set((state) => {
        const current = state.byInstanceId[instanceId] ?? createDefaultCodeWorkspaceUi();
        const validKeys = new Set(Object.keys(replacement.openFiles));
        const editorGroups: CodeWorkspaceInstanceUi["editorGroups"] = {};
        for (const [gid, grp] of Object.entries(current.editorGroups)) {
          if (grp) {
            editorGroups[gid] = reconcileEditorGroupFiles(
              grp,
              replacement.keyChanges,
              validKeys,
            );
          }
        }
        if (!editorGroups.primary) {
          editorGroups.primary = createEditorGroup("primary");
        }
        if (!editorGroups.secondary) {
          editorGroups.secondary = createEditorGroup("secondary");
        }
        const activeGroup = editorGroups[current.activeEditorGroupId] ?? editorGroups.primary;
        const layoutTreeV2 = remapLayoutTreeKeys(current.layoutTreeV2, replacement.keyChanges, validKeys, editorGroups);
        return {
          byInstanceId: {
            ...state.byInstanceId,
            [instanceId]: {
              ...current,
              layoutRevision: current.layoutRevision + 1,
              openFiles: replacement.openFiles,
              lspFiles: replacement.lspFiles,
              editorGroups,
              layoutTreeV2,
              openOrder: activeGroup.openOrder,
              activeKey: activeGroup.activeKey,
              markdownModes: remapMarkdownModes(current.markdownModes, replacement.keyChanges, validKeys),
              recentFilesOpen: false,
              recentEntries: [],
              locationPeek: null,
            },
          },
        };
      });
    },

    bumpLayoutRevision: (instanceId: string) => {
      get().ensureInstance(instanceId);
      let nextRev = 1;
      set((state) => {
        const current = state.byInstanceId[instanceId] ?? createDefaultCodeWorkspaceUi();
        nextRev = current.layoutRevision + 1;
        return {
          byInstanceId: {
            ...state.byInstanceId,
            [instanceId]: {
              ...current,
              layoutRevision: nextRev,
            },
          },
        };
      });
      return nextRev;
    },

    updateOpenFiles: (instanceId, updater) => {
      get().ensureInstance(instanceId);
      set((state) => {
        const current = state.byInstanceId[instanceId] ?? createDefaultCodeWorkspaceUi();
        const openFiles = resolveUpdater(current.openFiles, updater);
        if (openFiles === current.openFiles) return state;
        return {
          byInstanceId: {
            ...state.byInstanceId,
            [instanceId]: {
              ...current,
              openFiles,
            },
          },
        };
      });
    },

    updateLspFiles: (instanceId, updater) => {
      get().ensureInstance(instanceId);
      set((state) => {
        const current = state.byInstanceId[instanceId] ?? createDefaultCodeWorkspaceUi();
        const lspFiles = resolveUpdater(current.lspFiles, updater);
        if (lspFiles === current.lspFiles) return state;
        return {
          byInstanceId: {
            ...state.byInstanceId,
            [instanceId]: {
              ...current,
              lspFiles,
            },
          },
        };
      });
    },

    updateExpandedRootIds: (instanceId, updater) => {
      get().ensureInstance(instanceId);
      set((state) => {
        const current = state.byInstanceId[instanceId] ?? createDefaultCodeWorkspaceUi();
        return {
          byInstanceId: {
            ...state.byInstanceId,
            [instanceId]: {
              ...current,
              expandedRootIds: resolveUpdater(current.expandedRootIds, updater),
            },
          },
        };
      });
    },

    updateExpandedDirKeys: (instanceId, updater) => {
      get().ensureInstance(instanceId);
      set((state) => {
        const current = state.byInstanceId[instanceId] ?? createDefaultCodeWorkspaceUi();
        return {
          byInstanceId: {
            ...state.byInstanceId,
            [instanceId]: {
              ...current,
              expandedDirKeys: resolveUpdater(current.expandedDirKeys, updater),
            },
          },
        };
      });
    },

    seedTreeExpandIfEmpty: (instanceId, rootIds, dirKeys) => {
      get().ensureInstance(instanceId);
      set((state) => {
        const current = state.byInstanceId[instanceId] ?? createDefaultCodeWorkspaceUi();
        if (current.expandedRootIds.length > 0 || current.expandedDirKeys.length > 0) {
          return state;
        }
        if (rootIds.length === 0) return state;
        return {
          byInstanceId: {
            ...state.byInstanceId,
            [instanceId]: {
              ...current,
              expandedRootIds: rootIds,
              expandedDirKeys: dirKeys,
            },
          },
        };
      });
    }
  };
}
