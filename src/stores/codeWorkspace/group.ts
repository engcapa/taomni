import type { StoreApi } from "zustand";
import { setLeafTabs } from "../../components/editor/workspace/recursiveLayoutTree";
import { createDefaultCodeWorkspaceUi, createEditorGroup } from "./defaults";
import { type CodeWorkspaceStoreState } from "./model";
import { resolveUpdater } from "./updates";

export function createWorkspaceGroupActions(set: StoreApi<CodeWorkspaceStoreState>["setState"], get: StoreApi<CodeWorkspaceStoreState>["getState"]): Pick<CodeWorkspaceStoreState, "setActiveKey" | "setOpenOrder" | "updateEditorGroup" | "setActiveEditorGroup" | "setSplitOrientation"> {
  return {

    setActiveKey: (instanceId, key) => {
      get().ensureInstance(instanceId);
      set((state) => {
        const current = state.byInstanceId[instanceId] ?? createDefaultCodeWorkspaceUi();
        const groupId = current.activeEditorGroupId;
        const group = current.editorGroups[groupId];
        if (current.activeKey === key && group?.activeKey === key) return state;
        return {
          byInstanceId: {
            ...state.byInstanceId,
            [instanceId]: {
              ...current,
              layoutRevision: current.layoutRevision + 1,
              activeKey: key,
              editorGroups: {
                ...current.editorGroups,
                [groupId]: group ? { ...group, activeKey: key } : createEditorGroup(groupId),
              },
            },
          },
        };
      });
    },

    setOpenOrder: (instanceId, order) => {
      get().ensureInstance(instanceId);
      set((state) => {
        const current = state.byInstanceId[instanceId] ?? createDefaultCodeWorkspaceUi();
        const groupId = current.activeEditorGroupId;
        const group = current.editorGroups[groupId];
        const unchanged =
          current.openOrder.length === order.length &&
          current.openOrder.every((k, i) => k === order[i]) &&
          group &&
          group.openOrder.length === order.length &&
          group.openOrder.every((k, i) => k === order[i]);
        if (unchanged) return state;
        return {
          byInstanceId: {
            ...state.byInstanceId,
            [instanceId]: {
              ...current,
              layoutRevision: current.layoutRevision + 1,
              openOrder: order,
              editorGroups: {
                ...current.editorGroups,
                [groupId]: group ? { ...group, openOrder: order } : { ...createEditorGroup(groupId), openOrder: order },
              },
            },
          },
        };
      });
    },

    updateEditorGroup: (instanceId, groupId, updater) => {
      get().ensureInstance(instanceId);
      set((state) => {
        const current = state.byInstanceId[instanceId] ?? createDefaultCodeWorkspaceUi();
        const prevGroup = current.editorGroups[groupId];
        const nextGroup = resolveUpdater(prevGroup, updater);
        if (nextGroup === prevGroup) return state;
        if (
          prevGroup &&
          prevGroup.activeKey === nextGroup.activeKey &&
          prevGroup.previewKey === nextGroup.previewKey &&
          prevGroup.openOrder.length === nextGroup.openOrder.length &&
          prevGroup.openOrder.every((k, i) => k === nextGroup.openOrder[i]) &&
          prevGroup.pinnedKeys.length === nextGroup.pinnedKeys.length &&
          prevGroup.pinnedKeys.every((k, i) => k === nextGroup.pinnedKeys[i])
        ) {
          return state;
        }
        const active = current.activeEditorGroupId === groupId;
        // §8.16.4 N6.6: mirror group writes into the recursive tree so the
        // leaf stays the structural truth (same reference when unchanged).
        const nextTree = setLeafTabs(current.layoutTreeV2, groupId, nextGroup.openOrder, nextGroup.activeKey);
        return {
          byInstanceId: {
            ...state.byInstanceId,
            [instanceId]: {
              ...current,
              layoutRevision: current.layoutRevision + 1,
              openOrder: active ? nextGroup.openOrder : current.openOrder,
              activeKey: active ? nextGroup.activeKey : current.activeKey,
              editorGroups: { ...current.editorGroups, [groupId]: nextGroup },
              layoutTreeV2: nextTree,
            },
          },
        };
      });
    },

    setActiveEditorGroup: (instanceId, groupId) => {
      get().ensureInstance(instanceId);
      set((state) => {
        const current = state.byInstanceId[instanceId] ?? createDefaultCodeWorkspaceUi();
        if (current.activeEditorGroupId === groupId) return state;
        const group = current.editorGroups[groupId];
        return {
          byInstanceId: {
            ...state.byInstanceId,
            [instanceId]: {
              ...current,
              layoutRevision: current.layoutRevision + 1,
              activeEditorGroupId: groupId,
              openOrder: group?.openOrder ?? current.openOrder,
              activeKey: group?.activeKey ?? current.activeKey,
            },
          },
        };
      });
    },

    setSplitOrientation: (instanceId, orientation) => {
      get().ensureInstance(instanceId);
      set((state) => {
        const current = state.byInstanceId[instanceId] ?? createDefaultCodeWorkspaceUi();
        if (current.splitOrientation === orientation) return state;
        return {
          byInstanceId: {
            ...state.byInstanceId,
            [instanceId]: {
              ...current,
              layoutRevision: current.layoutRevision + 1,
              splitOrientation: orientation,
            },
          },
        };
      });
    }
  };
}
