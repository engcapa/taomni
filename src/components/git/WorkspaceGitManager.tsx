import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import {
  AlertTriangle,
  Braces,
  Check,
  ChevronDown,
  Circle,
  Download,
  Ellipsis,
  FolderGit2,
  GitBranch,
  GitCommitHorizontal,
  GitFork,
  GitMerge,
  Loader2,
  Plus,
  RefreshCcw,
  RefreshCw,
  Search,
  Upload,
} from "lucide-react";
import {
  GIT_REF_WORKTREE,
  gitBlobPair,
  gitCheckoutBranch,
  gitCleanUntracked,
  gitCommit,
  gitCreateBranch,
  gitDiscard,
  gitFetch,
  gitPull,
  gitPush,
  gitRepoName,
  gitSnapshot,
  gitStage,
  gitUnstage,
  selectedRemote,
  type GitBlobPair,
  type GitSnapshot,
} from "../../lib/git";
import { notifyGitRepoChanged, subscribeGitRepoRefresh } from "../../lib/gitRefresh";
import { alertAppDialog, choiceAppDialog, confirmAppDialog, promptAppDialog } from "../../lib/appDialogs";
import { useAppStore } from "../../stores/appStore";
import type { GitWorkspaceRootInfo } from "../../types";
import { ContextMenu, type MenuItem } from "../ContextMenu";
import { GitPanel } from "./GitPanel";
import { WorkspaceCommitLog } from "./WorkspaceCommitLog";
import { WorkspaceChangesView } from "./WorkspaceChangesView";
import {
  retainWorkspaceChangeKeys,
  workspaceChangeKey,
  workspacePathsByRepoFromKeys,
} from "./workspaceGitKeys";

interface WorkspaceGitManagerProps {
  workspaceName?: string | null;
  roots: GitWorkspaceRootInfo[];
  activeRepoRoot?: string | null;
  visible?: boolean;
  onOpenWorkspace?: (repoRoot: string) => void;
}

interface RepoSnapshotState {
  snapshot: GitSnapshot | null;
  loading: boolean;
  error: string | null;
}

type BatchResult = "completed" | "skipped";

type RepoScope =
  | { mode: "all" }
  | { mode: "single"; repoRoot: string }
  | { mode: "custom"; repoRoots: string[] };

