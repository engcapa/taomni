import { selectActivateOnClose, type AnyWorkspaceTabPolicy } from "../workspaceTabPolicy";
import { type LayoutNode, type LayoutEditorGroupState, type LayoutMutationResult } from "./types";
import { findLeafNode, getAllLeafNodes, findAdjacentSiblingLeaf, updateLeafInTree } from "./tree";
import { generateLayoutId } from "./identity";
import { splitLeafNode, closeLeafNode, moveTabBetweenLeaves, setLeafActiveTab } from "./mutations";
import { validateLayoutTree, validateTreeGroupConsistency } from "./validation";

/**
 * Atomic Split Leaf Mutation.
 * Returns { kind: "changed", tree, groups, activeGroupId } or { kind: "no-op" | "failed", reason }.
 */
export function atomicSplitLeaf(
  tree: LayoutNode,
  groups: Record<string, LayoutEditorGroupState>,
  _activeGroupId: string,
  leafId: string,
  orientation: "horizontal" | "vertical",
  newFileKey?: string,
  customNewLeafId?: string,
): LayoutMutationResult {
  const targetLeaf = findLeafNode(tree, leafId);
  if (!targetLeaf) {
    return { kind: "no-op", reason: `Target leaf "${leafId}" not found in layout tree.` };
  }

  const newLeafId = customNewLeafId ?? generateLayoutId("leaf");
  const newTree = splitLeafNode(tree, leafId, orientation, newLeafId, newFileKey);
  if (newTree === tree) {
    return { kind: "no-op", reason: "Tree split failed." };
  }

  const newGroup: LayoutEditorGroupState = {
    id: newLeafId,
    openOrder: newFileKey ? [newFileKey] : [],
    activeKey: newFileKey ?? null,
    previewKey: null,
    pinnedKeys: [],
  };

  return {
    kind: "changed",
    tree: newTree,
    groups: {
      ...groups,
      [newLeafId]: newGroup,
    },
    activeGroupId: newLeafId,
  };
}

/**
 * Validate and commit a layout mutation (N6.5).
 * Validates tree structure and bidirectional tree-group consistency.
 * If validation fails, logs diagnostic and returns failed result.
 */
export function commitLayoutMutation(
  _currentTree: LayoutNode,
  _currentGroups: Record<string, LayoutEditorGroupState>,
  _currentActiveGroupId: string,
  result: LayoutMutationResult,
): LayoutMutationResult {
  if (result.kind !== "changed") {
    return result;
  }

  const treeValidation = validateLayoutTree(result.tree);
  if (!treeValidation.valid) {
    const errorMsg = `Layout tree validation failed: ${treeValidation.errors.join(", ")}`;
    console.error(`[LayoutDiagnostics] ${errorMsg}`);
    return { kind: "failed", reason: errorMsg };
  }

  const consistency = validateTreeGroupConsistency(result.tree, result.groups);
  if (!consistency.consistent) {
    const errorMsg = `Tree/group consistency validation failed: ${consistency.errors.join("; ")}`;
    console.error(`[LayoutDiagnostics] ${errorMsg}`);
    return { kind: "failed", reason: errorMsg };
  }

  return result;
}

/**
 * Atomic Close Leaf Mutation (N6.5).
 * Refuses to close the last remaining leaf or non-existent leaf.
 * Migrates tabs to adjacent sibling leaf along the parent split.
 * Never drops tabs silently and keeps tree/group bidirectionally consistent.
 */
