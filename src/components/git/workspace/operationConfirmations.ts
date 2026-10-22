import { selectedRemote,type GitSnapshot } from "../../../lib/git";
import { choiceAppDialog,confirmAppDialog } from "../../../lib/appDialogs";
import type { GitWorkspaceRootInfo } from "../../../types";
import { formatCommitBranchPlanLine,resolveCommitBranchPlan } from "../../../lib/workspaceGitCommitTarget";
import { type RepoSnapshotState,branchSummary,summarizePaths } from "./model";


export function discardConfirmMessage(
  entries: Array<{
    repoName: string;
    change: { path: string; status: string; };
  }>,
  count: number,
  untrackedCount: number,
): string {
  if(count===1) {
    const entry=entries[0];
    if(entry?.change.status==="untracked") {
      return `Delete untracked file ${entry.repoName}: ${entry.change.path}? This cannot be undone.`;
    }
    if(entry) return `Discard changes in ${entry.repoName}: ${entry.change.path}? This cannot be undone.`;
  }
  if(untrackedCount>0) {
    return `Discard changes in ${count} file(s)? ${untrackedCount} untracked file(s) will be deleted. This cannot be undone.`;
  }
  return `Discard changes in ${count} file(s)? This cannot be undone.`;
}


export type CommitDecision="commit"|"commit-and-push";


export async function confirmCommitOperation({
  message,
  push,
  targets,
  checkedChangePathsByRepo,
  snapshots,
  targetBranch,
}: {
  message: string;
  push: boolean;
  targets: GitWorkspaceRootInfo[];
  checkedChangePathsByRepo: Record<string,string[]>;
  snapshots: Record<string,RepoSnapshotState>;
  targetBranch: string;
}): Promise<CommitDecision|null> {
  const confirmMessage=commitOperationConfirmMessage({
    message,
    push,
    targets,
    checkedChangePathsByRepo,
    snapshots,
    targetBranch,
  });
  if(!push) {
    const confirmed=await confirmAppDialog({
      title: "Confirm Commit",
      message: confirmMessage,
      confirmLabel: "Commit",
    });
    return confirmed? "commit":null;
  }
  const choice=await choiceAppDialog({
    title: "Confirm Commit and Push",
    message: confirmMessage,
    primaryLabel: "Commit and Push",
    secondaryLabel: "Commit only",
  });
  if(choice==="primary") return "commit-and-push";
  if(choice==="secondary") return "commit";
  return null;
}


export function commitOperationConfirmMessage({
  message,
  push,
  targets,
  checkedChangePathsByRepo,
  snapshots,
  targetBranch,
}: {
  message: string;
  push: boolean;
  targets: GitWorkspaceRootInfo[];
  checkedChangePathsByRepo: Record<string,string[]>;
  snapshots: Record<string,RepoSnapshotState>;
  targetBranch: string;
}): string {
  const branchPlans=targets.map((root) => {
    const snapshot=snapshots[root.repoRoot]?.snapshot??null;
    const plan=resolveCommitBranchPlan(snapshot,targetBranch);
    return formatCommitBranchPlanLine(root.name,plan);
  });
  const lines=targets.map((root) => {
    const paths=checkedChangePathsByRepo[root.repoRoot]??[];
    const snapshot=snapshots[root.repoRoot]?.snapshot??null;
    const plan=resolveCommitBranchPlan(snapshot,targetBranch);
    const branch=plan.action==="stay"
      ? (snapshot? branchSummary(snapshot):"will refresh")
      :plan.targetBranch;
    const remote=snapshot? selectedRemote(snapshot):null;
    const pushSummary=push
      ? remote
        ? ` -> ${remote.name}/${plan.action==="stay"? (snapshot?.currentBranch??branch):plan.targetBranch}${plan.action==="stay"&&snapshot?.upstream? "":" (set upstream)"
        }`
        :" -> push skipped (missing remote or branch)"
      :"";
    return `- ${root.name}: ${paths.length} file(s) on ${branch}${pushSummary}${paths.length? `\n  ${summarizePaths(paths)}`:""}`;
  });
  return [
    `Message: ${message}`,
    "",
    "Branches:",
    ...branchPlans,
    "",
    "Repositories:",
    ...lines,
    "",
    push
      ? "Confirming will switch/create the target branch when needed, commit the checked files, then push each repository that has a remote."
      :"Confirming will switch/create the target branch when needed, then commit only the checked files listed above.",
  ].join("\n");
}


export function remoteOperationConfirmMessage({
  action,
  roots,
  snapshots,
  remoteNameForSnapshot,
}: {
  action: "Push"|"Sync";
  roots: GitWorkspaceRootInfo[];
  snapshots: Record<string,RepoSnapshotState>;
  remoteNameForSnapshot: (snapshot: GitSnapshot|null) => string;
}): string {
  const intro=action==="Sync"
    ? "Sync will pull, then push each repository below."
    :"Push will upload each repository's current branch.";
  const lines=roots.map((root) => {
    const snapshot=snapshots[root.repoRoot]?.snapshot??null;
    if(!snapshot) return `- ${root.name}: will refresh before ${action.toLowerCase()}`;
    const remoteName=remoteNameForSnapshot(snapshot);
    if(!remoteName) return `- ${root.name}: skipped (no remote)`;
    if(!snapshot.currentBranch) return `- ${root.name}: skipped (${branchSummary(snapshot)})`;
    return `- ${root.name}: ${snapshot.currentBranch} -> ${remoteName}/${snapshot.currentBranch}${snapshot.upstream? "":" (set upstream)"}`;
  });
  return [
    intro,
    "",
    "Repositories:",
    ...lines,
  ].join("\n");
}
