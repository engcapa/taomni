import { type ApplyWorkspaceTabPolicyTransactionParams, type TabPolicyCommitReceipt } from "./model";
import { createTabPolicyPlan } from "./planning";

/**
 * §8.23.3 X2 / §ED-TABS-002: Top-level atomic tab policy plan/commit transaction.
 * 1. Creates frozen TabPolicyPlan capturing pre/post layouts, evictions, and base revision.
 * 2. Checks base vs current revision for stale abort (0 mutations).
 * 3. Confirms dirty candidate evictions asynchronously if needed; aborts on cancel (0 mutations).
 * 4. Re-verifies live layout revision after confirmation before committing.
 * 5. Commits atomically in one shot to store and returns typed TabPolicyCommitReceipt.
 */
export async function applyWorkspaceTabPolicyTransaction(
  params: ApplyWorkspaceTabPolicyTransactionParams,
): Promise<TabPolicyCommitReceipt> {
  const baseLayoutRevision = params.baseLayoutRevision ?? 0;
  const currentLayoutRevision = params.currentLayoutRevision ?? baseLayoutRevision;

  const plan = createTabPolicyPlan({
    workspaceInstanceId: params.workspaceInstanceId,
    nextPolicyRaw: params.nextPolicyRaw,
    currentPolicy: params.currentPolicy,
    baseLayoutRevision,
    currentGroups: params.currentGroups,
    openFiles: params.openFiles,
    mruFileKeys: params.mruFileKeys,
    allowDirtyCandidates: params.allowDirtyCandidates ?? Boolean(params.confirmDirtyClose),
  });

  // Stale check against baseline revision
  if (baseLayoutRevision !== currentLayoutRevision) {
    return {
      status: "stale",
      reason: "layout-revision-changed",
      plan,
      baseLayoutRevision,
      liveLayoutRevision: currentLayoutRevision,
      policy: plan.postPolicy,
      evictedKeysByGroup: {},
      allEvictedKeys: [],
      message: "Layout changed concurrently; tab policy application aborted",
    };
  }

  if (plan.isNoOp) {
    return {
      status: "no-op",
      plan,
      policy: plan.postPolicy,
      evictedKeysByGroup: {},
      allEvictedKeys: [],
      message: plan.message,
    };
  }

  if (plan.allEvictedKeys.length === 0) {
    // Policy changed without eviction
    const commitOutcome = params.commitAtomicUpdate({
      nextGroups: params.currentGroups,
      evictedKeys: [],
      policy: plan.postPolicy,
      plan,
    });
    return {
      status: "applied",
      plan,
      committedLayoutRevision: baseLayoutRevision + 1,
      policy: plan.postPolicy,
      evictedKeysByGroup: {},
      allEvictedKeys: [],
      message: "Tab policy updated successfully with 0 evictions",
      persisted: commitOutcome?.persisted ?? true,
      persistenceIssue: commitOutcome?.persistenceIssue ?? null,
    };
  }

  // Pre-check for dirty evicted keys across all groups
  if (plan.dirtyEvictedKeys.length > 0 && params.confirmDirtyClose) {
    const confirmed = await params.confirmDirtyClose(plan.dirtyEvictedKeys);
    if (!confirmed) {
      return {
        status: "aborted",
        reason: "user-cancelled",
        plan,
        policy: plan.postPolicy,
        evictedKeysByGroup: {},
        allEvictedKeys: [],
        message: "Tab policy application cancelled: dirty tabs preserved",
      };
    }

    // Re-verify layout revision after async confirmation prompt (§8.26.3 AA2 / §ED-TABS-002)
    const liveRevision = params.getLiveLayoutRevision ? params.getLiveLayoutRevision() : baseLayoutRevision;
    if (liveRevision !== baseLayoutRevision) {
      return {
        status: "stale",
        reason: "layout-revision-changed",
        plan,
        baseLayoutRevision,
        liveLayoutRevision: liveRevision,
        policy: plan.postPolicy,
        evictedKeysByGroup: {},
        allEvictedKeys: [],
        message: "Layout changed concurrently during confirmation; tab policy application aborted",
      };
    }
  }

  // Convert postGroups from TabPolicyPlan to commit payload
  const nextGroups: Record<string, {
    openOrder: readonly string[];
    pinnedKeys: readonly string[];
    previewKey: string | null;
    activeKey: string | null;
  }> = {};

  for (const [groupId, group] of Object.entries(plan.postGroups)) {
    nextGroups[groupId] = {
      openOrder: group.openOrder,
      pinnedKeys: group.pinnedKeys,
      activeKey: group.activeKey,
      previewKey: group.previewKey,
    };
  }

  // Single atomic store commit
  const commitOutcome = params.commitAtomicUpdate({
    nextGroups,
    evictedKeys: plan.allEvictedKeys,
    policy: plan.postPolicy,
    plan,
  });

  // Purge closed files via lifecycle only when unreferenced in post-commit nextGroups
  if (params.onEvictClosedFile) {
    for (const evictedKey of plan.unreferencedEvictedKeys) {
      try {
        await params.onEvictClosedFile(evictedKey);
      } catch {
        // preserve recovery log / handle gracefully
      }
    }
  }

  return {
    status: "applied",
    plan,
    committedLayoutRevision: baseLayoutRevision + 1,
    policy: plan.postPolicy,
    evictedKeysByGroup: plan.evictionsByGroup,
    allEvictedKeys: plan.allEvictedKeys,
    message: plan.message,
    persisted: commitOutcome?.persisted ?? true,
    persistenceIssue: commitOutcome?.persistenceIssue ?? null,
  };
}
