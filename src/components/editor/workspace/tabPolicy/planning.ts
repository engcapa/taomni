import { setLeafTabs, type LayoutNode } from "../recursiveLayoutTree";
import { migrateWorkspaceTabPolicy } from "./migration";
import {
  DEFAULT_WORKSPACE_TAB_POLICY_V3,
  type ApplyWorkspaceTabPolicyExecution,
  type ApplyWorkspaceTabPolicyInput,
  type CreateTabPolicyPlanParams,
  type TabEvictionMeta,
  type TabPolicyGroupImage,
  type TabPolicyPlan,
  type WorkspaceTabPolicyV3,
} from "./model";
import { enforceTabPolicy } from "./ordering";

export function applyTabPolicyGroupImagesToLayout(
  layoutTree: LayoutNode,
  groups: Readonly<Record<string, Pick<TabPolicyGroupImage, "openOrder" | "activeKey">>>,
): LayoutNode {
  let nextTree = layoutTree;
  for (const [groupId, group] of Object.entries(groups)) {
    nextTree = setLeafTabs(nextTree, groupId, group.openOrder, group.activeKey);
  }
  return nextTree;
}

/**
 * §ED-TABS-002: Pure plan builder that freezes pre/post images, dirty candidates,
 * unreferenced eviction keys, and base layout revision into an immutable TabPolicyPlan.
 */
export function createTabPolicyPlan(params: CreateTabPolicyPlanParams): TabPolicyPlan {
  const currentPolicy = Object.freeze({
    ...(params.currentPolicy ?? DEFAULT_WORKSPACE_TAB_POLICY_V3),
  });
  const { policy } = migrateWorkspaceTabPolicy(params.nextPolicyRaw);
  const normalizedPolicy: WorkspaceTabPolicyV3 = Object.freeze({
    ...policy,
    limitPerLeaf: Math.max(1, Math.min(50, Math.round(policy.limitPerLeaf))),
  });

  const preGroups: Record<string, TabPolicyGroupImage> = {};
  for (const [gid, g] of Object.entries(params.currentGroups)) {
    preGroups[gid] = Object.freeze({
      id: gid,
      openOrder: Object.freeze([...g.openOrder]),
      pinnedKeys: Object.freeze([...g.pinnedKeys]),
      previewKey: g.previewKey,
      activeKey: g.activeKey,
    });
  }

  const evictionsByGroup: Record<string, string[]> = {};
  const allEvictedKeys: string[] = [];
  let protectedCount = 0;

  for (const [groupId, group] of Object.entries(params.currentGroups)) {
    const meta = new Map<string, TabEvictionMeta>(
      group.openOrder.map((k) => [
        k,
        {
          key: k,
          dirty: !!params.openFiles[k]?.dirty,
          pinned: group.pinnedKeys.includes(k),
          preview: group.previewKey === k,
          lastUsedAt: 1_000_000 - params.mruFileKeys.indexOf(k),
        },
      ]),
    );

    const eviction = enforceTabPolicy(group.openOrder, meta, normalizedPolicy, {
      allowDirty: params.allowDirtyCandidates,
    });
    if (eviction.kind === "evicted") {
      evictionsByGroup[groupId] = [...eviction.evictedKeys];
      allEvictedKeys.push(...eviction.evictedKeys);
    } else if (eviction.kind === "over-limit-protected") {
      protectedCount += group.openOrder.length;
    }
  }

  const postGroups: Record<string, TabPolicyGroupImage> = {};
  for (const [groupId, group] of Object.entries(params.currentGroups)) {
    const evicted = evictionsByGroup[groupId] ?? [];
    const remainingOpenOrder = group.openOrder.filter((k) => !evicted.includes(k));
    const nextActive = group.activeKey && evicted.includes(group.activeKey)
      ? remainingOpenOrder[remainingOpenOrder.length - 1] ?? null
      : group.activeKey;
    const nextPreview = group.previewKey && evicted.includes(group.previewKey)
      ? null
      : group.previewKey;

    postGroups[groupId] = Object.freeze({
      id: groupId,
      openOrder: Object.freeze(remainingOpenOrder),
      pinnedKeys: Object.freeze(group.pinnedKeys.filter((k) => !evicted.includes(k))),
      activeKey: nextActive,
      previewKey: nextPreview,
    });
  }

  const uniqueEvictedKeys = Object.freeze(Array.from(new Set(allEvictedKeys)));
  const dirtyEvictedKeys = Object.freeze(uniqueEvictedKeys.filter((k) => params.openFiles[k]?.dirty));
  const remainingKeysAcrossAllGroups = new Set(Object.values(postGroups).flatMap((g) => g.openOrder));
  const unreferencedEvictedKeys = Object.freeze(
    uniqueEvictedKeys.filter((k) => !remainingKeysAcrossAllGroups.has(k)),
  );

  const policyChanged = JSON.stringify(currentPolicy) !== JSON.stringify(normalizedPolicy);
  const isNoOp = uniqueEvictedKeys.length === 0 && !policyChanged;

  const message = uniqueEvictedKeys.length > 0
    ? `Saved editor tab policy (limit: ${normalizedPolicy.limitPerLeaf}, evicted ${uniqueEvictedKeys.length} tabs)`
    : `Saved editor tab policy (limit: ${normalizedPolicy.limitPerLeaf}, order: ${normalizedPolicy.order})`;

  return Object.freeze({
    workspaceInstanceId: params.workspaceInstanceId,
    planCreatedAt: Date.now(),
    baseLayoutRevision: params.baseLayoutRevision ?? 0,
    prePolicy: currentPolicy,
    postPolicy: normalizedPolicy,
    preGroups: Object.freeze(preGroups),
    postGroups: Object.freeze(postGroups),
    evictionsByGroup: Object.freeze(
      Object.fromEntries(Object.entries(evictionsByGroup).map(([k, v]) => [k, Object.freeze([...v])])),
    ),
    allEvictedKeys: uniqueEvictedKeys,
    dirtyEvictedKeys,
    unreferencedEvictedKeys,
    protectedCount,
    isNoOp,
    requiresConfirmation: dirtyEvictedKeys.length > 0,
    message,
  });
}

/**
 * §8.21.3 V2-B: Transactional helper that normalizes the policy draft,
 * evaluates eviction candidates per leaf group with dirty/pinned protection,
 * and compiles the resulting eviction schedule.
 */
export function computeWorkspaceTabPolicyApplication(
  input: ApplyWorkspaceTabPolicyInput,
): ApplyWorkspaceTabPolicyExecution {
  const plan = createTabPolicyPlan({
    workspaceInstanceId: "",
    nextPolicyRaw: input.rawPolicy,
    currentGroups: input.editorGroups,
    openFiles: input.openFiles,
    mruFileKeys: input.mruFileKeys,
    allowDirtyCandidates: input.allowDirtyCandidates,
  });

  return {
    policy: plan.postPolicy,
    evictionsByGroup: plan.evictionsByGroup,
    allEvictedKeys: plan.allEvictedKeys,
    protectedCount: plan.protectedCount,
    message: plan.message,
  };
}
