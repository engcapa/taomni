import { type LayoutNode, type LayoutEditorGroupState } from "./types";
import { validateLayoutTree } from "./validation";
import { extractAllFileKeys } from "./tree";

/**
 * Migrate legacy flat or binary layout schemas into LayoutNode tree v2,
 * with validation and fallback to a safe single leaf if corrupt.
 */
export function migrateLayoutV1toV2(legacyLayout: unknown): LayoutNode {
  if (!legacyLayout || typeof legacyLayout !== "object") {
    return {
      type: "leaf",
      id: "leaf-primary",
      openFileKeys: [],
      activeKey: null,
    };
  }

  const rec = legacyLayout as Record<string, unknown>;
  if (rec.type === "leaf" || rec.type === "split") {
    const { valid } = validateLayoutTree(legacyLayout);
    if (valid) {
      return legacyLayout as LayoutNode;
    }
    // If invalid/corrupt, safely recover into a single leaf with unique files
    const allFileKeys = extractAllFileKeys(legacyLayout);
    const uniqueKeys = Array.from(new Set(allFileKeys));
    return {
      type: "leaf",
      id: "leaf-primary",
      openFileKeys: uniqueKeys,
      activeKey: uniqueKeys[0] ?? null,
    };
  }

  // Legacy single split format
  if (typeof rec.orientation === "string" && Array.isArray(rec.groups)) {
    const orientation = rec.orientation === "vertical" ? "vertical" : "horizontal";
    const children: LayoutNode[] = (rec.groups as unknown[]).map((g, i) => {
      const grec = g && typeof g === "object" ? (g as Record<string, unknown>) : {};
      const keys = Array.isArray(grec.openFileKeys) ? (grec.openFileKeys.filter((k): k is string => typeof k === "string")) : [];
      const act = typeof grec.activeKey === "string" && keys.includes(grec.activeKey) ? grec.activeKey : (keys[0] ?? null);
      return {
        type: "leaf" as const,
        id: typeof grec.id === "string" && grec.id ? grec.id : `leaf-${i}`,
        openFileKeys: keys,
        activeKey: act,
      };
    });

    if (children.length === 1 && children[0]) return children[0];
    if (children.length >= 2) {
      return {
        type: "split",
        id: "split-root",
        orientation,
        children,
        ratios: children.map(() => 1 / children.length),
      };
    }
  }

  const openFileKeys = Array.isArray(rec.openFileKeys)
    ? rec.openFileKeys.filter((k): k is string => typeof k === "string")
    : [];
  const activeKey = typeof rec.activeKey === "string" && openFileKeys.includes(rec.activeKey)
    ? rec.activeKey
    : (openFileKeys[0] ?? null);

  return {
    type: "leaf",
    id: "leaf-primary",
    openFileKeys,
    activeKey,
  };
}

/**
 * Reconcile and remap file keys inside a LayoutNode tree when files are renamed or removed.
 */
export function remapLayoutTreeKeys(
  node: LayoutNode,
  keyChanges: Record<string, string | null>,
  validKeys: Set<string>,
  editorGroups: Record<string, LayoutEditorGroupState | undefined>,
): LayoutNode {
  if (node.type === "leaf") {
    const group = editorGroups[node.id];
    let nextKey = node.activeKey;
    if (nextKey && keyChanges[nextKey] !== undefined) {
      nextKey = keyChanges[nextKey];
    }
    if (nextKey && !validKeys.has(nextKey)) {
      nextKey = group?.activeKey ?? null;
    }
    const nextOpenFileKeys = node.openFileKeys
      .map((k) => (keyChanges[k] !== undefined ? keyChanges[k] : k))
      .filter((k): k is string => typeof k === "string" && validKeys.has(k));

    return {
      ...node,
      openFileKeys: nextOpenFileKeys,
      activeKey: nextKey,
    };
  }

  return {
    ...node,
    children: node.children.map((child) =>
      remapLayoutTreeKeys(child, keyChanges, validKeys, editorGroups),
    ),
  };
}
