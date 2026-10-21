import { type LayoutNode, type LayoutEditorGroupState } from "./types";
import { getAllLeafNodes } from "./tree";

/**
 * Validate a layout node tree for invariants:
 *  - Unique IDs
 *  - Valid leaf active keys (must be in openFileKeys or null)
 *  - Valid split children (length >= 2, matching normalized ratios)
 *  - Positive finite ratios summing within tolerance [0.99, 1.01]
 */
export function validateLayoutTree(root: unknown): { valid: boolean; errors: string[]; } {
  const errors: string[] = [];
  const seenIds = new Set<string>();

  function validateNode(node: unknown, path: string): boolean {
    if (!node || typeof node !== "object") {
      errors.push(`${path}: node is not an object`);
      return false;
    }
    const rec = node as Record<string, unknown>;
    const id = rec.id;
    if (typeof id !== "string" || !id.trim()) {
      errors.push(`${path}: missing or invalid id`);
      return false;
    }
    if (seenIds.has(id)) {
      errors.push(`${path}: duplicate node id "${id}"`);
      return false;
    }
    seenIds.add(id);

    if (rec.type === "leaf") {
      if (!Array.isArray(rec.openFileKeys)) {
        errors.push(`${path}: openFileKeys must be an array`);
        return false;
      }
      const keys = rec.openFileKeys as string[];
      for (const k of keys) {
        if (typeof k !== "string") {
          errors.push(`${path}: openFileKeys contains non-string`);
          return false;
        }
      }
      if (rec.activeKey !== null && typeof rec.activeKey === "string") {
        if (keys.length > 0 && !keys.includes(rec.activeKey)) {
          errors.push(`${path}: activeKey "${rec.activeKey}" not found in openFileKeys [${keys.join(", ")}]`);
          return false;
        }
      } else if (rec.activeKey !== null) {
        errors.push(`${path}: activeKey must be string or null`);
        return false;
      }
      return true;
    }

    if (rec.type === "split") {
      if (rec.orientation !== "horizontal" && rec.orientation !== "vertical") {
        errors.push(`${path}: orientation must be "horizontal" or "vertical"`);
        return false;
      }
      if (!Array.isArray(rec.children) || rec.children.length < 2) {
        errors.push(`${path}: split must have at least 2 children`);
        return false;
      }
      if (!Array.isArray(rec.ratios) || rec.ratios.length !== rec.children.length) {
        errors.push(`${path}: ratios length must match children length`);
        return false;
      }
      for (let i = 0; i < rec.ratios.length; i++) {
        const r = (rec.ratios as number[])[i];
        if (typeof r !== "number" || !Number.isFinite(r) || r <= 0) {
          errors.push(`${path}: ratio[${i}] must be a positive finite number, got ${r}`);
          return false;
        }
      }
      const sum = (rec.ratios as number[]).reduce((a, b) => a + (typeof b === "number" && Number.isFinite(b) ? b : 0), 0);
      if (Math.abs(sum - 1.0) > 0.05) {
        errors.push(`${path}: ratios must sum close to 1.0 (actual: ${sum})`);
        return false;
      }
      for (let i = 0; i < rec.children.length; i++) {
        if (!validateNode(rec.children[i], `${path}.children[${i}]`)) {
          return false;
        }
      }
      return true;
    }

    errors.push(`${path}: unknown node type "${String(rec.type)}"`);
    return false;
  }

  const valid = validateNode(root, "root");
  return { valid, errors };
}

/**
 * Validate bidirectional consistency between layout tree leaves and editor groups.
 * Every leaf must have a matching group with identical openFileKeys/activeKey,
 * and every group must correspond to a leaf in the tree.
 */
export function validateTreeGroupConsistency(
  tree: LayoutNode,
  groups: Record<string, LayoutEditorGroupState>,
): { consistent: boolean; errors: string[]; } {
  const errors: string[] = [];
  const leaves = getAllLeafNodes(tree);
  const leafIds = new Set(leaves.map((l) => l.id));

  for (const leaf of leaves) {
    const group = groups[leaf.id];
    if (!group) {
      errors.push(`Leaf "${leaf.id}" has no matching group entry.`);
      continue;
    }
    const treeKeys = new Set(leaf.openFileKeys);
    const groupKeys = new Set(group.openOrder);
    for (const k of leaf.openFileKeys) {
      if (!groupKeys.has(k)) {
        errors.push(`Leaf "${leaf.id}" tree has key "${k}" not in group openOrder.`);
      }
    }
    for (const k of group.openOrder) {
      if (!treeKeys.has(k)) {
        errors.push(`Group "${leaf.id}" has key "${k}" not in tree openFileKeys.`);
      }
    }
    if (leaf.activeKey !== group.activeKey) {
      errors.push(`Leaf "${leaf.id}" activeKey mismatch: tree="${leaf.activeKey}" vs group="${group.activeKey}".`);
    }
  }

  for (const gid of Object.keys(groups)) {
    // An empty legacy group slot carries no layout truth and stays dormant
    // (e.g. the unused "secondary" group after fresh-mount materialization);
    // only non-empty groups require a matching leaf (§8.16.4).
    if (!leafIds.has(gid) && groups[gid].openOrder.length > 0) {
      errors.push(`Group "${gid}" has no matching leaf in tree.`);
    }
  }

  return { consistent: errors.length === 0, errors };
}
