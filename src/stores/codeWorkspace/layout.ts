import type { StoreApi } from "zustand";
import {
  atomicCloseLeaf,
  atomicCloseTabInLeaf,
  atomicMoveTab,
  atomicSetLeafActiveTab,
  atomicSplitLeaf,
  commitLayoutMutation,
  equalizeLeafParentSplit,
  getAllLeafNodes,
  stretchLeafInTree,
  unsplitAllLeaves,
  updateSplitNodeRatios,
  validateLayoutTree,
  type LayoutMutationResult,
} from "../../components/editor/workspace/recursiveLayoutTree";
import { createDefaultCodeWorkspaceUi } from "./defaults";
import { type CodeWorkspaceEditorGroupState, type CodeWorkspaceStoreState } from "./model";
import { sameLayoutTree } from "./updates";

export function createWorkspaceLayoutActions(set: StoreApi<CodeWorkspaceStoreState>["setState"], get: StoreApi<CodeWorkspaceStoreState>["getState"]): Pick<CodeWorkspaceStoreState, "setLayoutTreeV2" | "splitLayoutLeaf" | "closeLayoutLeaf" | "moveLayoutTab" | "setLeafActiveTab" | "closeLayoutTabInLeaf" | "setLayoutNodeRatios" | "equalizeLayoutRatios" | "stretchLayoutLeaf" | "unsplitAllLayout"> {
  return {

    setLayoutTreeV2: (instanceId, layoutTree) => {
      get().ensureInstance(instanceId);
      if (!validateLayoutTree(layoutTree).valid) return;
      set((state) => {
        const current = state.byInstanceId[instanceId] ?? createDefaultCodeWorkspaceUi();
        if (sameLayoutTree(current.layoutTreeV2, layoutTree)) return state;
        return {
          byInstanceId: {
            ...state.byInstanceId,
            [instanceId]: {
              ...current,
              layoutRevision: current.layoutRevision + 1,
              layoutTreeV2: layoutTree,
            },
          },
        };
      });
    },

    splitLayoutLeaf: (instanceId, leafId, orientation, newFileKey) => {
      get().ensureInstance(instanceId);
      set((state) => {
        const current = state.byInstanceId[instanceId] ?? createDefaultCodeWorkspaceUi();
        const currentTree = current.layoutTreeV2;
        const rawResult = atomicSplitLeaf(
          currentTree,
          current.editorGroups,
          current.activeEditorGroupId,
          leafId,
          orientation,
          newFileKey,
        );
        const result = commitLayoutMutation(currentTree, current.editorGroups, current.activeEditorGroupId, rawResult);
        if (result.kind !== "changed") {
          return state;
        }
        return {
          byInstanceId: {
            ...state.byInstanceId,
            [instanceId]: {
              ...current,
              layoutRevision: current.layoutRevision + 1,
              layoutTreeV2: result.tree,
              editorGroups: result.groups,
              activeEditorGroupId: result.activeGroupId,
              splitOrientation: orientation,
            },
          },
        };
      });
    },

    closeLayoutLeaf: (instanceId, leafId) => {
      get().ensureInstance(instanceId);
      set((state) => {
        const current = state.byInstanceId[instanceId] ?? createDefaultCodeWorkspaceUi();
        const rawResult = atomicCloseLeaf(
          current.layoutTreeV2,
          current.editorGroups,
          current.activeEditorGroupId,
          leafId,
        );
        const result = commitLayoutMutation(current.layoutTreeV2, current.editorGroups, current.activeEditorGroupId, rawResult);
        if (result.kind !== "changed") {
          return state;
        }
        const activeGroup = result.groups[result.activeGroupId];
        return {
          byInstanceId: {
            ...state.byInstanceId,
            [instanceId]: {
              ...current,
              layoutRevision: current.layoutRevision + 1,
              layoutTreeV2: result.tree,
              editorGroups: result.groups,
              activeEditorGroupId: result.activeGroupId,
              splitOrientation: result.tree.type === "split" ? result.tree.orientation : null,
              openOrder: activeGroup?.openOrder ?? current.openOrder,
              activeKey: activeGroup?.activeKey ?? null,
            },
          },
        };
      });
    },

    moveLayoutTab: (instanceId, sourceLeafId, targetLeafId, fileKey) => {
      get().ensureInstance(instanceId);
      set((state) => {
        const current = state.byInstanceId[instanceId] ?? createDefaultCodeWorkspaceUi();
        const rawResult = atomicMoveTab(
          current.layoutTreeV2,
          current.editorGroups,
          current.activeEditorGroupId,
          sourceLeafId,
          targetLeafId,
          fileKey,
        );
        const result = commitLayoutMutation(current.layoutTreeV2, current.editorGroups, current.activeEditorGroupId, rawResult);
        if (result.kind !== "changed") {
          return state;
        }
        const activeGroup = result.groups[result.activeGroupId];
        return {
          byInstanceId: {
            ...state.byInstanceId,
            [instanceId]: {
              ...current,
              layoutRevision: current.layoutRevision + 1,
              layoutTreeV2: result.tree,
              editorGroups: result.groups,
              activeEditorGroupId: result.activeGroupId,
              openOrder: activeGroup?.openOrder ?? current.openOrder,
              activeKey: activeGroup?.activeKey ?? current.activeKey,
            },
          },
        };
      });
    },

    setLeafActiveTab: (instanceId, leafId, fileKey) => {
      get().ensureInstance(instanceId);
      set((state) => {
        const current = state.byInstanceId[instanceId] ?? createDefaultCodeWorkspaceUi();
        const currentTree = current.layoutTreeV2;
        const rawResult = atomicSetLeafActiveTab(
          currentTree,
          current.editorGroups,
          current.activeEditorGroupId,
          leafId,
          fileKey,
        );
        const result = commitLayoutMutation(currentTree, current.editorGroups, current.activeEditorGroupId, rawResult);
        if (result.kind !== "changed") {
          return state;
        }
        const activeGroup = result.groups[result.activeGroupId];
        return {
          byInstanceId: {
            ...state.byInstanceId,
            [instanceId]: {
              ...current,
              layoutRevision: current.layoutRevision + 1,
              layoutTreeV2: result.tree,
              editorGroups: result.groups,
              activeEditorGroupId: result.activeGroupId,
              openOrder: activeGroup?.openOrder ?? current.openOrder,
              activeKey: activeGroup?.activeKey ?? current.activeKey,
            },
          },
        };
      });
    },

    closeLayoutTabInLeaf: (instanceId, leafId, fileKey, policy, lastUsedByKey) => {
      get().ensureInstance(instanceId);
      set((state) => {
        const current = state.byInstanceId[instanceId] ?? createDefaultCodeWorkspaceUi();
        const currentTree = current.layoutTreeV2;
        const rawResult = atomicCloseTabInLeaf(
          currentTree,
          current.editorGroups,
          current.activeEditorGroupId,
          leafId,
          fileKey,
          policy,
          lastUsedByKey,
        );
        const result = commitLayoutMutation(currentTree, current.editorGroups, current.activeEditorGroupId, rawResult);
        if (result.kind !== "changed") {
          return state;
        }
        const activeGroup = result.groups[result.activeGroupId];
        return {
          byInstanceId: {
            ...state.byInstanceId,
            [instanceId]: {
              ...current,
              layoutRevision: current.layoutRevision + 1,
              layoutTreeV2: result.tree,
              editorGroups: result.groups,
              activeEditorGroupId: result.activeGroupId,
              openOrder: activeGroup?.openOrder ?? current.openOrder,
              activeKey: activeGroup?.activeKey ?? current.activeKey,
            },
          },
        };
      });
    },

    setLayoutNodeRatios: (instanceId, splitId, ratios) => {
      get().ensureInstance(instanceId);
      set((state) => {
        const current = state.byInstanceId[instanceId] ?? createDefaultCodeWorkspaceUi();
        const nextTree = updateSplitNodeRatios(current.layoutTreeV2, splitId, ratios);
        if (nextTree === current.layoutTreeV2) return state;
        const validation = commitLayoutMutation(
          current.layoutTreeV2,
          current.editorGroups,
          current.activeEditorGroupId,
          {
            kind: "changed",
            tree: nextTree,
            groups: current.editorGroups,
            activeGroupId: current.activeEditorGroupId,
          },
        );
        if (validation.kind !== "changed") return state;
        return {
          byInstanceId: {
            ...state.byInstanceId,
            [instanceId]: {
              ...current,
              layoutRevision: current.layoutRevision + 1,
              layoutTreeV2: validation.tree,
            },
          },
        };
      });
    },

    equalizeLayoutRatios: (instanceId, leafId) => {
      get().ensureInstance(instanceId);
      set((state) => {
        const current = state.byInstanceId[instanceId] ?? createDefaultCodeWorkspaceUi();
        const nextTree = equalizeLeafParentSplit(current.layoutTreeV2, leafId);
        if (nextTree === current.layoutTreeV2) return state;
        const validation = commitLayoutMutation(
          current.layoutTreeV2,
          current.editorGroups,
          current.activeEditorGroupId,
          { kind: "changed", tree: nextTree, groups: current.editorGroups, activeGroupId: current.activeEditorGroupId },
        );
        if (validation.kind !== "changed") return state;
        return {
          byInstanceId: {
            ...state.byInstanceId,
            [instanceId]: {
              ...current,
              layoutRevision: current.layoutRevision + 1,
              layoutTreeV2: validation.tree,
            },
          },
        };
      });
    },

    stretchLayoutLeaf: (instanceId, leafId, options) => {
      get().ensureInstance(instanceId);
      set((state) => {
        const current = state.byInstanceId[instanceId] ?? createDefaultCodeWorkspaceUi();
        const nextTree = stretchLeafInTree(current.layoutTreeV2, leafId, options);
        if (nextTree === current.layoutTreeV2) return state;
        const validation = commitLayoutMutation(
          current.layoutTreeV2,
          current.editorGroups,
          current.activeEditorGroupId,
          { kind: "changed", tree: nextTree, groups: current.editorGroups, activeGroupId: current.activeEditorGroupId },
        );
        if (validation.kind !== "changed") return state;
        return {
          byInstanceId: {
            ...state.byInstanceId,
            [instanceId]: {
              ...current,
              layoutRevision: current.layoutRevision + 1,
              layoutTreeV2: validation.tree,
            },
          },
        };
      });
    },

    unsplitAllLayout: (instanceId) => {
      get().ensureInstance(instanceId);
      set((state) => {
        const current = state.byInstanceId[instanceId] ?? createDefaultCodeWorkspaceUi();
        const merged = unsplitAllLeaves(current.layoutTreeV2, current.activeEditorGroupId);
        if (!merged) return state;
        const survivorId = merged.tree.id;
        const openOrder = [...merged.mergedKeys];
        // Union pinned tabs from every absorbed leaf; drop anything not merged.
        const pinnedKeys: string[] = [];
        for (const leaf of getAllLeafNodes(current.layoutTreeV2)) {
          for (const key of current.editorGroups[leaf.id]?.pinnedKeys ?? []) {
            if (openOrder.includes(key) && !pinnedKeys.includes(key)) pinnedKeys.push(key);
          }
        }
        const previewCandidate = current.editorGroups[survivorId]?.previewKey ?? null;
        const previewKey =
          previewCandidate != null && openOrder.includes(previewCandidate)
            ? previewCandidate
            : null;

        const nextGroups: Record<string, CodeWorkspaceEditorGroupState> = {};
        // Dormant empty legacy slots carry no layout truth — keep them as-is.
        for (const [id, group] of Object.entries(current.editorGroups)) {
          if (group && id !== survivorId && group.openOrder.length === 0) nextGroups[id] = group;
        }
        nextGroups[survivorId] = {
          id: survivorId,
          openOrder,
          activeKey: merged.tree.activeKey,
          previewKey,
          pinnedKeys,
        };

        const rawResult: LayoutMutationResult = {
          kind: "changed",
          tree: merged.tree,
          groups: nextGroups,
          activeGroupId: survivorId,
        };
        const result = commitLayoutMutation(current.layoutTreeV2, current.editorGroups, current.activeEditorGroupId, rawResult);
        if (result.kind !== "changed") return state;
        const activeGroup = result.groups[result.activeGroupId];
        return {
          byInstanceId: {
            ...state.byInstanceId,
            [instanceId]: {
              ...current,
              layoutRevision: current.layoutRevision + 1,
              layoutTreeV2: result.tree,
              editorGroups: result.groups,
              activeEditorGroupId: result.activeGroupId,
              splitOrientation: result.tree.type === "split" ? result.tree.orientation : null,
              openOrder: activeGroup?.openOrder ?? current.openOrder,
              activeKey: activeGroup?.activeKey ?? null,
            },
          },
        };
      });
    }
  };
}
