import { getAllLeafNodes, type LayoutNode, type LeafGroupNode } from "../recursiveLayoutTree";
import { type ClosedTabEntry, type ReopenLocationV2, type ReopenResolution } from "./model";

// ---------------------------------------------------------------------------
// Closed-tab reopen stack (§8.18.5, session-only, never persisted to disk)
// ---------------------------------------------------------------------------

export const CLOSED_TAB_STACK_LIMIT = 50;

/** Record the root→leaf child-index route as first/second steps. */
export function buildReopenTreeRoute(
  tree: LayoutNode,
  leafId: string,
): ReadonlyArray<"first" | "second"> {
  const route: Array<"first" | "second"> = [];
  let node: LayoutNode = tree;
  while (node.type === "split") {
    const index = node.children.findIndex((child) => containsLeaf(child, leafId));
    if (index < 0) break;
    route.push(index === 0 ? "first" : "second");
    node = node.children[Math.min(Math.max(index, 0), node.children.length - 1)];
  }
  return route;
}

export function containsLeaf(node: LayoutNode, leafId: string): boolean {
  if (node.type === "leaf") return node.id === leafId;
  return node.children.some((child) => containsLeaf(child, leafId));
}

/**
 * Resolve where a closed tab should reopen against the LIVE tree (§8.19.6
 * order): original leafId → nearest surviving ancestor along treeRoute →
 * leaf owning the most siblingFileKeys → active leaf. Always resolves to a
 * real leaf of a non-empty tree.
 */
export function resolveReopenLocation(
  tree: LayoutNode,
  location: ReopenLocationV2,
  activeLeafId: string | null,
): ReopenResolution {
  const leaves = getAllLeafNodes(tree);
  if (leaves.length === 0) {
    // Unreachable while §8.16.4 guarantees a materialized single-leaf tree.
    throw new Error("resolveReopenLocation requires a non-empty layout tree");
  }
  if (location.leafId != null) {
    const original = leaves.find((leaf) => leaf.id === location.leafId);
    if (original) return { kind: "restored", leafId: original.id };
  }

  // Nearest surviving ancestor along the recorded route — only counts as a
  // route match when we actually DESCENDED from the root; a fully-collapsed
  // tree carries no route signal and defers to sibling/active evidence.
  let node: LayoutNode = tree;
  let descended = false;
  for (const step of location.treeRoute) {
    if (node.type !== "split") break;
    const index = step === "first" ? 0 : Math.min(1, node.children.length - 1);
    const next = node.children[index];
    if (!next) break;
    node = next;
    descended = true;
  }
  if (descended) {
    const byRoute = node.type === "leaf"
      ? node
      : getAllLeafNodes(node)[0] ?? null;
    if (byRoute) return { kind: "relocated", leafId: byRoute.id, reason: "route" };
  }

  // Leaf currently owning the most sibling tabs.
  let best: LeafGroupNode | null = null;
  let bestCount = 0;
  for (const leaf of leaves) {
    const count = leaf.openFileKeys.filter((key) => location.siblingFileKeys.includes(key)).length;
    if (count > bestCount) {
      bestCount = count;
      best = leaf;
    }
  }
  if (best) return { kind: "relocated", leafId: best.id, reason: "sibling" };

  const fallback = leaves.find((leaf) => leaf.id === activeLeafId) ?? leaves[0];
  return { kind: "relocated", leafId: fallback!.id, reason: "active" };
}

/**
 * Push onto the reopen stack with the session cap. Returns the new stack so
 * callers stay pure.
 */
export function pushClosedTab(
  stack: readonly ClosedTabEntry[],
  entry: ClosedTabEntry,
): readonly ClosedTabEntry[] {
  const next = [entry, ...stack.filter((existing) => existing.fileIdentity !== entry.fileIdentity)];
  return next.slice(0, CLOSED_TAB_STACK_LIMIT);
}
