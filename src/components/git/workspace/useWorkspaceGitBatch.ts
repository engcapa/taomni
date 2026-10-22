import { useCallback } from "react";
import { alertAppDialog, confirmAppDialog, promptAppDialog } from "../../../lib/appDialogs";
import { gitCheckoutBranch, gitCreateBranch, gitFetch, gitPull, gitPush, selectedRemote, type GitSnapshot } from "../../../lib/git";
import { notifyGitRepoChanged } from "../../../lib/gitRefresh";
import type { GitWorkspaceRootInfo } from "../../../types";
import { errorMessage, pullBranchForRemote, type BatchResult } from "./model";
import { remoteOperationConfirmMessage } from "./operationConfirmations";
import { useWorkspaceGitRepositories } from "./useWorkspaceGitRepositories";

export interface UseWorkspaceGitBatchContext {
  repoRemoteNames: Record<string, string>;
  repositories: ReturnType<typeof useWorkspaceGitRepositories>;
  setBusyLabel: import("react").Dispatch<import("react").SetStateAction<string | null>>;
  setStatusMessage: (message: string) => void;
  setPanelVersion: import("react").Dispatch<import("react").SetStateAction<number>>;
}

export function useWorkspaceGitBatch(context: UseWorkspaceGitBatchContext) {
  const { repoRemoteNames, repositories, setBusyLabel, setStatusMessage, setPanelVersion } = context;

  const remoteNameForSnapshot = useCallback((snapshot: GitSnapshot | null): string => {
    if (!snapshot) return "";
    const stored = repoRemoteNames[snapshot.repoRoot];
    if (stored && snapshot.remotes.some((remote) => remote.name === stored)) return stored;
    return selectedRemote(snapshot)?.name || snapshot.remotes[0]?.name || "";
  }, [repoRemoteNames]);

  const runBatch = useCallback(async (
    label: string,
    action: (root: GitWorkspaceRootInfo, snapshot: GitSnapshot) => Promise<BatchResult>,
  ) => {
    if (repositories.operationRoots.length === 0) return;
    setBusyLabel(label);
    const failures: string[] = [];
    let completed = 0;
    let skipped = 0;
    try {
      for (const root of repositories.operationRoots) {
        try {
          const snapshot = await repositories.refreshRepo(root.repoRoot);
          const result = await action(root, snapshot);
          if (result === "completed") {
            completed += 1;
            await repositories.refreshRepo(root.repoRoot);
            notifyGitRepoChanged(root.repoRoot);
          } else {
            skipped += 1;
          }
        } catch (err) {
          failures.push(`${root.name}: ${errorMessage(err)}`);
        }
      }
      const summary = `${label}: ${completed} completed${skipped ? `, ${skipped} skipped` : ""}`;
      setStatusMessage(failures.length ? `${summary}, ${failures.length} failed` : summary);
      if (failures.length) {
        await alertAppDialog({
          title: label,
          message: failures.join("\n"),
        });
      }
    } finally {
      setPanelVersion((current) => current + 1);
      setBusyLabel(null);
    }
  }, [repositories.operationRoots, repositories.refreshRepo, setStatusMessage]);

  const batchFetch = useCallback(() => runBatch("Fetch", async (_root, snapshot) => {
    const remoteName = remoteNameForSnapshot(snapshot);
    if (!remoteName) return "skipped";
    await gitFetch(snapshot.repoRoot, remoteName);
    return "completed";
  }), [remoteNameForSnapshot, runBatch]);

  const batchPull = useCallback(() => runBatch("Pull", async (_root, snapshot) => {
    const remoteName = remoteNameForSnapshot(snapshot);
    if (!remoteName) return "skipped";
    await gitPull(snapshot.repoRoot, remoteName, pullBranchForRemote(snapshot, remoteName));
    return "completed";
  }), [remoteNameForSnapshot, runBatch]);

  const batchPush = useCallback(() => {
    void (async () => {
      const confirmed = await confirmAppDialog({
        title: "Confirm Push",
        message: remoteOperationConfirmMessage({
          action: "Push",
          roots: repositories.operationRoots,
          snapshots: repositories.snapshots,
          remoteNameForSnapshot,
        }),
        confirmLabel: "Push",
      });
      if (!confirmed) return;
      await runBatch("Push", async (_root, snapshot) => {
        const remoteName = remoteNameForSnapshot(snapshot);
        if (!remoteName || !snapshot.currentBranch) return "skipped";
        await gitPush(snapshot.repoRoot, remoteName, snapshot.currentBranch, !snapshot.upstream);
        return "completed";
      });
    })();
  }, [repositories.operationRoots, remoteNameForSnapshot, runBatch, repositories.snapshots]);

  const batchSync = useCallback(() => {
    void (async () => {
      const confirmed = await confirmAppDialog({
        title: "Confirm Sync",
        message: remoteOperationConfirmMessage({
          action: "Sync",
          roots: repositories.operationRoots,
          snapshots: repositories.snapshots,
          remoteNameForSnapshot,
        }),
        confirmLabel: "Sync",
      });
      if (!confirmed) return;
      await runBatch("Sync", async (_root, snapshot) => {
        const remoteName = remoteNameForSnapshot(snapshot);
        if (!remoteName || !snapshot.currentBranch) return "skipped";
        await gitPull(snapshot.repoRoot, remoteName, pullBranchForRemote(snapshot, remoteName));
        await gitPush(snapshot.repoRoot, remoteName, snapshot.currentBranch, !snapshot.upstream);
        return "completed";
      });
    })();
  }, [repositories.operationRoots, remoteNameForSnapshot, runBatch, repositories.snapshots]);

  const batchForcePush = useCallback(() => {
    if (repositories.operationRoots.length === 0) return;
    void confirmAppDialog({
      title: "Force push",
      message: `Force push ${repositories.operationRoots.length} repositor${repositories.operationRoots.length === 1 ? "y" : "ies"} using --force-with-lease?`,
      confirmLabel: "Force push",
      danger: true,
    }).then((confirmed) => {
      if (!confirmed) return;
      void runBatch("Force push", async (_root, snapshot) => {
        const remoteName = remoteNameForSnapshot(snapshot);
        if (!remoteName || !snapshot.currentBranch) return "skipped";
        await gitPush(snapshot.repoRoot, remoteName, snapshot.currentBranch, !snapshot.upstream, true);
        return "completed";
      });
    });
  }, [repositories.operationRoots.length, remoteNameForSnapshot, runBatch]);

  const batchCheckout = useCallback(() => {
    void (async () => {
      const branch = await promptAppDialog({
        title: "Checkout branch",
        label: `Checkout an existing branch in ${repositories.operationRoots.length} repositor${repositories.operationRoots.length === 1 ? "y" : "ies"}`,
        placeholder: "branch name",
        confirmLabel: "Checkout",
      });
      const target = branch?.trim();
      if (!target) return;
      await runBatch("Checkout", async (_root, snapshot) => {
        await gitCheckoutBranch(snapshot.repoRoot, target);
        return "completed";
      });
    })();
  }, [repositories.operationRoots.length, runBatch]);

  const batchCreateBranch = useCallback(() => {
    void (async () => {
      const branch = await promptAppDialog({
        title: "New branch",
        label: `Create and checkout a branch in ${repositories.operationRoots.length} repositor${repositories.operationRoots.length === 1 ? "y" : "ies"}`,
        placeholder: "branch name",
        confirmLabel: "Create",
      });
      const target = branch?.trim();
      if (!target) return;
      await runBatch("New branch", async (_root, snapshot) => {
        await gitCreateBranch(snapshot.repoRoot, target, null, true);
        return "completed";
      });
    })();
  }, [repositories.operationRoots.length, runBatch]);
  return {
    remoteNameForSnapshot,
    batchFetch,
    batchPull,
    batchPush,
    batchSync,
    batchCheckout,
    batchCreateBranch,
    batchForcePush,
  };
}
