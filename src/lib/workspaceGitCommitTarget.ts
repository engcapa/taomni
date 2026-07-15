import type { GitSnapshot } from "./git";

export type CommitBranchAction = "stay" | "checkout" | "create";

export interface CommitBranchPlan {
  targetBranch: string;
  action: CommitBranchAction;
  currentBranch: string | null;
}

/**
 * Resolve how a single repo should move onto `rawTarget` before committing.
 * Empty target → stay on current branch.
 */
export function resolveCommitBranchPlan(
  snapshot: Pick<GitSnapshot, "currentBranch" | "branches" | "detached"> | null | undefined,
  rawTarget: string,
): CommitBranchPlan {
  const targetBranch = rawTarget.trim();
  const currentBranch = snapshot?.currentBranch ?? null;
  if (!targetBranch || (currentBranch && targetBranch === currentBranch)) {
    return {
      targetBranch: currentBranch ?? targetBranch,
      action: "stay",
      currentBranch,
    };
  }
  const localBranches = (snapshot?.branches ?? []).filter((branch) => !branch.remote);
  const exists = localBranches.some((branch) => branch.name === targetBranch)
    || (snapshot?.branches ?? []).some((branch) => branch.name === targetBranch && !branch.remote);
  if (exists) {
    return { targetBranch, action: "checkout", currentBranch };
  }
  return { targetBranch, action: "create", currentBranch };
}

export function formatCommitBranchPlanLine(
  repoName: string,
  plan: CommitBranchPlan,
): string {
  if (plan.action === "stay") {
    return `- ${repoName}: ${plan.currentBranch ?? "No branch"} (current)`;
  }
  if (plan.action === "checkout") {
    return `- ${repoName}: ${plan.currentBranch ?? "No branch"} → ${plan.targetBranch} (checkout)`;
  }
  return `- ${repoName}: ${plan.currentBranch ?? "No branch"} → ${plan.targetBranch} (create)`;
}

/** Unique local branch names across snapshots for the CommitBar datalist. */
export function collectLocalBranchNames(
  snapshots: Array<Pick<GitSnapshot, "branches" | "currentBranch"> | null | undefined>,
): string[] {
  const names = new Set<string>();
  for (const snapshot of snapshots) {
    if (!snapshot) continue;
    if (snapshot.currentBranch) names.add(snapshot.currentBranch);
    for (const branch of snapshot.branches ?? []) {
      if (!branch.remote) names.add(branch.name);
    }
  }
  return [...names].sort((a, b) => a.localeCompare(b));
}
