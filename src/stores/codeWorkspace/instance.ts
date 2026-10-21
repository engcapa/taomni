import type { StoreApi } from "zustand";
import { createDefaultCodeWorkspaceUi, EMPTY_UI } from "./defaults";
import { type CodeWorkspaceStoreState } from "./model";
import { sameEditorGroups, sameLayoutTree, sameStringArray } from "./updates";

export function createWorkspaceInstanceActions(set: StoreApi<CodeWorkspaceStoreState>["setState"], get: StoreApi<CodeWorkspaceStoreState>["getState"]): Pick<CodeWorkspaceStoreState, "byInstanceId" | "ensureInstance" | "disposeInstance" | "getInstance" | "patchInstance"> {
  return {
    byInstanceId: {},

    ensureInstance: (instanceId) => {
      if (!instanceId) return;
      if (get().byInstanceId[instanceId]) return;
      set((state) => ({
        byInstanceId: {
          ...state.byInstanceId,
          [instanceId]: createDefaultCodeWorkspaceUi(),
        },
      }));
    },

    disposeInstance: (instanceId) => {
      if (!get().byInstanceId[instanceId]) return;
      set((state) => {
        const next = { ...state.byInstanceId };
        delete next[instanceId];
        return { byInstanceId: next };
      });
    },

    getInstance: (instanceId) => {
      return get().byInstanceId[instanceId] ?? EMPTY_UI;
    },

    patchInstance: (instanceId, patch) => {
      get().ensureInstance(instanceId);
      set((state) => {
        const current = state.byInstanceId[instanceId] ?? createDefaultCodeWorkspaceUi();
        let isLayoutChanged = false;
        if (patch.activeKey !== undefined && patch.activeKey !== current.activeKey) {
          isLayoutChanged = true;
        }
        if (patch.activeEditorGroupId !== undefined && patch.activeEditorGroupId !== current.activeEditorGroupId) {
          isLayoutChanged = true;
        }
        if (patch.splitOrientation !== undefined && patch.splitOrientation !== current.splitOrientation) {
          isLayoutChanged = true;
        }
        if (patch.layoutTreeV2 !== undefined && !sameLayoutTree(patch.layoutTreeV2, current.layoutTreeV2)) {
          isLayoutChanged = true;
        }
        if (patch.editorGroups !== undefined && !sameEditorGroups(patch.editorGroups, current.editorGroups)) {
          isLayoutChanged = true;
        }
        if (patch.openOrder !== undefined && !sameStringArray(patch.openOrder, current.openOrder)) {
          isLayoutChanged = true;
        }

        let anyFieldChanged = false;
        for (const [key, val] of Object.entries(patch)) {
          if ((current as unknown as Record<string, unknown>)[key] !== val) {
            anyFieldChanged = true;
            break;
          }
        }
        if (!anyFieldChanged && patch.layoutRevision === undefined) {
          return state;
        }

        const nextRevision =
          patch.layoutRevision !== undefined
            ? patch.layoutRevision
            : isLayoutChanged
              ? current.layoutRevision + 1
              : current.layoutRevision;

        return {
          byInstanceId: {
            ...state.byInstanceId,
            [instanceId]: { ...current, ...patch, layoutRevision: nextRevision },
          },
        };
      });
    }
  };
}
