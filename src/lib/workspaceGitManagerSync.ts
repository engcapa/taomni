import type { GitWorkspaceRootInfo } from "../types";

/**
 * Pure helpers for keeping the workspace Git manager tab in sync with
 * Code Workspace roots (issue #324 B1).
 */

export type WorkspaceGitSyncDecision =
  | { kind: "noop" }
  | { kind: "close" }
  | {
      kind: "update";
      workspaceRoots: GitWorkspaceRootInfo[];
      activeRepoRoot: string;
    };

export function isMissingRepoPathError(message: string): boolean {
  const m = message.toLowerCase();
  if (m.includes("repository path no longer exists")) return true;
  if (m.includes("repository path is not a directory")) return true;
  if (m.includes("os error 267")) return true;
  if (m.includes("the directory name is invalid")) return true;
  if (m.includes("no such file or directory")) return true;
  if (m.includes("the system cannot find the path specified")) return true;
  if (m.includes("not a directory")) return true;
  // Windows spawn failure when current_dir is invalid
  if (m.includes("failed to start git") && (m.includes("267") || m.includes("cwd") || m.includes("directory"))) {
    return true;
  }
  return false;
}

export function resolveActiveRepoRoot(
  workspaceRoots: readonly GitWorkspaceRootInfo[],
  preferred: string | null | undefined,
  fallback: string | null | undefined,
): string | null {
  if (workspaceRoots.length === 0) return null;
  if (preferred && workspaceRoots.some((root) => root.repoRoot === preferred)) {
    return preferred;
  }
  if (fallback && workspaceRoots.some((root) => root.repoRoot === fallback)) {
    return fallback;
  }
  return workspaceRoots[0]?.repoRoot ?? null;
}

/**
 * Decide how a linked Git manager tab should react when the source workspace
 * reports a new root set. Empty roots → close the linked tab so we never keep
 * snapshotting deleted paths after the workspace drops them.
 */
export function decideWorkspaceGitSync(options: {
  hasLinkedTab: boolean;
  workspaceRoots: readonly GitWorkspaceRootInfo[];
  existingActiveRepoRoot?: string | null;
  payloadActiveRepoRoot?: string | null;
}): WorkspaceGitSyncDecision {
  if (!options.hasLinkedTab) return { kind: "noop" };
  if (options.workspaceRoots.length === 0) return { kind: "close" };
  const activeRepoRoot = resolveActiveRepoRoot(
    options.workspaceRoots,
    options.existingActiveRepoRoot,
    options.payloadActiveRepoRoot,
  );
  if (!activeRepoRoot) return { kind: "close" };
  return {
    kind: "update",
    workspaceRoots: [...options.workspaceRoots],
    activeRepoRoot,
  };
}

/** Drop roots that previously failed with a missing-path style error. */
export function filterSnapshotRoots(
  roots: readonly GitWorkspaceRootInfo[],
  deadRepoRoots: ReadonlySet<string>,
): GitWorkspaceRootInfo[] {
  return roots.filter((root) => !deadRepoRoots.has(root.repoRoot));
}

export function retainDeadRepoRoots(
  deadRepoRoots: ReadonlySet<string>,
  liveRoots: readonly GitWorkspaceRootInfo[],
): Set<string> {
  const live = new Set(liveRoots.map((root) => root.repoRoot));
  return new Set([...deadRepoRoots].filter((repoRoot) => live.has(repoRoot)));
}
