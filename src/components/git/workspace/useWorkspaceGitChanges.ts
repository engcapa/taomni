import { useCallback } from "react";
import { alertAppDialog, confirmAppDialog } from "../../../lib/appDialogs";
import { normalizeWorktreeToMatchHead } from "../../../lib/diffWhitespace";
import { workspaceWriteFile } from "../../../lib/editor/workspace";
import { gitCleanUntracked, gitDiscard, gitStage, gitUnstage, type GitBlobPair, type GitSnapshot } from "../../../lib/git";
import { notifyGitRepoChanged } from "../../../lib/gitRefresh";
import type { GitWorkspaceRootInfo } from "../../../types";
import { workspacePathsByRepoFromKeys } from "../workspaceGitKeys";
import { errorMessage, type BatchResult } from "./model";
import { discardConfirmMessage } from "./operationConfirmations";
import { useWorkspaceGitRepositories } from "./useWorkspaceGitRepositories";

export interface UseWorkspaceGitChangesContext {
  setBusyLabel: import("react").Dispatch<import("react").SetStateAction<string | null>>;
  repositories: ReturnType<typeof useWorkspaceGitRepositories>;
  setStatusMessage: (message: string) => void;
  setPanelVersion: import("react").Dispatch<import("react").SetStateAction<number>>;
  selectedOperationKeys: string[];
  focusedOperationKeys: string[];
  allChanges: { key: string; repoRoot: string; repoName: string; change: import("../../../lib/git").GitChange; }[];
  focusedPairTarget: { key: string; repoRoot: string; path: string; oldPath: string | null; } | null;
  loadFocusedPair: (target: NonNullable<{ key: string; repoRoot: string; path: string; oldPath: string | null; } | null>) => Promise<GitBlobPair | null>;
  focusedChange: { key: string; repoRoot: string; repoName: string; change: import("../../../lib/git").GitChange; } | null;
  pair: GitBlobPair | null;
  onOpenWorkspace: ((repoRoot: string, path?: string | null) => void) | undefined;
}