export function atomicCloseLeaf(
  tree: LayoutNode,
  groups: Record<string, LayoutEditorGroupState>,
  activeGroupId: string,
  leafId: string,
): LayoutMutationResult {
  const totalLeaves = getAllLeafNodes(tree);
  if (totalLeaves.length <= 1) {
    return { kind: "no-op", reason: "Cannot close the last remaining editor leaf." };
  }

  const targetLeaf = findLeafNode(tree, leafId);
  if (!targetLeaf) {
    return { kind: "no-op", reason: `Target leaf "${leafId}" not found in layout tree.` };
  }

  const siblingLeaf = findAdjacentSiblingLeaf(tree, leafId);
  const targetSiblingId = siblingLeaf?.id ?? getAllLeafNodes(tree).find((l) => l.id !== leafId)?.id;
  if (!targetSiblingId) {
    return { kind: "no-op", reason: "Cannot determine destination leaf for migration." };
  }

  const newTree = closeLeafNode(tree, leafId);
  if (newTree === tree) {
    return { kind: "no-op", reason: "Tree close leaf resulted in identical tree." };
  }

  const closedGroup = groups[leafId];
  const nextGroups = { ...groups };
  delete nextGroups[leafId];

  // If destination group does not exist in groups dictionary, create it from tree leaf
  if (!nextGroups[targetSiblingId]) {
    const destLeafNode = findLeafNode(newTree, targetSiblingId);
    nextGroups[targetSiblingId] = {
      id: targetSiblingId,
      openOrder: destLeafNode ? [...destLeafNode.openFileKeys] : [],
      activeKey: destLeafNode?.activeKey ?? null,
      previewKey: null,
      pinnedKeys: [],
    };
  }

  const migratedKeys: string[] = [];
  if (closedGroup && closedGroup.openOrder.length > 0 && nextGroups[targetSiblingId]) {
    const targetGroup = nextGroups[targetSiblingId];
    const combinedOrder = [...targetGroup.openOrder];
    for (const key of closedGroup.openOrder) {
      if (!combinedOrder.includes(key)) {
        combinedOrder.push(key);
        migratedKeys.push(key);
      }
    }
    nextGroups[targetSiblingId] = {
      ...targetGroup,
      openOrder: combinedOrder,
      activeKey: targetGroup.activeKey ?? closedGroup.activeKey ?? combinedOrder[0] ?? null,
    };
  }

  const destGroup = nextGroups[targetSiblingId];
  const syncedTree = destGroup
    ? updateLeafInTree(newTree, targetSiblingId, (leaf) => ({
      ...leaf,
      openFileKeys: destGroup.openOrder,
      activeKey: destGroup.activeKey,
    }))
    : newTree;

  const nextActiveId = activeGroupId === leafId ? targetSiblingId : activeGroupId;

  return {
    kind: "changed",
    tree: syncedTree,
    groups: nextGroups,
    activeGroupId: nextActiveId,
    migration: {
      destinationLeafId: targetSiblingId,
      migratedKeys,
    },
  };
}

/**
 * Atomic Move Tab Mutation.
 * Validates source and target existence and moves tab in both tree and editor groups atomically.
 */
export function atomicMoveTab(
  tree: LayoutNode,
  groups: Record<string, LayoutEditorGroupState>,
  _activeGroupId: string,
  sourceLeafId: string,
  targetLeafId: string,
  fileKey: string,
): LayoutMutationResult {
  if (sourceLeafId === targetLeafId) {
    return { kind: "no-op", reason: "Source and target leaf are identical." };
  }

  const sourceLeaf = findLeafNode(tree, sourceLeafId);
  const targetLeaf = findLeafNode(tree, targetLeafId);
  if (!sourceLeaf || !targetLeaf) {
    return { kind: "no-op", reason: "Source or target leaf not found in tree." };
  }

  const sourceGroup = groups[sourceLeafId];
  if (!sourceGroup || !sourceGroup.openOrder.includes(fileKey)) {
    return { kind: "no-op", reason: `File "${fileKey}" not found in source leaf "${sourceLeafId}".` };
  }

  const newTree = moveTabBetweenLeaves(tree, sourceLeafId, targetLeafId, fileKey);
  if (newTree === tree) {
    return { kind: "no-op", reason: "moveTabBetweenLeaves returned unchanged tree." };
  }

  const targetGroup = groups[targetLeafId] ?? {
    id: targetLeafId,
    openOrder: [],
    activeKey: null,
    previewKey: null,
    pinnedKeys: [],
  };

  const nextSourceOrder = sourceGroup.openOrder.filter((k) => k !== fileKey);
  const nextSourceActive = sourceGroup.activeKey === fileKey ? (nextSourceOrder[0] ?? null) : sourceGroup.activeKey;
  const nextTargetOrder = targetGroup.openOrder.includes(fileKey) ? targetGroup.openOrder : [...targetGroup.openOrder, fileKey];

  const nextGroups = {
    ...groups,
    [sourceLeafId]: {
      ...sourceGroup,
      openOrder: nextSourceOrder,
      activeKey: nextSourceActive,
      previewKey: sourceGroup.previewKey === fileKey ? null : sourceGroup.previewKey,
      pinnedKeys: sourceGroup.pinnedKeys.filter((k) => k !== fileKey),
    },
    [targetLeafId]: {
      ...targetGroup,
      openOrder: nextTargetOrder,
      activeKey: fileKey,
    },
  };

  return {
    kind: "changed",
    tree: newTree,
    groups: nextGroups,
    activeGroupId: targetLeafId,
  };
}

