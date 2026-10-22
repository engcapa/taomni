import { type LayoutNode, type LeafGroupNode } from "./types";
import { generateLayoutId } from "./identity";
import { findLeafNode, getAllLeafNodes } from "./tree";

/**
 * Update ratios of a split node and normalize them.
 */
export function updateSplitNodeRatios(
  node: LayoutNode,
  splitId: string,
  rawRatios: number[],
): LayoutNode {
  if (node.type === "leaf") return node;
  if (node.id === splitId) {
    if (rawRatios.length !== node.children.length) return node;
    if (rawRatios.some((ratio) => !Number.isFinite(ratio) || ratio <= 0)) return node;
    const sum = rawRatios.reduce((total, ratio) => total + ratio, 0);
    if (!Number.isFinite(sum) || sum <= 0) return node;
    const normalizedRatios = rawRatios.map((ratio) => ratio / sum);
    if (normalizedRatios.every((ratio, index) => ratio === node.ratios[index])) return node;
    return { ...node, ratios: normalizedRatios };
  }
  let changed = false;
  const children = node.children.map((child) => {
    const next = updateSplitNodeRatios(child, splitId, rawRatios);
    changed ||= next !== child;
    return next;
  });
  return changed ? { ...node, children } : node;
}

/**
 * Pure reducer: Split a leaf node and return a new immutable LayoutNode tree.
 * Atomically pre-validates target leaf existence.
 */
export function splitLeafNode(
  root: LayoutNode,
  leafId: string,
  orientation: "horizontal" | "vertical",
  newLeafId = generateLayoutId("leaf"),
  newFileKey?: string,
): LayoutNode {
  const target = findLeafNode(root, leafId);
  if (!target) {
    return root; // Atomic no-op
  }

  // Ensure unique new leaf id
  const existingIds = new Set(getAllLeafNodes(root).map((l) => l.id));
  const finalNewLeafId = existingIds.has(newLeafId) ? generateLayoutId("leaf") : newLeafId;

  const newLeaf: LeafGroupNode = {
    type: "leaf",
    id: finalNewLeafId,
    openFileKeys: newFileKey ? [newFileKey] : [],
    activeKey: newFileKey ?? null,
  };

  const updateRecursive = (node: LayoutNode): LayoutNode => {
    if (node.type === "leaf") {
      if (node.id === leafId) {
        return {
          type: "split",
          id: generateLayoutId("split"),
          orientation,
          children: [node, newLeaf],
          ratios: [0.5, 0.5],
        };
      }
      return node;
    }

    return {
      ...node,
      children: node.children.map(updateRecursive),
    };
  };

  return updateRecursive(root);
}

/**
 * Pure reducer: Close a leaf node and collapse parent split if only one child remains.
 * Atomically refuses to close the last remaining leaf in the tree.
 */
export function closeLeafNode(root: LayoutNode, leafId: string): LayoutNode {
  const totalLeaves = getAllLeafNodes(root).length;
  if (totalLeaves <= 1) {
    return root; // Atomic no-op: cannot close last leaf
  }

  const target = findLeafNode(root, leafId);
  if (!target) {
    return root; // Atomic no-op: target not found
  }

  const removeRecursive = (node: LayoutNode): LayoutNode | null => {
    if (node.type === "leaf") {
      return node.id === leafId ? null : node;
    }

    const newChildren = node.children
      .map(removeRecursive)
      .filter((c): c is LayoutNode => c !== null);

    if (newChildren.length === 0) return null;
    if (newChildren.length === 1) return newChildren[0];

    return {
      ...node,
      children: newChildren,
      ratios: newChildren.map(() => 1 / newChildren.length),
    };
  };

  return removeRecursive(root) ?? root;
}

/**
 * Pure reducer: Move a file key from one leaf to another.
 * Atomically validates that BOTH source and target leaves exist,
 * and that sourceLeaf contains the fileKey before performing the move.
 */
export function moveTabBetweenLeaves(
  root: LayoutNode,
  sourceLeafId: string,
  targetLeafId: string,
  fileKey: string,
): LayoutNode {
  if (sourceLeafId === targetLeafId) {
    return root; // No-op
  }

  const sourceLeaf = findLeafNode(root, sourceLeafId);
  const targetLeaf = findLeafNode(root, targetLeafId);

  // Atomic pre-validation: both must exist and source must own fileKey
  if (!sourceLeaf || !targetLeaf || !sourceLeaf.openFileKeys.includes(fileKey)) {
    return root;
  }

  const updateRecursive = (node: LayoutNode): LayoutNode => {
    if (node.type === "leaf") {
      if (node.id === sourceLeafId) {
        const filtered = node.openFileKeys.filter((k) => k !== fileKey);
        const activeKey = node.activeKey === fileKey ? (filtered[0] ?? null) : node.activeKey;
        return { ...node, openFileKeys: filtered, activeKey };
      }
      if (node.id === targetLeafId) {
        const keys = node.openFileKeys.includes(fileKey) ? node.openFileKeys : [...node.openFileKeys, fileKey];
        return { ...node, openFileKeys: keys, activeKey: fileKey };
      }
      return node;
    }
    return {
      ...node,
      children: node.children.map(updateRecursive),
    };
  };

  return updateRecursive(root);
}

