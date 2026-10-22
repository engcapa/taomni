import { type AnyWorkspaceTabPolicy, type TabEvictionMeta, type TabEvictionResult } from "./model";

/**
 * Evict candidates when `keys` exceeds `policy.limitPerLeaf`. Priority:
 * clean previews first, then least-recently used; dirty/pinned tabs are never
 * touched (§8.18.5).
 */
export function enforceTabPolicy(
  keys: readonly string[],
  meta: ReadonlyMap<string, TabEvictionMeta>,
  policy: AnyWorkspaceTabPolicy,
  options?: { allowDirty?: boolean; },
): TabEvictionResult {
  if (policy.limitPerLeaf <= 0 || keys.length <= policy.limitPerLeaf) {
    return { kind: "within-limit" };
  }
  const overflow = keys.length - policy.limitPerLeaf;
  const evictable = [...keys]
    .reverse()
    .map((key) => meta.get(key))
    .filter((entry): entry is TabEvictionMeta => !!entry)
    .filter((entry) => (options?.allowDirty ? !entry.pinned : !entry.dirty && !entry.pinned))
    .sort((left, right) => {
      if (left.preview !== right.preview) return left.preview ? -1 : 1;
      if (left.dirty !== right.dirty) return left.dirty ? 1 : -1;
      return left.lastUsedAt - right.lastUsedAt;
    })
    .slice(0, overflow)
    .map((entry) => entry.key);
  if (evictable.length === 0) {
    return {
      kind: "over-limit-protected",
      reason: `Tab limit (${policy.limitPerLeaf}) reached with no closable tab — all tabs are pinned or have unsaved changes`,
    };
  }
  return { kind: "evicted", evictedKeys: evictable };
}

/**
 * Display order for one leaf's tabs. MRU order stays untouched in storage —
 * alphabetical/display orders are projections only (§8.18.5).
 */
export function orderTabsForDisplay(
  keys: readonly string[],
  meta: ReadonlyMap<string, TabEvictionMeta>,
  policy: AnyWorkspaceTabPolicy,
): readonly string[] {
  if (policy.order === "open-order") return keys;
  const sorted = [...keys].sort((left, right) => {
    const leftMeta = meta.get(left);
    const rightMeta = meta.get(right);
    if (!leftMeta || !rightMeta) return 0;
    if (policy.pinnedRow === "separate") {
      if (leftMeta.pinned !== rightMeta.pinned) return leftMeta.pinned ? -1 : 1;
    }
    if (policy.order === "alphabetical") {
      return left.localeCompare(right);
    }
    // mru projection: most recent first.
    return rightMeta.lastUsedAt - leftMeta.lastUsedAt;
  });
  return sorted;
}

/**
 * Which neighbor becomes active after closing `closedKey` under the policy.
 * Returns null when the closed key was not active.
 */
export function selectActivateOnClose(
  keys: readonly string[],
  closedKey: string,
  activeKey: string | null,
  lastUsedByKey: ReadonlyMap<string, number>,
  policy: AnyWorkspaceTabPolicy,
): string | null {
  if (activeKey !== closedKey) return null;
  const index = keys.indexOf(closedKey);
  const remaining = keys.filter((key) => key !== closedKey);
  if (remaining.length === 0) return null;
  if (policy.activateOnClose === "left") {
    return remaining[Math.max(0, index - 1)] ?? remaining[0];
  }
  if (policy.activateOnClose === "right") {
    return remaining[Math.min(index, remaining.length - 1)];
  }
  // mru: most recently used among the survivors.
  let best: string | null = null;
  let bestUsedAt = -1;
  for (const key of remaining) {
    const usedAt = lastUsedByKey.get(key) ?? 0;
    if (usedAt > bestUsedAt) {
      bestUsedAt = usedAt;
      best = key;
    }
  }
  return best ?? remaining[0];
}