/**
 * Atomic Set Leaf Active Tab Mutation.
 */
export function atomicSetLeafActiveTab(
  tree: LayoutNode,
  groups: Record<string, LayoutEditorGroupState>,
  activeGroupId: string,
  leafId: string,
  fileKey: string | null,
): LayoutMutationResult {
  const leaf = findLeafNode(tree, leafId);
  if (!leaf) {
    return { kind: "no-op", reason: `Leaf "${leafId}" not found in tree.` };
  }

  const group = groups[leafId];
  if (fileKey !== null && group && !group.openOrder.includes(fileKey)) {
    return { kind: "no-op", reason: `File "${fileKey}" not in group "${leafId}".` };
  }

  if (group && group.activeKey === fileKey && activeGroupId === leafId) {
    return { kind: "no-op", reason: "Tab is already active." };
  }

  const newTree = setLeafActiveTab(tree, leafId, fileKey);
  const nextGroups = {
    ...groups,
    [leafId]: {
      ...(group ?? { id: leafId, openOrder: [], activeKey: null, previewKey: null, pinnedKeys: [] }),
      activeKey: fileKey,
    },
  };

  return {
    kind: "changed",
    tree: newTree,
    groups: nextGroups,
    activeGroupId: leafId,
  };
}

/**
 * Atomic Close Tab in Leaf Mutation.
 * Synchronizes leaf openFileKeys and group openOrder / activeKey together.
 */
export function atomicCloseTabInLeaf(
  tree: LayoutNode,
  groups: Record<string, LayoutEditorGroupState>,
  activeGroupId: string,
  leafId: string,
  fileKey: string,
  policy?: AnyWorkspaceTabPolicy,
  lastUsedByKey?: ReadonlyMap<string, number>,
): LayoutMutationResult {
  const leaf = findLeafNode(tree, leafId);
  const group = groups[leafId];
  if (!leaf || !group || !group.openOrder.includes(fileKey)) {
    return { kind: "no-op", reason: `File "${fileKey}" not found in leaf "${leafId}".` };
  }

  const nextOrder = group.openOrder.filter((k) => k !== fileKey);
  const nextActive = policy
    ? selectActivateOnClose(group.openOrder, fileKey, group.activeKey, lastUsedByKey ?? new Map(), policy)
    : group.activeKey === fileKey ? (nextOrder[0] ?? null) : group.activeKey;

  const updateRecursive = (node: LayoutNode): LayoutNode => {
    if (node.type === "leaf") {
      if (node.id === leafId) {
        return {
          ...node,
          openFileKeys: nextOrder,
          activeKey: nextActive,
        };
      }
      return node;
    }
    return {
      ...node,
      children: node.children.map(updateRecursive),
    };
  };

  const newTree = updateRecursive(tree);
  const nextGroups = {
    ...groups,
    [leafId]: {
      ...group,
      openOrder: nextOrder,
      activeKey: nextActive,
      previewKey: group.previewKey === fileKey ? null : group.previewKey,
      pinnedKeys: group.pinnedKeys.filter((k) => k !== fileKey),
    },
  };

  // Closing the last tab in the active leaf leaves that leaf mounted as an
  // empty split pane. Keep keyboard/action routing attached to a surviving
  // editor leaf instead of leaving the workspace active group without an
  // editor command port. This matters for native key delivery, where focusing
  // the survivor through WebDriver does not emit the pane's mouse activation.
  const nextActiveGroupId = activeGroupId === leafId && nextOrder.length === 0
    ? getAllLeafNodes(newTree)
      .map((candidate) => candidate.id)
      .find((candidateId) => (nextGroups[candidateId]?.openOrder.length ?? 0) > 0)
    ?? activeGroupId
    : activeGroupId;

  return {
    kind: "changed",
    tree: newTree,
    groups: nextGroups,
    activeGroupId: nextActiveGroupId,
  };
}