/**
 * Pure reducer: Set the active tab in a leaf node.
 * Atomically validates that leaf exists and fileKey belongs to the leaf.
 */
export function setLeafActiveTab(root: LayoutNode, leafId: string, fileKey: string | null): LayoutNode {
  const leaf = findLeafNode(root, leafId);
  if (!leaf) {
    return root; // Atomic no-op
  }

  // Pre-validate: fileKey must belong to leaf (unless null)
  if (fileKey !== null && !leaf.openFileKeys.includes(fileKey)) {
    return root; // Atomic no-op
  }

  const updateRecursive = (node: LayoutNode): LayoutNode => {
    if (node.type === "leaf") {
      if (node.id === leafId) {
        return { ...node, activeKey: fileKey };
      }
      return node;
    }
    return { ...node, children: node.children.map(updateRecursive) };
  };
  return updateRecursive(root);
}

// ---------------------------------------------------------------------------
// §8.19.6 R5-b split management primitives: equalize / stretch / navigate /
// unsplit-all. All pure, atomic (unchanged reference on no-op), ratio-legal.
// ---------------------------------------------------------------------------

/**
 * Equalize the ratios of the split DIRECTLY containing `leafId` (§8.19.6:
 * equalize distributes evenly across same-layer children). Returns the same
 * tree reference when the leaf is missing or already equalized.
 */
export function equalizeLeafParentSplit(root: LayoutNode, leafId: string): LayoutNode {
  if (root.type === "leaf") return root;
  let changed = false;
  const walk = (node: LayoutNode): LayoutNode => {
    if (node.type === "leaf") return node;
    const children = node.children.map(walk);
    const childChanged = children.some((child, index) => child !== node.children[index]);
    const direct = node.children.some((child) => child.type === "leaf" && child.id === leafId);
    const equalRatios = node.children.map(() => 1 / node.children.length);
    const ratiosChanged = direct
      && !node.ratios.every((ratio, index) => ratio === equalRatios[index]);
    if (!childChanged && !ratiosChanged) return node;
    changed = true;
    return {
      ...node,
      children: childChanged ? children : node.children,
      ratios: ratiosChanged ? equalRatios : [...node.ratios],
    };
  };
  const next = walk(root);
  return changed ? next : root;
}

/**
 * Grow one leaf's share inside its parent split by `step`, shrinking siblings
 * proportionally so ratios stay normalized (§8.19.6: repeatable with an upper
 * bound). No-op once the leaf reaches `max` or siblings have no space left.
 */
export function stretchLeafInTree(
  root: LayoutNode,
  leafId: string,
  options: { step?: number; max?: number; } = {},
): LayoutNode {
  const rawStep = options.step ?? 0.1;
  const rawMax = options.max ?? 0.8;
  const step = Number.isFinite(rawStep) ? Math.min(Math.max(rawStep, 0.01), 0.5) : 0.1;
  const max = Number.isFinite(rawMax) ? Math.min(Math.max(rawMax, 0.05), 0.99) : 0.8;

  const apply = (node: LayoutNode): LayoutNode => {
    if (node.type === "leaf") return node;
    const directIndex = node.children.findIndex((child) => child.type === "leaf" && child.id === leafId);
    if (directIndex >= 0) {
      const current = node.ratios[directIndex] ?? 0;
      const target = Math.min(max, current + step);
      const grow = target - current;
      const otherTotal = node.ratios.reduce((sum, ratio, index) => (index === directIndex ? sum : sum + ratio), 0);
      if (grow <= 1e-9 || otherTotal <= grow + 1e-9) return node;
      const shrinkFactor = (otherTotal - grow) / otherTotal;
      const ratios = node.ratios.map((ratio, index) => (index === directIndex ? target : ratio * shrinkFactor));
      if (ratios.every((ratio, index) => ratio === node.ratios[index])) return node;
      return { ...node, ratios };
    }
    let changed = false;
    const children = node.children.map((child) => {
      const next = apply(child);
      changed ||= next !== child;
      return next;
    });
    return changed ? { ...node, children } : node;
  };
  return apply(root);
}

/**
 * Collapse the entire tree into its FIRST preorder leaf, migrating every
 * leaf's tabs into it with order-preserving dedup (§8.19.6 Unsplit All —
 * tabs migrate, never drop). The survivor keeps its id; the resulting active
 * tab comes from the globally active leaf when that tab survives the merge.
 * Returns null for single-leaf trees (already unsplit).
 */
export function unsplitAllLeaves(
  root: LayoutNode,
  activeLeafId: string | null,
): { tree: LeafGroupNode; mergedKeys: readonly string[]; } | null {
  const leaves = getAllLeafNodes(root);
  const survivor = leaves[0];
  if (!survivor || leaves.length <= 1) return null;

  const keys: string[] = [];
  for (const leaf of leaves) {
    for (const key of leaf.openFileKeys) {
      if (!keys.includes(key)) keys.push(key);
    }
  }
  const activeLeaf = activeLeafId != null ? leaves.find((leaf) => leaf.id === activeLeafId) : null;
  let activeKey = activeLeaf?.activeKey ?? survivor.activeKey;
  if (activeKey != null && !keys.includes(activeKey)) activeKey = null;

  return { tree: { type: "leaf", id: survivor.id, openFileKeys: keys, activeKey }, mergedKeys: keys };
}
