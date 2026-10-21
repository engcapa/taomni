import { type LeafGroupNode, type LayoutNode } from "./types";

/**
 * Single canonical single-leaf tree factory (§8.16.4): fresh mounts, legacy
 * synthesis and persistence defaults all materialize through this helper so
 * leaf ids and shape stay consistent across every creation path.
 */
export function createSingleLeafLayout(
  leafId: string,
  openFileKeys: readonly string[],
  activeKey: string | null,
): LeafGroupNode {
  return {
    type: "leaf",
    id: leafId,
    openFileKeys: [...openFileKeys],
    activeKey,
  };
}

/**
 * Bidirectionally sync a leaf's tab list from its legacy group (§8.16.4):
 * every `updateEditorGroup` write mirrors openOrder/activeKey into the
 * recursive tree so preview replacement, close-others and WorkspaceEdit
 * restore cannot desynchronize leaf and group truth.
 * Returns the same tree reference when the leaf is missing or unchanged.
 */
export function setLeafTabs(
  root: LayoutNode,
  leafId: string,
  openFileKeys: readonly string[],
  activeKey: string | null,
): LayoutNode {
  const leaf = findLeafNode(root, leafId);
  if (!leaf) return root;
  const sameKeys = leaf.openFileKeys.length === openFileKeys.length
    && leaf.openFileKeys.every((key, index) => key === openFileKeys[index]);
  if (sameKeys && leaf.activeKey === activeKey) return root;
  return updateLeafInTree(root, leafId, (target) => ({
    ...target,
    openFileKeys: [...openFileKeys],
    activeKey,
  }));
}

export function cloneLayoutTree(node: LayoutNode): LayoutNode {
  if (node.type === "leaf") {
    return { ...node, openFileKeys: [...node.openFileKeys] };
  }
  return {
    ...node,
    ratios: [...node.ratios],
    children: node.children.map(cloneLayoutTree),
  };
}

/** Convert react-resizable-panels v4's keyed percentage map to normalized ratios. */
export function panelLayoutToRatios(
  layout: Readonly<Record<string, number>>,
  childIds: readonly string[],
): number[] | null {
  const values = childIds.map((id) => layout[`panel-${id}`]);
  if (values.length < 2 || values.some((value) => !Number.isFinite(value) || value <= 0)) {
    return null;
  }
  const sum = values.reduce((total, value) => total + value, 0);
  if (!Number.isFinite(sum) || sum <= 0) return null;
  return values.map((value) => value / sum);
}

/**
 * Extract all openFileKeys from any tree structure (even partially corrupt ones).
 */
export function extractAllFileKeys(node: unknown): string[] {
  const keys: string[] = [];
  function walk(n: unknown) {
    if (!n || typeof n !== "object") return;
    const rec = n as Record<string, unknown>;
    if (Array.isArray(rec.openFileKeys)) {
      for (const k of rec.openFileKeys) {
        if (typeof k === "string") keys.push(k);
      }
    }
    if (Array.isArray(rec.children)) {
      for (const child of rec.children) {
        walk(child);
      }
    }
    if (Array.isArray(rec.groups)) {
      for (const g of rec.groups) {
        walk(g);
      }
    }
  }
  walk(node);
  return keys;
}

/**
 * Get all leaf nodes in preorder.
 */
export function getAllLeafNodes(root: LayoutNode): LeafGroupNode[] {
  if (root.type === "leaf") return [root];
  return root.children.flatMap(getAllLeafNodes);
}

/**
 * Preorder next/previous leaf around `currentLeafId`, wrapping at the ends
 * (§8.19.6 go-to-next/previous-split navigation). Returns null for single-
 * leaf trees or unknown ids in one-leaf trees.
 */
export function navigateLeafOrder(
  tree: LayoutNode,
  currentLeafId: string,
  direction: 1 | -1,
): LeafGroupNode | null {
  const leaves = getAllLeafNodes(tree);
  if (leaves.length <= 1) return null;
  const index = leaves.findIndex((leaf) => leaf.id === currentLeafId);
  const base = index < 0 ? 0 : index;
  return leaves[(base + direction + leaves.length) % leaves.length] ?? null;
}

/**
 * Find a specific leaf node by ID.
 */
export function findLeafNode(root: LayoutNode, leafId: string): LeafGroupNode | null {
  if (root.type === "leaf") return root.id === leafId ? root : null;
  for (const child of root.children) {
    const found = findLeafNode(child, leafId);
    if (found) return found;
  }
  return null;
}

/**
 * Walk a layout tree and update a specific leaf node in-place (pure/immutable).
 */
export function updateLeafInTree(
  node: LayoutNode,
  leafId: string,
  updater: (leaf: LeafGroupNode) => LeafGroupNode,
): LayoutNode {
  if (node.type === "leaf") {
    return node.id === leafId ? updater(node) : node;
  }
  return {
    ...node,
    children: node.children.map((child) => updateLeafInTree(child, leafId, updater)),
  };
}

/**
 * Find the adjacent sibling leaf for a target leaf along the parent split (N6.5).
 * Priority: same-level index + 1, else index - 1.
 * If sibling is a split, returns the preorder first leaf in that split.
 */
export function findAdjacentSiblingLeaf(
  tree: LayoutNode,
  targetLeafId: string,
): LeafGroupNode | null {
  function search(node: LayoutNode): { sibling: LeafGroupNode | null; found: boolean; } {
    if (node.type === "leaf") {
      return { sibling: null, found: node.id === targetLeafId };
    }

    for (let i = 0; i < node.children.length; i++) {
      const child = node.children[i];
      if (child.type === "leaf" && child.id === targetLeafId) {
        const siblingIdx = i + 1 < node.children.length ? i + 1 : i - 1 >= 0 ? i - 1 : -1;
        if (siblingIdx >= 0) {
          const siblingChild = node.children[siblingIdx];
          const leaf = siblingChild.type === "leaf" ? siblingChild : getAllLeafNodes(siblingChild)[0] ?? null;
          return { sibling: leaf, found: true };
        }
        return { sibling: null, found: true };
      }

      if (child.type === "split") {
        const res = search(child);
        if (res.found) {
          if (res.sibling) return res;
          const siblingIdx = i + 1 < node.children.length ? i + 1 : i - 1 >= 0 ? i - 1 : -1;
          if (siblingIdx >= 0) {
            const siblingChild = node.children[siblingIdx];
            const leaf = siblingChild.type === "leaf" ? siblingChild : getAllLeafNodes(siblingChild)[0] ?? null;
            return { sibling: leaf, found: true };
          }
          return { sibling: null, found: true };
        }
      }
    }
    return { sibling: null, found: false };
  }

  const { sibling } = search(tree);
  if (sibling) return sibling;

  const allLeaves = getAllLeafNodes(tree).filter((l) => l.id !== targetLeafId);
  return allLeaves[0] ?? null;
}