export function useWorkspaceGitChanges(context: UseWorkspaceGitChangesContext) {
  const {
    setBusyLabel,
    repositories,
    setStatusMessage,
    setPanelVersion,
    selectedOperationKeys,
    focusedOperationKeys,
    allChanges,
    focusedPairTarget,
    loadFocusedPair,
    focusedChange,
    pair,
    onOpenWorkspace,
  } = context;

  const runChangeAction = useCallback(async (
    label: string,
    targets: GitWorkspaceRootInfo[],
    action: (root: GitWorkspaceRootInfo, snapshot: GitSnapshot) => Promise<BatchResult>,
  ) => {
    if (targets.length === 0) return;
    setBusyLabel(label);
    const failures: string[] = [];
    let completed = 0;
    let skipped = 0;
    try {
      for (const root of targets) {
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
  }, [repositories.refreshRepo, setStatusMessage]);

  const stageVisibleChanges = useCallback((pathsByRepo: Record<string, string[]>) => {
    const targets = repositories.scopedRoots.filter((root) => (pathsByRepo[root.repoRoot]?.length ?? 0) > 0);
    void runChangeAction("Stage visible changes", targets, async (root, snapshot) => {
      const visiblePaths = new Set(pathsByRepo[root.repoRoot] ?? []);
      const paths = snapshot.changes
        .filter((change) => visiblePaths.has(change.path))
        .map((change) => change.path);
      if (paths.length === 0) return "skipped";
      await gitStage(snapshot.repoRoot, paths);
      return "completed";
    });
  }, [runChangeAction, repositories.scopedRoots]);

  const unstageVisibleChanges = useCallback((pathsByRepo: Record<string, string[]>) => {
    const targets = repositories.scopedRoots.filter((root) => (pathsByRepo[root.repoRoot]?.length ?? 0) > 0);
    void runChangeAction("Unstage visible changes", targets, async (root, snapshot) => {
      const visiblePaths = new Set(pathsByRepo[root.repoRoot] ?? []);
      const paths = snapshot.changes
        .filter((change) => visiblePaths.has(change.path) && change.staged)
        .map((change) => change.path);
      if (paths.length === 0) return "skipped";
      await gitUnstage(snapshot.repoRoot, paths);
      return "completed";
    });
  }, [runChangeAction, repositories.scopedRoots]);

  const stagePathsInRepo = useCallback((repoRoot: string, paths: string[]) => {
    const root = repositories.normalizedRoots.find((entry) => entry.repoRoot === repoRoot);
    if (!root || paths.length === 0) return;
    void runChangeAction("Stage", [root], async () => {
      await gitStage(repoRoot, paths);
      return "completed";
    });
  }, [repositories.normalizedRoots, runChangeAction]);

  const unstagePathsInRepo = useCallback((repoRoot: string, paths: string[]) => {
    const root = repositories.normalizedRoots.find((entry) => entry.repoRoot === repoRoot);
    if (!root || paths.length === 0) return;
    void runChangeAction("Unstage", [root], async () => {
      await gitUnstage(repoRoot, paths);
      return "completed";
    });
  }, [repositories.normalizedRoots, runChangeAction]);

  const stageChangesByKeys = useCallback((keys: string[]) => {
    const pathsByRepo = workspacePathsByRepoFromKeys(keys);
    const targets = repositories.normalizedRoots.filter((root) => (pathsByRepo[root.repoRoot]?.length ?? 0) > 0);
    void runChangeAction("Stage", targets, async (root) => {
      const paths = pathsByRepo[root.repoRoot] ?? [];
      if (paths.length === 0) return "skipped";
      await gitStage(root.repoRoot, paths);
      return "completed";
    });
  }, [repositories.normalizedRoots, runChangeAction]);

  const unstageChangesByKeys = useCallback((keys: string[]) => {
    const pathsByRepo = workspacePathsByRepoFromKeys(keys);
    const targets = repositories.normalizedRoots.filter((root) => (pathsByRepo[root.repoRoot]?.length ?? 0) > 0);
    void runChangeAction("Unstage", targets, async (root) => {
      const paths = pathsByRepo[root.repoRoot] ?? [];
      if (paths.length === 0) return "skipped";
      await gitUnstage(root.repoRoot, paths);
      return "completed";
    });
  }, [repositories.normalizedRoots, runChangeAction]);

  const stageSelectedChanges = useCallback(() => {
    stageChangesByKeys(selectedOperationKeys);
  }, [selectedOperationKeys, stageChangesByKeys]);

  const unstageSelectedChanges = useCallback(() => {
    unstageChangesByKeys(selectedOperationKeys);
  }, [selectedOperationKeys, unstageChangesByKeys]);

  const stageFocusedChange = useCallback(() => {
    stageChangesByKeys(focusedOperationKeys);
  }, [focusedOperationKeys, stageChangesByKeys]);

  const unstageFocusedChange = useCallback(() => {
    unstageChangesByKeys(focusedOperationKeys);
  }, [focusedOperationKeys, unstageChangesByKeys]);

  const discardChangesByKeys = useCallback((keys: string[]) => {
    const entries = keys
      .map((key) => allChanges.find((entry) => entry.key === key))
      .filter((entry): entry is (typeof allChanges)[number] => !!entry);
    const pathsByRepo = workspacePathsByRepoFromKeys(keys);
    const targets = repositories.normalizedRoots.filter((root) => (pathsByRepo[root.repoRoot]?.length ?? 0) > 0);
    const count = Object.values(pathsByRepo).reduce((total, paths) => total + paths.length, 0);
    if (count === 0) return;
    void (async () => {
      const untrackedCount = entries.filter((entry) => entry.change.status === "untracked").length;
      const message = discardConfirmMessage(entries, count, untrackedCount);
      const confirmed = await confirmAppDialog({
        title: "Discard changes",
        message,
        confirmLabel: "Discard",
        danger: true,
      });
      if (!confirmed) return;
      await runChangeAction("Discard", targets, async (root, snapshot) => {
        const selectedPaths = new Set(pathsByRepo[root.repoRoot] ?? []);
        if (selectedPaths.size === 0) return "skipped";
        const untracked = snapshot.changes
          .filter((change) => selectedPaths.has(change.path) && change.status === "untracked")
          .map((change) => change.path);
        const tracked = snapshot.changes
          .filter((change) => selectedPaths.has(change.path) && change.status !== "untracked")
          .map((change) => change.path);
        if (tracked.length === 0 && untracked.length === 0) return "skipped";
        if (tracked.length > 0) await gitDiscard(root.repoRoot, tracked);
        if (untracked.length > 0) await gitCleanUntracked(root.repoRoot, untracked);
        return "completed";
      });
    })();
  }, [allChanges, repositories.normalizedRoots, runChangeAction]);

  const discardSelectedChanges = useCallback(() => {
    discardChangesByKeys(selectedOperationKeys);
  }, [discardChangesByKeys, selectedOperationKeys]);

  const discardFocusedChange = useCallback(() => {
    discardChangesByKeys(focusedOperationKeys);
  }, [discardChangesByKeys, focusedOperationKeys]);

  const reloadFocusedPair = useCallback(async () => {
    if (!focusedPairTarget) return null;
    return loadFocusedPair(focusedPairTarget);
  }, [focusedPairTarget, loadFocusedPair]);

  const normalizeFocusedLineEndings = useCallback(() => {
    if (!focusedChange || !pair) return;
    const nextText = normalizeWorktreeToMatchHead(pair.oldText, pair.newText);
    if (nextText == null) {
      setStatusMessage("No line-ending-only difference to normalize");
      return;
    }
    void (async () => {
      setBusyLabel("Normalize EOL");
      try {
        await workspaceWriteFile(focusedChange.repoRoot, focusedChange.change.path, nextText);
        notifyGitRepoChanged(focusedChange.repoRoot);
        await reloadFocusedPair();
        await repositories.refreshRepo(focusedChange.repoRoot);
        setStatusMessage(`Normalized line endings: ${focusedChange.change.path}`);
      } catch (err) {
        setStatusMessage(errorMessage(err));
      } finally {
        setBusyLabel(null);
      }
    })();
  }, [focusedChange, pair, repositories.refreshRepo, reloadFocusedPair, setStatusMessage]);

  const openFocusedInEditor = useCallback(() => {
    if (!focusedChange || !onOpenWorkspace) return;
    if (focusedChange.change.status === "deleted") {
      setStatusMessage("Deleted files cannot be opened in the editor");
      return;
    }
    onOpenWorkspace(focusedChange.repoRoot, focusedChange.change.path);
  }, [focusedChange, onOpenWorkspace, setStatusMessage]);

  const saveFocusedWorktree = useCallback(async (text: string) => {
    if (!focusedChange) return;
    await workspaceWriteFile(focusedChange.repoRoot, focusedChange.change.path, text);
    notifyGitRepoChanged(focusedChange.repoRoot);
    await reloadFocusedPair();
    await repositories.refreshRepo(focusedChange.repoRoot);
    setStatusMessage(`Saved ${focusedChange.change.path}`);
  }, [focusedChange, repositories.refreshRepo, reloadFocusedPair, setStatusMessage]);
  return {
    runChangeAction,
    stageVisibleChanges,
    unstageVisibleChanges,
    stagePathsInRepo,
    unstagePathsInRepo,
    stageFocusedChange,
    unstageFocusedChange,
    discardFocusedChange,
    normalizeFocusedLineEndings,
    openFocusedInEditor,
    saveFocusedWorktree,
    stageSelectedChanges,
    unstageSelectedChanges,
    discardSelectedChanges,
  };
}