export function WorkspaceGitManager({
  workspaceName,
  roots,
  activeRepoRoot,
  visible = true,
  onOpenWorkspace,
}: WorkspaceGitManagerProps) {
  const setStatusMessage = useAppStore((s) => s.setStatusMessage);
  const normalizedRoots = useMemo(() => dedupeRoots(roots), [roots]);
  const rootsKey = useMemo(() => workspaceRootsKey(normalizedRoots), [normalizedRoots]);
  const [selectedRepoRoot, setSelectedRepoRoot] = useState(activeRepoRoot ?? normalizedRoots[0]?.repoRoot ?? "");
  const [repoScope, setRepoScope] = useState<RepoScope>(() => (
    loadRepoScope(workspaceRootsKey(normalizedRoots), normalizedRoots)
      ?? initialRepoScope(normalizedRoots, activeRepoRoot)
  ));
  const [snapshots, setSnapshots] = useState<Record<string, RepoSnapshotState>>({});
  const [busyLabel, setBusyLabel] = useState<string | null>(null);
  const [panelVersion, setPanelVersion] = useState(0);
  const [commitMessage, setCommitMessage] = useState("");
  const [uncheckedChangeKeys, setUncheckedChangeKeys] = useState<Set<string>>(() => new Set());
  const [selectedChangeKeys, setSelectedChangeKeys] = useState<Set<string>>(() => new Set());
  const [focusedChangeKey, setFocusedChangeKey] = useState<string | null>(null);
  const [changeMenu, setChangeMenu] = useState<{ x: number; y: number } | null>(null);
  const [pair, setPair] = useState<GitBlobPair | null>(null);
  const [pairLoading, setPairLoading] = useState(false);
  const [repoRemoteNames, setRepoRemoteNames] = useState<Record<string, string>>({});
  const [headerMenu, setHeaderMenu] = useState<{ x: number; y: number } | null>(null);
  const [treeMode, setTreeMode] = useState(() => {
    try {
      return localStorage.getItem("taomni.git.workspace.changes.tree") === "tree";
    } catch {
      return false;
    }
  });
  const anchorChangeKeyRef = useRef<string | null>(null);

  const selectedRoot = useMemo(
    () => normalizedRoots.find((root) => root.repoRoot === selectedRepoRoot) ?? normalizedRoots[0] ?? null,
    [normalizedRoots, selectedRepoRoot],
  );
  const scopedRoots = useMemo(
    () => rootsForScope(normalizedRoots, repoScope),
    [normalizedRoots, repoScope],
  );
  const repoScopeIsAll = repoScope.mode === "all";
  const repoScopeIsMulti = repoScope.mode !== "single";
  const operationRoots = useMemo(
    () => scopedRoots,
    [scopedRoots],
  );
  const allChanges = useMemo(
    () => scopedRoots.flatMap((root) => (
      (snapshots[root.repoRoot]?.snapshot?.changes ?? []).map((change) => ({
        key: workspaceChangeKey(root.repoRoot, change.path),
        repoRoot: root.repoRoot,
        repoName: root.name,
        change,
      }))
    )),
    [scopedRoots, snapshots],
  );
  const allChangeKeys = useMemo(() => allChanges.map((entry) => entry.key), [allChanges]);
  const validChangeKeys = useMemo(() => new Set(allChangeKeys), [allChangeKeys]);
  const checkedChangeKeys = useMemo(
    () => new Set(allChanges.filter((entry) => !uncheckedChangeKeys.has(entry.key)).map((entry) => entry.key)),
    [allChanges, uncheckedChangeKeys],
  );
  const checkedChangePathsByRepo = useMemo(() => {
    const byRepo: Record<string, string[]> = {};
    for (const entry of allChanges) {
      if (!checkedChangeKeys.has(entry.key)) continue;
      (byRepo[entry.repoRoot] ??= []).push(entry.change.path);
    }
    return byRepo;
  }, [allChanges, checkedChangeKeys]);
  const checkedRepoCount = useMemo(
    () => Object.values(checkedChangePathsByRepo).filter((paths) => paths.length > 0).length,
    [checkedChangePathsByRepo],
  );
  const canPushCheckedChanges = useMemo(() => {
    const repoRoots = Object.entries(checkedChangePathsByRepo)
      .filter(([, paths]) => paths.length > 0)
      .map(([repoRoot]) => repoRoot);
    if (repoRoots.length === 0) return false;
    return repoRoots.every((repoRoot) => {
      const snapshot = snapshots[repoRoot]?.snapshot;
      return !!snapshot?.currentBranch && !!selectedRemote(snapshot);
    });
  }, [checkedChangePathsByRepo, snapshots]);
  const focusedChange = useMemo(
    () => allChanges.find((entry) => entry.key === focusedChangeKey) ?? null,
    [allChanges, focusedChangeKey],
  );
  const orderedChangeKeys = useMemo(
    () => [...allChanges]
      .sort((a, b) => {
        const repoCompare = a.repoName.localeCompare(b.repoName);
        return repoCompare || a.change.path.localeCompare(b.change.path);
      })
      .map((entry) => entry.key),
    [allChanges],
  );
  const selectedOperationKeys = useMemo(() => {
    const retainedSelected = [...selectedChangeKeys].filter((key) => validChangeKeys.has(key));
    if (retainedSelected.length > 0) return retainedSelected;
    return focusedChangeKey && validChangeKeys.has(focusedChangeKey) ? [focusedChangeKey] : [];
  }, [focusedChangeKey, selectedChangeKeys, validChangeKeys]);
  const selectedOperationEntries = useMemo(
    () => selectedOperationKeys
      .map((key) => allChanges.find((entry) => entry.key === key))
      .filter((entry): entry is (typeof allChanges)[number] => !!entry),
    [allChanges, selectedOperationKeys],
  );
  const focusedOperationKeys = useMemo(
    () => focusedChangeKey && validChangeKeys.has(focusedChangeKey) ? [focusedChangeKey] : [],
    [focusedChangeKey, validChangeKeys],
  );
  const totalChangedFiles = allChanges.length;
  const title = workspaceName?.trim() || "Code Workspace";
  const singleRepoMode = normalizedRoots.length === 1;

  useEffect(() => {
    try {
      localStorage.setItem("taomni.git.workspace.changes.tree", treeMode ? "tree" : "flat");
    } catch {
      /* ignore */
    }
  }, [treeMode]);

  useEffect(() => {
    setUncheckedChangeKeys((current) => retainWorkspaceChangeKeys(current, validChangeKeys));
    setSelectedChangeKeys((current) => retainWorkspaceChangeKeys(current, validChangeKeys));
    setFocusedChangeKey((current) => {
      if (current && validChangeKeys.has(current)) return current;
      return allChangeKeys[0] ?? null;
    });
    if (anchorChangeKeyRef.current && !validChangeKeys.has(anchorChangeKeyRef.current)) {
      anchorChangeKeyRef.current = null;
    }
  }, [allChangeKeys, validChangeKeys]);

  useEffect(() => {
    setSelectedRepoRoot((current) => {
      const validActiveRoots = scopedRoots.length > 0 ? scopedRoots : normalizedRoots;
      if (validActiveRoots.some((root) => root.repoRoot === current)) return current;
      if (activeRepoRoot && validActiveRoots.some((root) => root.repoRoot === activeRepoRoot)) {
        return activeRepoRoot;
      }
      return validActiveRoots[0]?.repoRoot ?? "";
    });
    setRepoScope((current) => {
      return normalizeRepoScope(current, normalizedRoots, activeRepoRoot);
    });
  }, [activeRepoRoot, normalizedRoots, scopedRoots]);

  useEffect(() => {
    saveRepoScope(rootsKey, repoScope, normalizedRoots);
  }, [normalizedRoots, repoScope, rootsKey]);

  const refreshRepo = useCallback(async (repoRoot: string) => {
    setSnapshots((current) => ({
      ...current,
      [repoRoot]: {
        snapshot: current[repoRoot]?.snapshot ?? null,
        loading: true,
        error: null,
      },
    }));
    try {
      const snapshot = await gitSnapshot(repoRoot);
      setSnapshots((current) => ({
        ...current,
        [repoRoot]: {
          snapshot,
          loading: false,
          error: null,
        },
      }));
      return snapshot;
    } catch (err) {
      const message = errorMessage(err);
      setSnapshots((current) => ({
        ...current,
        [repoRoot]: {
          snapshot: current[repoRoot]?.snapshot ?? null,
          loading: false,
          error: message,
        },
      }));
      throw err;
    }
  }, []);

  const refreshRepos = useCallback(async (targets = normalizedRoots) => {
    await Promise.allSettled(targets.map((root) => refreshRepo(root.repoRoot)));
  }, [normalizedRoots, refreshRepo]);

  useEffect(() => subscribeGitRepoRefresh((repoRoot) => {
    if (normalizedRoots.some((root) => root.repoRoot === repoRoot)) {
      void refreshRepo(repoRoot);
      setPanelVersion((current) => current + 1);
    }
  }), [normalizedRoots, refreshRepo]);

  useEffect(() => {
    if (!visible || normalizedRoots.length === 0 || singleRepoMode) return;
    void refreshRepos(normalizedRoots);
  }, [normalizedRoots, refreshRepos, singleRepoMode, visible]);

  useEffect(() => {
    let cancelled = false;
    async function loadPair() {
      if (!focusedChange) {
        setPair(null);
        return;
      }
      setPairLoading(true);
      try {
        const next = await gitBlobPair(
          focusedChange.repoRoot,
          focusedChange.change.path,
          "HEAD",
          GIT_REF_WORKTREE,
          focusedChange.change.oldPath,
        );
        if (!cancelled) setPair(next);
      } catch (err) {
        if (!cancelled) {
          setPair(null);
          setStatusMessage(errorMessage(err));
        }
      } finally {
        if (!cancelled) setPairLoading(false);
      }
    }
    void loadPair();
    return () => {
      cancelled = true;
    };
  }, [focusedChange, setStatusMessage]);

  const toggleChangeChecked = useCallback((repoRoot: string, paths: string[], checked: boolean) => {
    setUncheckedChangeKeys((current) => {
      const next = new Set(current);
      for (const path of paths) {
        const key = workspaceChangeKey(repoRoot, path);
        if (checked) next.delete(key);
        else next.add(key);
      }
      return next;
    });
  }, []);

  const selectWorkspaceChange = useCallback((repoRoot: string, path: string, mods: { ctrl: boolean; shift: boolean }) => {
    const key = workspaceChangeKey(repoRoot, path);
    setSelectedRepoRoot(repoRoot);
    setFocusedChangeKey(key);
    setSelectedChangeKeys((current) => {
      if (mods.ctrl) {
        const next = new Set(current);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        anchorChangeKeyRef.current = key;
        return next;
      }
      if (mods.shift && anchorChangeKeyRef.current) {
        const from = orderedChangeKeys.indexOf(anchorChangeKeyRef.current);
        const to = orderedChangeKeys.indexOf(key);
        if (from !== -1 && to !== -1) {
          const [lo, hi] = from <= to ? [from, to] : [to, from];
          return new Set(orderedChangeKeys.slice(lo, hi + 1));
        }
      }
      anchorChangeKeyRef.current = key;
      return new Set([key]);
    });
  }, [orderedChangeKeys]);

  const openWorkspaceChangeMenu = useCallback((
    repoRoot: string,
    path: string,
    event: ReactMouseEvent,
  ) => {
    event.preventDefault();
    selectWorkspaceChange(repoRoot, path, { ctrl: false, shift: false });
    setChangeMenu({ x: event.clientX, y: event.clientY });
  }, [selectWorkspaceChange]);

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
          const snapshot = await refreshRepo(root.repoRoot);
          const result = await action(root, snapshot);
          if (result === "completed") {
            completed += 1;
            await refreshRepo(root.repoRoot);
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
  }, [refreshRepo, setStatusMessage]);

  const stageVisibleChanges = useCallback((pathsByRepo: Record<string, string[]>) => {
    const targets = scopedRoots.filter((root) => (pathsByRepo[root.repoRoot]?.length ?? 0) > 0);
    void runChangeAction("Stage visible changes", targets, async (root, snapshot) => {
      const visiblePaths = new Set(pathsByRepo[root.repoRoot] ?? []);
      const paths = snapshot.changes
        .filter((change) => visiblePaths.has(change.path))
        .map((change) => change.path);
      if (paths.length === 0) return "skipped";
      await gitStage(snapshot.repoRoot, paths);
      return "completed";
    });
  }, [runChangeAction, scopedRoots]);

  const unstageVisibleChanges = useCallback((pathsByRepo: Record<string, string[]>) => {
    const targets = scopedRoots.filter((root) => (pathsByRepo[root.repoRoot]?.length ?? 0) > 0);
    void runChangeAction("Unstage visible changes", targets, async (root, snapshot) => {
      const visiblePaths = new Set(pathsByRepo[root.repoRoot] ?? []);
      const paths = snapshot.changes
        .filter((change) => visiblePaths.has(change.path) && change.staged)
        .map((change) => change.path);
      if (paths.length === 0) return "skipped";
      await gitUnstage(snapshot.repoRoot, paths);
      return "completed";
    });
  }, [runChangeAction, scopedRoots]);

  const stagePathsInRepo = useCallback((repoRoot: string, paths: string[]) => {
    const root = normalizedRoots.find((entry) => entry.repoRoot === repoRoot);
    if (!root || paths.length === 0) return;
    void runChangeAction("Stage", [root], async () => {
      await gitStage(repoRoot, paths);
      return "completed";
    });
  }, [normalizedRoots, runChangeAction]);

  const unstagePathsInRepo = useCallback((repoRoot: string, paths: string[]) => {
    const root = normalizedRoots.find((entry) => entry.repoRoot === repoRoot);
    if (!root || paths.length === 0) return;
    void runChangeAction("Unstage", [root], async () => {
      await gitUnstage(repoRoot, paths);
      return "completed";
    });
  }, [normalizedRoots, runChangeAction]);

  const stageChangesByKeys = useCallback((keys: string[]) => {
    const pathsByRepo = workspacePathsByRepoFromKeys(keys);
    const targets = normalizedRoots.filter((root) => (pathsByRepo[root.repoRoot]?.length ?? 0) > 0);
    void runChangeAction("Stage", targets, async (root) => {
      const paths = pathsByRepo[root.repoRoot] ?? [];
      if (paths.length === 0) return "skipped";
      await gitStage(root.repoRoot, paths);
      return "completed";
    });
  }, [normalizedRoots, runChangeAction]);

  const unstageChangesByKeys = useCallback((keys: string[]) => {
    const pathsByRepo = workspacePathsByRepoFromKeys(keys);
    const targets = normalizedRoots.filter((root) => (pathsByRepo[root.repoRoot]?.length ?? 0) > 0);
    void runChangeAction("Unstage", targets, async (root) => {
      const paths = pathsByRepo[root.repoRoot] ?? [];
      if (paths.length === 0) return "skipped";
      await gitUnstage(root.repoRoot, paths);
      return "completed";
    });
  }, [normalizedRoots, runChangeAction]);

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
    const targets = normalizedRoots.filter((root) => (pathsByRepo[root.repoRoot]?.length ?? 0) > 0);
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
  }, [allChanges, normalizedRoots, runChangeAction]);

  const discardSelectedChanges = useCallback(() => {
    discardChangesByKeys(selectedOperationKeys);
  }, [discardChangesByKeys, selectedOperationKeys]);

  const discardFocusedChange = useCallback(() => {
    discardChangesByKeys(focusedOperationKeys);
  }, [discardChangesByKeys, focusedOperationKeys]);

  const commitWorkspaceChanges = useCallback((push: boolean) => {
    const message = commitMessage.trim();
    if (!message || checkedChangeKeys.size === 0) return;
    const targets = normalizedRoots.filter((root) => (checkedChangePathsByRepo[root.repoRoot]?.length ?? 0) > 0);
    void (async () => {
      const decision = await confirmCommitOperation({
        message,
        push,
        targets,
        checkedChangePathsByRepo,
        snapshots,
      });
      if (!decision) return;
      await runChangeAction(decision === "commit-and-push" ? "Commit and Push" : "Commit", targets, async (_root, snapshot) => {
        const selectedPaths = new Set(checkedChangePathsByRepo[snapshot.repoRoot] ?? []);
        const paths = snapshot.changes
          .filter((change) => selectedPaths.has(change.path))
          .map((change) => change.path);
        if (paths.length === 0) return "skipped";
        await gitCommit(snapshot.repoRoot, message, false, paths);
        if (decision === "commit-and-push") {
          const remote = selectedRemote(snapshot);
          if (remote && snapshot.currentBranch) {
            await gitPush(snapshot.repoRoot, remote.name, snapshot.currentBranch, !snapshot.upstream);
          }
        }
        return "completed";
      });
      setCommitMessage("");
    })();
  }, [
    checkedChangeKeys.size,
    checkedChangePathsByRepo,
    commitMessage,
    normalizedRoots,
    runChangeAction,
    snapshots,
  ]);

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
    if (operationRoots.length === 0) return;
    setBusyLabel(label);
    const failures: string[] = [];
    let completed = 0;
    let skipped = 0;
    try {
      for (const root of operationRoots) {
        try {
          const snapshot = await refreshRepo(root.repoRoot);
          const result = await action(root, snapshot);
          if (result === "completed") {
            completed += 1;
            await refreshRepo(root.repoRoot);
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
  }, [operationRoots, refreshRepo, setStatusMessage]);

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
          roots: operationRoots,
          snapshots,
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
  }, [operationRoots, remoteNameForSnapshot, runBatch, snapshots]);

  const batchSync = useCallback(() => {
    void (async () => {
      const confirmed = await confirmAppDialog({
        title: "Confirm Sync",
        message: remoteOperationConfirmMessage({
          action: "Sync",
          roots: operationRoots,
          snapshots,
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
  }, [operationRoots, remoteNameForSnapshot, runBatch, snapshots]);

  const batchForcePush = useCallback(() => {
    if (operationRoots.length === 0) return;
    void confirmAppDialog({
      title: "Force push",
      message: `Force push ${operationRoots.length} repositor${operationRoots.length === 1 ? "y" : "ies"} using --force-with-lease?`,
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
  }, [operationRoots.length, remoteNameForSnapshot, runBatch]);

  const batchCheckout = useCallback(() => {
    void (async () => {
      const branch = await promptAppDialog({
        title: "Checkout branch",
        label: `Checkout an existing branch in ${operationRoots.length} repositor${operationRoots.length === 1 ? "y" : "ies"}`,
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
  }, [operationRoots.length, runBatch]);

  const batchCreateBranch = useCallback(() => {
    void (async () => {
      const branch = await promptAppDialog({
        title: "New branch",
        label: `Create and checkout a branch in ${operationRoots.length} repositor${operationRoots.length === 1 ? "y" : "ies"}`,
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
  }, [operationRoots.length, runBatch]);

  const aggregate = useMemo(() => {
    let ahead = 0;
    let behind = 0;
    for (const root of scopedRoots) {
      const snapshot = snapshots[root.repoRoot]?.snapshot;
      if (!snapshot) continue;
      ahead += snapshot.ahead;
      behind += snapshot.behind;
    }
    return { ahead, behind };
  }, [scopedRoots, snapshots]);

  const busy = busyLabel !== null;
  const refreshOperationRoots = useCallback(async () => {
    if (operationRoots.length === 0) return;
    setBusyLabel("Refresh");
    try {
      await refreshRepos(operationRoots);
      setStatusMessage(`Refresh: ${operationRoots.length} completed`);
    } finally {
      setPanelVersion((current) => current + 1);
      setBusyLabel(null);
    }
  }, [operationRoots, refreshRepos, setStatusMessage]);

  const currentSnapshot = selectedRoot ? snapshots[selectedRoot.repoRoot]?.snapshot ?? null : null;
  const currentRemoteName = repoScopeIsMulti ? "" : remoteNameForSnapshot(currentSnapshot);
  const operationDisabled = busy || operationRoots.length === 0;
  const scopeRepoCount = scopedRoots.length;
  const scopeSummary = `${scopeRepoCount} repositor${scopeRepoCount === 1 ? "y" : "ies"} · ${totalChangedFiles} changed files`;

  if (singleRepoMode && selectedRoot) {
    return (
      <GitPanel
        repoRoot={selectedRoot.repoRoot}
        visible={visible}
        onOpenWorkspace={onOpenWorkspace}
      />
    );
  }

  return (
    <div
      data-testid="workspace-git-manager"
      className="h-full w-full min-h-0 flex bg-[var(--taomni-bg)] text-[var(--taomni-text)]"
    >
      <main className="flex-1 min-w-0 min-h-0">
        {selectedRoot ? (
          <GitPanel
            repoRoot={selectedRoot.repoRoot}
            visible={visible}
            onOpenWorkspace={onOpenWorkspace}
            changeCountOverride={totalChangedFiles}
            refreshToken={panelVersion}
            workspaceHeader={{
              title,
              summary: scopeSummary,
              selectedRepoName: selectedRoot.name,
              selectedRepoRoot: selectedRoot.repoRoot,
              repoSelector: (
                <RepoSelector
                  roots={normalizedRoots}
                  snapshots={snapshots}
                  scope={repoScope}
                  selectedRoot={selectedRoot}
                  scopedRoots={scopedRoots}
                  onScopeChange={(next) => {
                    setRepoScope(next);
                    if (next.mode === "single") setSelectedRepoRoot(next.repoRoot);
                    if (next.mode === "custom" && !next.repoRoots.includes(selectedRepoRoot)) {
                      setSelectedRepoRoot(next.repoRoots[0] ?? "");
                    }
                  }}
                />
              ),
              branchBadge: repoScopeIsMulti ? (
                <span className="inline-flex items-center gap-1 h-6 px-2 rounded bg-[var(--taomni-hover)] text-[12px]">
                  <GitCommitHorizontal className="w-3.5 h-3.5" />
                  {repoScopeIsAll ? "All Repositories" : `${scopeRepoCount} Repositories`}
                </span>
              ) : undefined,
              changeSummary: (
                <span className="text-[11px] text-[var(--taomni-text-muted)]">
                  {totalChangedFiles} changes
                  {aggregate.ahead || aggregate.behind ? ` · ↑${aggregate.ahead} ↓${aggregate.behind}` : ""}
                </span>
              ),
              actionControls: (
                <>
                  <select
                    className="taomni-input h-7 w-32"
                    value={repoScopeIsMulti ? "__default__" : currentRemoteName}
                    onChange={(event) => {
                      if (!selectedRoot) return;
                      setRepoRemoteNames((current) => ({
                        ...current,
                        [selectedRoot.repoRoot]: event.target.value,
                      }));
                    }}
                    disabled={repoScopeIsMulti || !currentSnapshot?.remotes.length}
                    title={repoScopeIsMulti ? "Multiple repositories use their default remotes" : undefined}
                  >
                    {repoScopeIsMulti ? (
                      <option value="__default__">Default remotes</option>
                    ) : currentSnapshot?.remotes.length ? currentSnapshot.remotes.map((remote) => (
                      <option key={remote.name} value={remote.name}>{remote.name}</option>
                    )) : (
                      <option value="">No remote</option>
                    )}
                  </select>
                  <ToolbarButton
                    label="Fetch"
                    icon={<Download className="w-3.5 h-3.5" />}
                    disabled={operationDisabled}
                    onClick={() => void batchFetch()}
                  />
                  <ToolbarButton
                    label="Pull"
                    icon={<GitMerge className="w-3.5 h-3.5" />}
                    disabled={operationDisabled}
                    onClick={() => void batchPull()}
                  />
                  <ToolbarButton
                    label="Push"
                    icon={<Upload className="w-3.5 h-3.5" />}
                    disabled={operationDisabled}
                    onClick={() => void batchPush()}
                  />
                  <button
                    type="button"
                    className="taomni-btn h-7 w-7 inline-flex items-center justify-center"
                    title="More Git actions"
                    aria-label="More Git actions"
                    disabled={operationDisabled}
                    onClick={(event) => setHeaderMenu({ x: event.clientX, y: event.clientY })}
                  >
                    <Ellipsis className="w-3.5 h-3.5 text-[var(--taomni-text)]" />
                  </button>
                  <ToolbarButton
                    label="Refresh"
                    icon={<RefreshCw className={`w-3.5 h-3.5 ${busyLabel === "Refresh" ? "animate-spin" : ""}`} />}
                    disabled={operationDisabled}
                    onClick={() => void refreshOperationRoots()}
                  />
                </>
              ),
            }}
            workspaceLogView={(
              <WorkspaceCommitLog
                roots={scopedRoots}
                snapshots={snapshots}
                busy={busy}
              />
            )}
            workspaceBranchesView={repoScopeIsMulti ? (
              <WorkspaceBranchesView
                roots={scopedRoots}
                snapshots={snapshots}
              />
            ) : undefined}
            workspaceTagsView={repoScopeIsMulti ? (
              <WorkspaceTagsView
                roots={scopedRoots}
                snapshots={snapshots}
              />
            ) : undefined}
            workspaceSettingsAggregateView={scopedRoots.length > 1 ? ((showCurrent) => (
              <WorkspaceSettingsAggregateView
                roots={scopedRoots}
                snapshots={snapshots}
                onSelectRepo={(repoRoot) => {
                  setSelectedRepoRoot(repoRoot);
                  showCurrent();
                }}
              />
            )) : undefined}
            changesView={(
              <WorkspaceChangesView
                roots={scopedRoots}
                snapshots={snapshots}
                busy={busy}
                treeMode={treeMode}
                setTreeMode={setTreeMode}
                checkedKeys={checkedChangeKeys}
                checkedCount={checkedChangeKeys.size}
                checkedRepoCount={checkedRepoCount}
                selectedKeys={selectedChangeKeys}
                focusedKey={focusedChangeKey}
                pair={pair}
                pairLoading={pairLoading}
                commitMessage={commitMessage}
                setCommitMessage={setCommitMessage}
                canCommitAndPush={canPushCheckedChanges}
                scopeSummary={scopeSummary}
                stageVisible={stageVisibleChanges}
                unstageVisible={unstageVisibleChanges}
                stagePaths={stagePathsInRepo}
                unstagePaths={unstagePathsInRepo}
                stageSelected={stageFocusedChange}
                unstageSelected={unstageFocusedChange}
                discardSelected={discardFocusedChange}
                commit={() => commitWorkspaceChanges(false)}
                commitAndPush={() => commitWorkspaceChanges(true)}
                onToggleChecked={toggleChangeChecked}
                onSelect={selectWorkspaceChange}
                onContextMenu={openWorkspaceChangeMenu}
              />
            )}
          />
        ) : (
          <EmptyState title="No Git repositories detected" />
        )}
      </main>
      {headerMenu && (
        <ContextMenu
          x={headerMenu.x}
          y={headerMenu.y}
          onClose={() => setHeaderMenu(null)}
          items={[
            {
              label: "Sync",
              icon: <RefreshCcw className="w-3.5 h-3.5" />,
              disabled: operationDisabled,
              onClick: () => void batchSync(),
            },
            {
              label: "Checkout branch...",
              icon: <GitFork className="w-3.5 h-3.5" />,
              disabled: operationDisabled,
              onClick: () => batchCheckout(),
            },
            {
              label: "New branch...",
              icon: <Plus className="w-3.5 h-3.5" />,
              disabled: operationDisabled,
              onClick: () => batchCreateBranch(),
            },
            {
              label: "Open code workspace",
              icon: <Braces className="w-3.5 h-3.5" />,
              disabled: !onOpenWorkspace,
              onClick: () => {
                if (selectedRoot) onOpenWorkspace?.(selectedRoot.repoRoot);
              },
            },
            { label: "", separator: true },
            {
              label: "Force push with lease...",
              icon: <Upload className="w-3.5 h-3.5" />,
              disabled: operationDisabled,
              danger: true,
              onClick: batchForcePush,
            },
          ]}
        />
      )}
      {changeMenu && (
        <ContextMenu
          x={changeMenu.x}
          y={changeMenu.y}
          onClose={() => setChangeMenu(null)}
          items={workspaceChangeMenuItems({
            entries: selectedOperationEntries,
            onStage: stageSelectedChanges,
            onUnstage: unstageSelectedChanges,
            onDiscard: discardSelectedChanges,
          })}
        />
      )}
    </div>
  );
}

function WorkspaceBranchesView({
  roots,
  snapshots,
}: {
  roots: GitWorkspaceRootInfo[];
  snapshots: Record<string, RepoSnapshotState>;
}) {
  const [query, setQuery] = useState("");
  const normalizedQuery = query.trim().toLowerCase();
  const rows = useMemo(() => (
    roots.flatMap((root) => (
      (snapshots[root.repoRoot]?.snapshot?.branches ?? [])
        .filter((branch) => workspaceBranchMatchesQuery(root, branch, normalizedQuery))
        .map((branch) => ({ root, branch }))
    ))
  ), [normalizedQuery, roots, snapshots]);
  const total = roots.reduce((count, root) => (
    count + (snapshots[root.repoRoot]?.snapshot?.branches.length ?? 0)
  ), 0);

  return (
    <div className="h-full min-h-0 flex flex-col">
      <div className="h-9 shrink-0 flex items-center gap-2 px-2 border-b border-[var(--taomni-divider)]">
        <div className="relative w-64 max-w-full min-w-44">
          <Search className="w-3.5 h-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-[var(--taomni-text-muted)]" />
          <input
            className="taomni-input h-7 w-full pl-7"
            placeholder="Search branches"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <span className="text-[11px] text-[var(--taomni-text-muted)]">
          {roots.length} repositories
        </span>
      </div>
      <div className="flex-1 min-h-0 overflow-auto">
        {total === 0 ? (
          <EmptyState title="No branches" />
        ) : rows.length === 0 ? (
          <EmptyState title="No branches match" />
        ) : rows.map(({ root, branch }) => (
          <div
            key={`${root.repoRoot}:${branch.fullName}`}
            className="w-full px-3 py-2 flex items-center gap-2 border-b border-[var(--taomni-divider)]"
            title={`${root.repoRoot} · ${branch.fullName}`}
          >
            <GitFork className={`w-4 h-4 shrink-0 ${branch.current ? "text-[var(--taomni-accent)]" : "text-[var(--taomni-text-muted)]"}`} />
            <span className="shrink-0 rounded border border-[var(--taomni-divider)] bg-[var(--taomni-quick-bg)] px-1 text-[10px] text-[var(--taomni-text-muted)]">
              {root.name}
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-[12px] truncate">{branch.name}</div>
              <div className="text-[11px] text-[var(--taomni-text-muted)] truncate">
                {branch.upstream ? `tracks ${branch.upstream}` : branch.remote ? "remote" : "local"}
                {branch.subject ? ` · ${branch.subject}` : ""}
              </div>
            </div>
            {branch.current && <span className="text-[11px] text-[var(--taomni-accent)]">current</span>}
          </div>
        ))}
      </div>
    </div>
  );
}

function WorkspaceTagsView({
  roots,
  snapshots,
}: {
  roots: GitWorkspaceRootInfo[];
  snapshots: Record<string, RepoSnapshotState>;
}) {
  const [query, setQuery] = useState("");
  const normalizedQuery = query.trim().toLowerCase();
  const rows = useMemo(() => (
    roots.flatMap((root) => (
      (snapshots[root.repoRoot]?.snapshot?.tags ?? [])
        .filter((tag) => workspaceTagMatchesQuery(root, tag, normalizedQuery))
        .map((tag) => ({ root, tag }))
    ))
  ), [normalizedQuery, roots, snapshots]);
  const total = roots.reduce((count, root) => (
    count + (snapshots[root.repoRoot]?.snapshot?.tags.length ?? 0)
  ), 0);

  return (
    <div className="h-full min-h-0 flex flex-col">
      <div className="h-9 shrink-0 flex items-center gap-2 px-2 border-b border-[var(--taomni-divider)]">
        <div className="relative w-64 max-w-full min-w-44">
          <Search className="w-3.5 h-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-[var(--taomni-text-muted)]" />
          <input
            className="taomni-input h-7 w-full pl-7"
            placeholder="Search tags"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <span className="text-[11px] text-[var(--taomni-text-muted)]">
          {roots.length} repositories
        </span>
      </div>
      <div className="flex-1 min-h-0 overflow-auto">
        {total === 0 ? (
          <EmptyState title="No tags" />
        ) : rows.length === 0 ? (
          <EmptyState title="No tags match" />
        ) : rows.map(({ root, tag }) => (
          <div
            key={`${root.repoRoot}:${tag.name}`}
            className="w-full px-3 py-2 flex items-center gap-2 border-b border-[var(--taomni-divider)]"
            title={`${root.repoRoot} · ${tag.name}`}
          >
            <GitCommitHorizontal className="w-4 h-4 shrink-0 text-[var(--taomni-text-muted)]" />
            <span className="shrink-0 rounded border border-[var(--taomni-divider)] bg-[var(--taomni-quick-bg)] px-1 text-[10px] text-[var(--taomni-text-muted)]">
              {root.name}
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-[12px] truncate">{tag.name}</div>
              <div className="text-[11px] text-[var(--taomni-text-muted)] truncate">
                <span className="taomni-mono text-[var(--taomni-accent)]">{tag.oid}</span>
                {tag.annotated ? " · annotated" : " · lightweight"}{tag.subject ? ` · ${tag.subject}` : ""}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

const WORKSPACE_SETTING_FIELDS: Array<{ key: keyof GitSnapshot["settings"]; label: string }> = [
  { key: "userName", label: "user.name" },
  { key: "userEmail", label: "user.email" },
  { key: "httpProxy", label: "http.proxy" },
  { key: "httpsProxy", label: "https.proxy" },
  { key: "pullRebase", label: "pull.rebase" },
  { key: "pushDefault", label: "push.default" },
  { key: "coreAutocrlf", label: "core.autocrlf" },
  { key: "coreFilemode", label: "core.filemode" },
  { key: "commitGpgsign", label: "commit.gpgsign" },
];

function WorkspaceSettingsAggregateView({
  roots,
  snapshots,
  onSelectRepo,
}: {
  roots: GitWorkspaceRootInfo[];
  snapshots: Record<string, RepoSnapshotState>;
  onSelectRepo: (repoRoot: string) => void;
}) {
  const [query, setQuery] = useState("");
  const normalizedQuery = query.trim().toLowerCase();
  const rows = roots.filter((root) => {
    if (!normalizedQuery) return true;
    const snapshot = snapshots[root.repoRoot]?.snapshot ?? null;
    const haystack = [
      root.name,
      root.repoRoot,
      ...WORKSPACE_SETTING_FIELDS.map((field) => snapshot?.settings[field.key] ?? ""),
      ...(snapshot?.remotes ?? []).flatMap((remote) => [
        remote.name,
        remote.fetchUrl,
        remote.pushUrl ?? "",
        remote.username ?? "",
        remote.tokenRef ? "token stored" : "no token",
      ]),
    ].join("\n").toLowerCase();
    return haystack.includes(normalizedQuery);
  });

  return (
    <div className="h-full min-h-0 flex flex-col">
      <div className="h-9 shrink-0 flex items-center gap-2 px-2 border-b border-[var(--taomni-divider)]">
        <div className="relative w-72 max-w-full min-w-44">
          <Search className="w-3.5 h-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-[var(--taomni-text-muted)]" />
          <input
            className="taomni-input h-7 w-full pl-7"
            placeholder="Search settings"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <span className="text-[11px] text-[var(--taomni-text-muted)]">
          {rows.length}/{roots.length} repositories
        </span>
      </div>
      <div className="flex-1 min-h-0 overflow-auto">
        {rows.length === 0 ? (
          <EmptyState title="No repositories match" />
        ) : (
          <table className="min-w-[1120px] w-full border-collapse text-[12px]">
            <thead className="sticky top-0 z-10 bg-[var(--taomni-quick-bg)]">
              <tr className="border-b border-[var(--taomni-divider)] text-left">
                <th className="w-52 px-3 py-2 font-medium">Repository</th>
                {WORKSPACE_SETTING_FIELDS.map((field) => (
                  <th key={field.key} className="px-2 py-2 font-medium">{field.label}</th>
                ))}
                <th className="w-72 px-2 py-2 font-medium">Remotes</th>
                <th className="w-20 px-2 py-2 font-medium" />
              </tr>
            </thead>
            <tbody>
              {rows.map((root) => {
                const state = snapshots[root.repoRoot];
                const snapshot = state?.snapshot ?? null;
                return (
                  <tr key={root.repoRoot} className="border-b border-[var(--taomni-divider)] hover:bg-[var(--taomni-hover)]">
                    <td className="px-3 py-2 align-top">
                      <div className="font-medium truncate" title={root.repoRoot}>{root.name}</div>
                      <div className="text-[11px] text-[var(--taomni-text-muted)] truncate" title={root.repoRoot}>
                        {root.repoRoot}
                      </div>
                    </td>
                    {WORKSPACE_SETTING_FIELDS.map((field) => (
                      <td key={field.key} className="px-2 py-2 align-top">
                        <div className="max-w-40 truncate" title={snapshot?.settings[field.key] ?? "(unset)"}>
                          {snapshot ? snapshot.settings[field.key] ?? "(unset)" : state?.loading ? "Loading..." : "(unknown)"}
                        </div>
                      </td>
                    ))}
                    <td className="px-2 py-2 align-top">
                      <div className="max-w-72 truncate" title={snapshot ? workspaceRemoteSummary(snapshot) : ""}>
                        {snapshot ? workspaceRemoteSummary(snapshot) : state?.loading ? "Loading..." : "(unknown)"}
                      </div>
                    </td>
                    <td className="px-2 py-2 align-top text-right">
                      <button
                        type="button"
                        className="taomni-btn h-7 px-2 text-[12px]"
                        onClick={() => onSelectRepo(root.repoRoot)}
                      >
                        Select
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function workspaceRemoteSummary(snapshot: GitSnapshot): string {
  if (snapshot.remotes.length === 0) return "No remotes";
  return snapshot.remotes.map((remote) => {
    const push = remote.pushUrl ? ` -> ${remote.pushUrl}` : "";
    const auth = remote.tokenRef ? " (token stored)" : remote.username ? ` (${remote.username})` : "";
    return `${remote.name}: ${remote.fetchUrl}${push}${auth}`;
  }).join(" | ");
}

function workspaceBranchMatchesQuery(
  root: GitWorkspaceRootInfo,
  branch: GitSnapshot["branches"][number],
  query: string,
): boolean {
  if (!query) return true;
  return (
    root.name.toLowerCase().includes(query) ||
    root.repoRoot.toLowerCase().includes(query) ||
    branch.name.toLowerCase().includes(query) ||
    branch.fullName.toLowerCase().includes(query) ||
    (branch.upstream ?? "").toLowerCase().includes(query) ||
    (branch.subject ?? "").toLowerCase().includes(query)
  );
}

function workspaceTagMatchesQuery(
  root: GitWorkspaceRootInfo,
  tag: GitSnapshot["tags"][number],
  query: string,
): boolean {
  if (!query) return true;
  return (
    root.name.toLowerCase().includes(query) ||
    root.repoRoot.toLowerCase().includes(query) ||
    tag.name.toLowerCase().includes(query) ||
    tag.oid.toLowerCase().includes(query) ||
    (tag.subject ?? "").toLowerCase().includes(query)
  );
}

function RepoSelector({
  roots,
  snapshots,
  scope,
  selectedRoot,
  scopedRoots,
  onScopeChange,
}: {
  roots: GitWorkspaceRootInfo[];
  snapshots: Record<string, RepoSnapshotState>;
  scope: RepoScope;
  selectedRoot: GitWorkspaceRootInfo | null;
  scopedRoots: GitWorkspaceRootInfo[];
  onScopeChange: (scope: RepoScope) => void;
}) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const [draftRoots, setDraftRoots] = useState<Set<string>>(() => (
    new Set(scopedRoots.map((root) => root.repoRoot))
  ));
  const ref = useRef<HTMLDivElement | null>(null);
  const query = filter.trim().toLowerCase();
  const filteredRoots = useMemo(() => (
    roots.filter((root) => {
      if (!query) return true;
      const snapshot = snapshots[root.repoRoot]?.snapshot ?? null;
      return (
        root.name.toLowerCase().includes(query) ||
        root.repoRoot.toLowerCase().includes(query) ||
        root.path.toLowerCase().includes(query) ||
        (snapshot?.currentBranch ?? "").toLowerCase().includes(query) ||
        (snapshot?.upstream ?? "").toLowerCase().includes(query)
      );
    })
  ), [query, roots, snapshots]);
  const groups = useMemo(() => buildRailGroups(filteredRoots), [filteredRoots]);
  const totalChanges = roots.reduce((total, root) => total + (snapshots[root.repoRoot]?.snapshot?.changes.length ?? 0), 0);
  const scopedRootSet = useMemo(
    () => new Set(scopedRoots.map((root) => root.repoRoot)),
    [scopedRoots],
  );
  const label = repoScopeLabel(scope, scopedRoots, selectedRoot, roots.length);
  const title = scope.mode === "all"
    ? "All repositories"
    : scopedRoots.map((root) => root.repoRoot).join("\n");

  useEffect(() => {
    if (!open) return;
    setDraftRoots(new Set(scopedRoots.map((root) => root.repoRoot)));
    const close = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (target && ref.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open, scopedRoots]);

  const closeMenu = () => {
    setOpen(false);
    setFilter("");
  };

  const chooseAll = () => {
    onScopeChange({ mode: "all" });
    closeMenu();
  };

  const chooseSingle = (repoRoot: string) => {
    onScopeChange({ mode: "single", repoRoot });
    closeMenu();
  };

  const toggleDraftRoot = (repoRoot: string, checked: boolean) => {
    setDraftRoots((current) => {
      const next = new Set(current);
      if (checked) next.add(repoRoot);
      else next.delete(repoRoot);
      return next;
    });
  };

  const applyDraft = () => {
    if (draftRoots.size === 0) return;
    onScopeChange(scopeFromRepoRoots(draftRoots, roots));
    closeMenu();
  };

  return (
    <div className="flex items-center gap-1 min-w-0">
      <div ref={ref} className="relative min-w-0">
        <button
          type="button"
          data-testid="workspace-repo-selector"
          className="taomni-btn h-7 max-w-[260px] min-w-[180px] px-2 inline-flex items-center gap-2"
          title={title}
          aria-expanded={open}
          onClick={() => setOpen((current) => !current)}
        >
          <span className="min-w-0 flex-1 truncate text-left">{label}</span>
          <ChevronDown className="w-3.5 h-3.5 shrink-0" />
        </button>
        {open && (
          <div
            data-testid="workspace-repo-selector-menu"
            className="absolute left-0 top-[calc(100%+4px)] z-[70] w-[360px] max-w-[min(360px,calc(100vw-24px))] rounded border border-[var(--taomni-divider)] bg-[var(--taomni-panel-bg)] shadow-lg"
          >
            {roots.length >= 5 && (
              <div className="p-2 border-b border-[var(--taomni-divider)]">
                <div className="relative">
                  <Search className="w-3.5 h-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-[var(--taomni-text-muted)]" />
                  <input
                    className="taomni-input h-7 w-full pl-7"
                    value={filter}
                    placeholder="Search repositories"
                    autoFocus
                    onChange={(event) => setFilter(event.target.value)}
                  />
                </div>
              </div>
            )}
            <div className="max-h-[420px] overflow-auto py-1">
              <button
                type="button"
                className={`w-full px-2 py-1.5 flex items-center gap-2 text-left hover:bg-[var(--taomni-hover)] ${scope.mode === "all" ? "bg-[var(--taomni-hover)]" : ""}`}
                onClick={chooseAll}
              >
                <GitBranch className="w-3.5 h-3.5 shrink-0 text-[var(--taomni-accent)]" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[12px] font-medium">All Repositories</div>
                  <div className="truncate text-[11px] text-[var(--taomni-text-muted)]">{roots.length} repositories</div>
                </div>
                <span className={`shrink-0 rounded px-1.5 py-0.5 text-[11px] ${totalChanges ? "bg-[var(--taomni-accent)] text-white" : "bg-[var(--taomni-hover)] text-[var(--taomni-text-muted)]"}`}>
                  {totalChanges}
                </span>
              </button>
              {groups.length === 0 ? (
                <div className="px-3 py-3 text-[12px] text-[var(--taomni-text-muted)]">No repositories match</div>
              ) : groups.map((group) => (
                <div key={group.key}>
                  {groups.length > 1 && (
                    <div className="px-2 pt-2 pb-1 flex items-center gap-1.5 text-[10px] font-semibold uppercase text-[var(--taomni-text-muted)]">
                      <FolderGit2 className="w-3 h-3" />
                      <span className="truncate">{group.name}</span>
                    </div>
                  )}
                  {group.rows.map(({ root, depth }) => {
                    const state = snapshots[root.repoRoot];
                    const snapshot = state?.snapshot ?? null;
                    const changes = snapshot?.changes.length ?? 0;
                    const branch = snapshot?.detached ? `detached ${snapshot.headOid ?? ""}` : snapshot?.currentBranch ?? "No branch";
                    const checked = draftRoots.has(root.repoRoot);
                    const inScope = scopedRootSet.has(root.repoRoot);
                    return (
                      <div
                        key={root.repoRoot}
                        role="button"
                        tabIndex={0}
                        className={`w-full px-2 py-1.5 flex items-center gap-2 text-left cursor-pointer hover:bg-[var(--taomni-hover)] ${inScope ? "bg-[var(--taomni-hover)]" : ""}`}
                        style={depth > 0 ? { paddingLeft: `${8 + depth * 16}px` } : undefined}
                        title={root.repoRoot}
                        onClick={() => chooseSingle(root.repoRoot)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault();
                            chooseSingle(root.repoRoot);
                          }
                        }}
                      >
                        <input
                          type="checkbox"
                          className="shrink-0 accent-[var(--taomni-accent)]"
                          checked={checked}
                          aria-label={`Include ${root.name}`}
                          onClick={(event) => event.stopPropagation()}
                          onChange={(event) => toggleDraftRoot(root.repoRoot, event.target.checked)}
                        />
                        <RepoStatusIcon loading={!!state?.loading} error={state?.error ?? null} changes={changes} />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1.5">
                            <span className="min-w-0 truncate text-[12px] font-medium">{root.name || gitRepoName(root.repoRoot)}</span>
                            {root.isSubmodule && (
                              <span className="shrink-0 rounded border border-[var(--taomni-divider)] px-1 text-[9px] uppercase text-[var(--taomni-text-muted)]">
                                sub
                              </span>
                            )}
                          </div>
                          <div className="truncate text-[11px] text-[var(--taomni-text-muted)]">{branch}</div>
                        </div>
                        <span className={`shrink-0 rounded px-1.5 py-0.5 text-[11px] ${changes ? "bg-[var(--taomni-accent)] text-white" : "bg-[var(--taomni-hover)] text-[var(--taomni-text-muted)]"}`}>
                          {changes}
                        </span>
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
            <div className="h-9 flex items-center gap-2 px-2 border-t border-[var(--taomni-divider)] bg-[var(--taomni-quick-bg)]">
              <span className="min-w-0 flex-1 truncate text-[11px] text-[var(--taomni-text-muted)]">
                {draftRoots.size} selected
              </span>
              <button type="button" className="taomni-btn h-7 px-2 text-[12px]" onClick={closeMenu}>
                Cancel
              </button>
              <button
                type="button"
                className="taomni-btn h-7 px-2 text-[12px]"
                disabled={draftRoots.size === 0}
                onClick={applyDraft}
              >
                Apply
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function RepoStatusIcon({ loading, error, changes }: { loading: boolean; error: string | null; changes: number }) {
  if (loading) return <Loader2 className="w-3.5 h-3.5 shrink-0 animate-spin text-[var(--taomni-accent)]" />;
  if (error) return <AlertTriangle className="w-3.5 h-3.5 shrink-0 text-red-500" />;
  if (changes) return <Circle className="w-2.5 h-2.5 shrink-0 fill-current text-[var(--taomni-accent)]" />;
  return <Check className="w-3.5 h-3.5 shrink-0 text-[var(--taomni-text-muted)]" />;
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "");
}

function workspaceChangeMenuItems({
  entries,
  onStage,
  onUnstage,
  onDiscard,
}: {
  entries: Array<{
    repoRoot: string;
    repoName: string;
    change: { path: string };
  }>;
  onStage: () => void;
  onUnstage: () => void;
  onDiscard: () => void;
}): MenuItem[] {
  const disabled = entries.length === 0;
  const copy = (text: string) => {
    void navigator.clipboard?.writeText(text).catch(() => {});
  };
  const absolutePaths = entries.map((entry) => {
    const sep = entry.repoRoot.includes("\\") ? "\\" : "/";
    return `${entry.repoRoot}${sep}${entry.change.path.split("/").join(sep)}`;
  });
  const relativePaths = entries.map((entry) => (
    entries.length > 1 ? `${entry.repoName}: ${entry.change.path}` : entry.change.path
  ));
  return [
    { label: "Stage", disabled, onClick: onStage },
    { label: "Unstage", disabled, onClick: onUnstage },
    { label: "Discard...", disabled, danger: true, onClick: onDiscard },
    { label: "", separator: true },
    {
      label: entries.length > 1 ? `Copy paths (${entries.length})` : "Copy path",
      disabled,
      onClick: () => copy(absolutePaths.join("\n")),
    },
    {
      label: "Copy relative path",
      disabled,
      onClick: () => copy(relativePaths.join("\n")),
    },
  ];
}

function ToolbarButton({
  label,
  icon,
  disabled,
  onClick,
}: {
  label: string;
  icon: ReactNode;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="taomni-btn h-7 px-2 inline-flex items-center gap-1"
      title={label}
      disabled={disabled}
      onClick={onClick}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}

function EmptyState({ title }: { title: string }) {
  return (
    <div className="h-full min-h-24 flex items-center justify-center text-[12px] text-[var(--taomni-text-muted)]">
      {title}
    </div>
  );
}

const WORKSPACE_SCOPE_KEY = "taomni.git.workspace.scope.v1";

function workspaceRootsKey(roots: readonly GitWorkspaceRootInfo[]): string {
  return roots.map((root) => root.repoRoot).sort((a, b) => a.localeCompare(b)).join("\n");
}

function initialRepoScope(roots: readonly GitWorkspaceRootInfo[], activeRepoRoot?: string | null): RepoScope {
  if (roots.length === 0) return { mode: "all" };
  if (roots.length === 1) return { mode: "single", repoRoot: roots[0].repoRoot };
  if (activeRepoRoot && !roots.some((root) => root.repoRoot === activeRepoRoot)) {
    return { mode: "all" };
  }
  return { mode: "all" };
}

function loadRepoScope(key: string, roots: readonly GitWorkspaceRootInfo[]): RepoScope | null {
  if (!key) return null;
  try {
    const raw = localStorage.getItem(WORKSPACE_SCOPE_KEY);
    if (!raw) return null;
    const map = JSON.parse(raw) as Record<string, RepoScope>;
    const saved = map[key];
    return saved ? normalizeRepoScope(saved, roots) : null;
  } catch {
    return null;
  }
}

function saveRepoScope(key: string, scope: RepoScope, roots: readonly GitWorkspaceRootInfo[]): void {
  if (!key) return;
  try {
    const raw = localStorage.getItem(WORKSPACE_SCOPE_KEY);
    const map = raw ? (JSON.parse(raw) as Record<string, RepoScope>) : {};
    const normalized = normalizeRepoScope(scope, roots);
    if (normalized.mode === "all") delete map[key];
    else map[key] = normalized;
    localStorage.setItem(WORKSPACE_SCOPE_KEY, JSON.stringify(map));
  } catch {
    /* ignore */
  }
}

function normalizeRepoScope(
  scope: RepoScope,
  roots: readonly GitWorkspaceRootInfo[],
  fallbackRepoRoot?: string | null,
): RepoScope {
  if (roots.length === 0) return { mode: "all" };
  const validRoots = new Set(roots.map((root) => root.repoRoot));
  if (scope.mode === "all") return scope;
  if (scope.mode === "single" && validRoots.has(scope.repoRoot)) return scope;
  if (scope.mode === "custom") {
    const ordered = orderedRepoRoots(scope.repoRoots, roots);
    if (ordered.length === roots.length) return { mode: "all" };
    if (ordered.length === 1) return { mode: "single", repoRoot: ordered[0] };
    if (ordered.length > 1 && sameStringArray(ordered, scope.repoRoots)) return scope;
    if (ordered.length > 1) return { mode: "custom", repoRoots: ordered };
  }
  if (fallbackRepoRoot && validRoots.has(fallbackRepoRoot)) {
    return { mode: "single", repoRoot: fallbackRepoRoot };
  }
  return roots.length > 1 ? { mode: "all" } : { mode: "single", repoRoot: roots[0].repoRoot };
}

function rootsForScope(roots: readonly GitWorkspaceRootInfo[], scope: RepoScope): GitWorkspaceRootInfo[] {
  if (scope.mode === "all") return [...roots];
  if (scope.mode === "single") return roots.filter((root) => root.repoRoot === scope.repoRoot);
  const selected = new Set(scope.repoRoots);
  return roots.filter((root) => selected.has(root.repoRoot));
}

function scopeFromRepoRoots(repoRoots: Iterable<string>, roots: readonly GitWorkspaceRootInfo[]): RepoScope {
  const ordered = orderedRepoRoots([...repoRoots], roots);
  if (ordered.length === 0) return initialRepoScope(roots);
  if (ordered.length === roots.length) return { mode: "all" };
  if (ordered.length === 1) return { mode: "single", repoRoot: ordered[0] };
  return { mode: "custom", repoRoots: ordered };
}

function orderedRepoRoots(repoRoots: readonly string[], roots: readonly GitWorkspaceRootInfo[]): string[] {
  const selected = new Set(repoRoots);
  return roots.filter((root) => selected.has(root.repoRoot)).map((root) => root.repoRoot);
}

function sameStringArray(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((entry, index) => entry === b[index]);
}

function repoScopeLabel(
  scope: RepoScope,
  scopedRoots: readonly GitWorkspaceRootInfo[],
  selectedRoot: GitWorkspaceRootInfo | null,
  totalRoots: number,
): string {
  if (scope.mode === "all") return `All Repositories (${totalRoots})`;
  if (scope.mode === "single") return scopedRoots[0]?.name ?? selectedRoot?.name ?? "Repository";
  const first = scopedRoots[0]?.name ?? "Repositories";
  return scopedRoots.length > 1 ? `${first} +${scopedRoots.length - 1}` : first;
}

export interface RailGroup {
  key: string;
  name: string;
  rows: Array<{ root: GitWorkspaceRootInfo; depth: number }>;
}

function buildRailGroups(roots: readonly GitWorkspaceRootInfo[]): RailGroup[] {
  const byGroup = new Map<string, GitWorkspaceRootInfo[]>();
  for (const root of roots) {
    const key = normalizePath(root.path) || normalizePath(root.repoRoot);
    const list = byGroup.get(key);
    if (list) list.push(root);
    else byGroup.set(key, [root]);
  }
  const groups: RailGroup[] = [];
  for (const [key, repos] of byGroup) {
    const sorted = [...repos].sort((a, b) => a.repoRoot.localeCompare(b.repoRoot));
    const rows = sorted.map((root) => {
      const repoPath = normalizePath(root.repoRoot);
      const depth = sorted.filter((other) => (
        other !== root && repoPath.startsWith(`${normalizePath(other.repoRoot)}/`)
      )).length;
      return { root, depth };
    });
    groups.push({ key, name: lastPathSegment(key), rows });
  }
  return groups.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
}

function lastPathSegment(path: string): string {
  const parts = normalizePath(path).split("/").filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

function dedupeRoots(roots: GitWorkspaceRootInfo[]): GitWorkspaceRootInfo[] {
  const seen = new Set<string>();
  const next: GitWorkspaceRootInfo[] = [];
  for (const root of roots) {
    const repoRoot = root.repoRoot.trim();
    if (!repoRoot || seen.has(repoRoot)) continue;
    seen.add(repoRoot);
    next.push({
      ...root,
      repoRoot,
      name: root.name || gitRepoName(repoRoot),
    });
  }
  return next.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
}

function pullBranchForRemote(snapshot: GitSnapshot, remoteName: string): string | null {
  if (!snapshot.currentBranch || !remoteName) return null;
  const prefix = `${remoteName}/`;
  if (snapshot.upstream?.startsWith(prefix)) {
    return snapshot.upstream.slice(prefix.length) || snapshot.currentBranch;
  }
  return snapshot.currentBranch;
}

function discardConfirmMessage(
  entries: Array<{
    repoName: string;
    change: { path: string; status: string };
  }>,
  count: number,
  untrackedCount: number,
): string {
  if (count === 1) {
    const entry = entries[0];
    if (entry?.change.status === "untracked") {
      return `Delete untracked file ${entry.repoName}: ${entry.change.path}? This cannot be undone.`;
    }
    if (entry) return `Discard changes in ${entry.repoName}: ${entry.change.path}? This cannot be undone.`;
  }
  if (untrackedCount > 0) {
    return `Discard changes in ${count} file(s)? ${untrackedCount} untracked file(s) will be deleted. This cannot be undone.`;
  }
  return `Discard changes in ${count} file(s)? This cannot be undone.`;
}

type CommitDecision = "commit" | "commit-and-push";

async function confirmCommitOperation({
  message,
  push,
  targets,
  checkedChangePathsByRepo,
  snapshots,
}: {
  message: string;
  push: boolean;
  targets: GitWorkspaceRootInfo[];
  checkedChangePathsByRepo: Record<string, string[]>;
  snapshots: Record<string, RepoSnapshotState>;
}): Promise<CommitDecision | null> {
  const confirmMessage = commitOperationConfirmMessage({
    message,
    push,
    targets,
    checkedChangePathsByRepo,
    snapshots,
  });
  if (!push) {
    const confirmed = await confirmAppDialog({
      title: "Confirm Commit",
      message: confirmMessage,
      confirmLabel: "Commit",
    });
    return confirmed ? "commit" : null;
  }
  const choice = await choiceAppDialog({
    title: "Confirm Commit and Push",
    message: confirmMessage,
    primaryLabel: "Commit and Push",
    secondaryLabel: "Commit only",
  });
  if (choice === "primary") return "commit-and-push";
  if (choice === "secondary") return "commit";
  return null;
}

function commitOperationConfirmMessage({
  message,
  push,
  targets,
  checkedChangePathsByRepo,
  snapshots,
}: {
  message: string;
  push: boolean;
  targets: GitWorkspaceRootInfo[];
  checkedChangePathsByRepo: Record<string, string[]>;
  snapshots: Record<string, RepoSnapshotState>;
}): string {
  const lines = targets.map((root) => {
    const paths = checkedChangePathsByRepo[root.repoRoot] ?? [];
    const snapshot = snapshots[root.repoRoot]?.snapshot ?? null;
    const branch = snapshot ? branchSummary(snapshot) : "will refresh";
    const remote = snapshot ? selectedRemote(snapshot) : null;
    const pushSummary = push
      ? remote && snapshot?.currentBranch
        ? ` -> ${remote.name}/${snapshot.currentBranch}${snapshot.upstream ? "" : " (set upstream)"}`
        : " -> push skipped (missing remote or branch)"
      : "";
    return `- ${root.name}: ${paths.length} file(s) on ${branch}${pushSummary}${paths.length ? `\n  ${summarizePaths(paths)}` : ""}`;
  });
  return [
    `Message: ${message}`,
    "",
    "Repositories:",
    ...lines,
    "",
    push
      ? "Confirming will commit the checked files, then push each repository that has a current branch and remote."
      : "Confirming will commit only the checked files listed above.",
  ].join("\n");
}

function remoteOperationConfirmMessage({
  action,
  roots,
  snapshots,
  remoteNameForSnapshot,
}: {
  action: "Push" | "Sync";
  roots: GitWorkspaceRootInfo[];
  snapshots: Record<string, RepoSnapshotState>;
  remoteNameForSnapshot: (snapshot: GitSnapshot | null) => string;
}): string {
  const intro = action === "Sync"
    ? "Sync will pull, then push each repository below."
    : "Push will upload each repository's current branch.";
  const lines = roots.map((root) => {
    const snapshot = snapshots[root.repoRoot]?.snapshot ?? null;
    if (!snapshot) return `- ${root.name}: will refresh before ${action.toLowerCase()}`;
    const remoteName = remoteNameForSnapshot(snapshot);
    if (!remoteName) return `- ${root.name}: skipped (no remote)`;
    if (!snapshot.currentBranch) return `- ${root.name}: skipped (${branchSummary(snapshot)})`;
    return `- ${root.name}: ${snapshot.currentBranch} -> ${remoteName}/${snapshot.currentBranch}${snapshot.upstream ? "" : " (set upstream)"}`;
  });
  return [
    intro,
    "",
    "Repositories:",
    ...lines,
  ].join("\n");
}

function branchSummary(snapshot: GitSnapshot): string {
  if (snapshot.detached) return `detached ${snapshot.headOid ?? ""}`.trim();
  return snapshot.currentBranch ?? "No branch";
}

function summarizePaths(paths: string[]): string {
  const shown = paths.slice(0, 4).join(", ");
  const remaining = paths.length - 4;
  return remaining > 0 ? `${shown}, +${remaining} more` : shown;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
