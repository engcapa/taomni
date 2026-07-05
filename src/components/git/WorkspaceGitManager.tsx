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
  Download,
  GitBranch,
  GitCommitHorizontal,
  GitMerge,
  Loader2,
  RefreshCw,
  Search,
  Upload,
} from "lucide-react";
import {
  GIT_REF_WORKTREE,
  gitBlobPair,
  gitCleanUntracked,
  gitCommit,
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
import { alertAppDialog, confirmAppDialog } from "../../lib/appDialogs";
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

export function WorkspaceGitManager({
  workspaceName,
  roots,
  activeRepoRoot,
  visible = true,
  onOpenWorkspace,
}: WorkspaceGitManagerProps) {
  const setStatusMessage = useAppStore((s) => s.setStatusMessage);
  const normalizedRoots = useMemo(() => dedupeRoots(roots), [roots]);
  const [selectedRepoRoot, setSelectedRepoRoot] = useState(activeRepoRoot ?? normalizedRoots[0]?.repoRoot ?? "");
  const [checkedRepoRoots, setCheckedRepoRoots] = useState<Set<string>>(() => (
    new Set(normalizedRoots.map((root) => root.repoRoot))
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
  const [repoFilter, setRepoFilter] = useState("");
  const [showCleanRepos, setShowCleanRepos] = useState(true);
  const [treeMode, setTreeMode] = useState(() => {
    try {
      return localStorage.getItem("taomni.git.workspace.changes.tree") !== "flat";
    } catch {
      return true;
    }
  });
  const anchorChangeKeyRef = useRef<string | null>(null);

  const selectedRoot = useMemo(
    () => normalizedRoots.find((root) => root.repoRoot === selectedRepoRoot) ?? normalizedRoots[0] ?? null,
    [normalizedRoots, selectedRepoRoot],
  );
  const checkedRoots = useMemo(
    () => normalizedRoots.filter((root) => checkedRepoRoots.has(root.repoRoot)),
    [checkedRepoRoots, normalizedRoots],
  );
  const allChanges = useMemo(
    () => normalizedRoots.flatMap((root) => (
      (snapshots[root.repoRoot]?.snapshot?.changes ?? []).map((change) => ({
        key: workspaceChangeKey(root.repoRoot, change.path),
        repoRoot: root.repoRoot,
        repoName: root.name,
        change,
      }))
    )),
    [normalizedRoots, snapshots],
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
  const totalChangedFiles = allChanges.length;
  const allChecked = normalizedRoots.length > 0 && checkedRoots.length === normalizedRoots.length;
  const title = workspaceName?.trim() || "Code Workspace";
  const singleRepoMode = normalizedRoots.length === 1;
  const filteredSidebarRoots = useMemo(() => {
    const query = repoFilter.trim().toLowerCase();
    return normalizedRoots.filter((root) => {
      const snapshot = snapshots[root.repoRoot]?.snapshot ?? null;
      const hasChanges = (snapshot?.changes.length ?? 0) > 0;
      if (!showCleanRepos && !hasChanges) return false;
      if (!query) return true;
      return (
        root.name.toLowerCase().includes(query) ||
        root.repoRoot.toLowerCase().includes(query) ||
        (snapshot?.currentBranch ?? "").toLowerCase().includes(query) ||
        (snapshot?.upstream ?? "").toLowerCase().includes(query)
      );
    });
  }, [normalizedRoots, repoFilter, showCleanRepos, snapshots]);

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
      if (normalizedRoots.some((root) => root.repoRoot === current)) return current;
      if (activeRepoRoot && normalizedRoots.some((root) => root.repoRoot === activeRepoRoot)) {
        return activeRepoRoot;
      }
      return normalizedRoots[0]?.repoRoot ?? "";
    });
    setCheckedRepoRoots((current) => {
      const valid = new Set(normalizedRoots.map((root) => root.repoRoot));
      const retained = new Set([...current].filter((repoRoot) => valid.has(repoRoot)));
      return retained.size > 0 ? retained : valid;
    });
  }, [activeRepoRoot, normalizedRoots]);

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

  const toggleChecked = useCallback((repoRoot: string, checked: boolean) => {
    setCheckedRepoRoots((current) => {
      const next = new Set(current);
      if (checked) next.add(repoRoot);
      else next.delete(repoRoot);
      return next;
    });
  }, []);

  const setAllChecked = useCallback((checked: boolean) => {
    setCheckedRepoRoots(checked ? new Set(normalizedRoots.map((root) => root.repoRoot)) : new Set());
  }, [normalizedRoots]);

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

  const stageAllChanges = useCallback(() => {
    const targets = normalizedRoots.filter((root) => (snapshots[root.repoRoot]?.snapshot?.changes.length ?? 0) > 0);
    void runChangeAction("Stage all", targets, async (_root, snapshot) => {
      const paths = snapshot.changes.map((change) => change.path);
      if (paths.length === 0) return "skipped";
      await gitStage(snapshot.repoRoot, paths);
      return "completed";
    });
  }, [normalizedRoots, runChangeAction, snapshots]);

  const unstageAllChanges = useCallback(() => {
    const targets = normalizedRoots.filter((root) => (
      snapshots[root.repoRoot]?.snapshot?.changes.some((change) => change.staged) ?? false
    ));
    void runChangeAction("Unstage all", targets, async (_root, snapshot) => {
      const paths = snapshot.changes.filter((change) => change.staged).map((change) => change.path);
      if (paths.length === 0) return "skipped";
      await gitUnstage(snapshot.repoRoot, paths);
      return "completed";
    });
  }, [normalizedRoots, runChangeAction, snapshots]);

  const stageSelectedChanges = useCallback(() => {
    const pathsByRepo = workspacePathsByRepoFromKeys(selectedOperationKeys);
    const targets = normalizedRoots.filter((root) => (pathsByRepo[root.repoRoot]?.length ?? 0) > 0);
    void runChangeAction("Stage", targets, async (root) => {
      const paths = pathsByRepo[root.repoRoot] ?? [];
      if (paths.length === 0) return "skipped";
      await gitStage(root.repoRoot, paths);
      return "completed";
    });
  }, [normalizedRoots, runChangeAction, selectedOperationKeys]);

  const unstageSelectedChanges = useCallback(() => {
    const pathsByRepo = workspacePathsByRepoFromKeys(selectedOperationKeys);
    const targets = normalizedRoots.filter((root) => (pathsByRepo[root.repoRoot]?.length ?? 0) > 0);
    void runChangeAction("Unstage", targets, async (root) => {
      const paths = pathsByRepo[root.repoRoot] ?? [];
      if (paths.length === 0) return "skipped";
      await gitUnstage(root.repoRoot, paths);
      return "completed";
    });
  }, [normalizedRoots, runChangeAction, selectedOperationKeys]);

  const discardSelectedChanges = useCallback(() => {
    const pathsByRepo = workspacePathsByRepoFromKeys(selectedOperationKeys);
    const targets = normalizedRoots.filter((root) => (pathsByRepo[root.repoRoot]?.length ?? 0) > 0);
    const count = Object.values(pathsByRepo).reduce((total, paths) => total + paths.length, 0);
    if (count === 0) return;
    void (async () => {
      const confirmed = await confirmAppDialog({
        title: "Discard changes",
        message: `Discard changes in ${count} file(s)? This cannot be undone.`,
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
  }, [normalizedRoots, runChangeAction, selectedOperationKeys]);

  const commitWorkspaceChanges = useCallback((push: boolean) => {
    const message = commitMessage.trim();
    if (!message || checkedChangeKeys.size === 0) return;
    const targets = normalizedRoots.filter((root) => (checkedChangePathsByRepo[root.repoRoot]?.length ?? 0) > 0);
    void (async () => {
      await runChangeAction(push ? "Commit and Push" : "Commit", targets, async (_root, snapshot) => {
        const paths = snapshot.changes
          .filter((change) => !uncheckedChangeKeys.has(workspaceChangeKey(snapshot.repoRoot, change.path)))
          .map((change) => change.path);
        if (paths.length === 0) return "skipped";
        await gitCommit(snapshot.repoRoot, message, false, paths);
        if (push) {
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
    uncheckedChangeKeys,
  ]);

  const runBatch = useCallback(async (
    label: string,
    action: (root: GitWorkspaceRootInfo, snapshot: GitSnapshot) => Promise<BatchResult>,
  ) => {
    if (checkedRoots.length === 0) return;
    setBusyLabel(label);
    const failures: string[] = [];
    let completed = 0;
    let skipped = 0;
    try {
      for (const root of checkedRoots) {
        try {
          const snapshot = await refreshRepo(root.repoRoot);
          const result = await action(root, snapshot);
          if (result === "completed") {
            completed += 1;
            await refreshRepo(root.repoRoot);
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
  }, [checkedRoots, refreshRepo, setStatusMessage]);

  const batchFetch = useCallback(() => runBatch("Fetch", async (_root, snapshot) => {
    const remote = selectedRemote(snapshot);
    if (!remote) return "skipped";
    await gitFetch(snapshot.repoRoot, remote.name);
    return "completed";
  }), [runBatch]);

  const batchPull = useCallback(() => runBatch("Pull", async (_root, snapshot) => {
    const remote = selectedRemote(snapshot);
    if (!remote) return "skipped";
    await gitPull(snapshot.repoRoot, remote.name, pullBranchForRemote(snapshot, remote.name));
    return "completed";
  }), [runBatch]);

  const batchPush = useCallback(() => runBatch("Push", async (_root, snapshot) => {
    const remote = selectedRemote(snapshot);
    if (!remote || !snapshot.currentBranch) return "skipped";
    await gitPush(snapshot.repoRoot, remote.name, snapshot.currentBranch, !snapshot.upstream);
    return "completed";
  }), [runBatch]);

  const busy = busyLabel !== null;
  const refreshChecked = useCallback(async () => {
    if (checkedRoots.length === 0) return;
    setBusyLabel("Refresh");
    try {
      await refreshRepos(checkedRoots);
      setStatusMessage(`Refresh: ${checkedRoots.length} completed`);
    } finally {
      setPanelVersion((current) => current + 1);
      setBusyLabel(null);
    }
  }, [checkedRoots, refreshRepos, setStatusMessage]);

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
      className="h-full w-full min-h-0 flex flex-col bg-[var(--taomni-bg)] text-[var(--taomni-text)]"
    >
      <header className="h-10 shrink-0 flex items-center gap-2 border-b border-[var(--taomni-divider)] bg-[var(--taomni-quick-bg)] px-3">
        <GitBranch className="w-4 h-4 text-[var(--taomni-accent)]" />
        <div className="min-w-0">
          <div className="font-semibold leading-4 truncate">Git · {title}</div>
          <div className="text-[11px] text-[var(--taomni-text-muted)] truncate">
            {normalizedRoots.length} repositories · {totalChangedFiles} changed files
          </div>
        </div>
        <div className="flex-1" />
        <ToolbarButton
          label="Refresh"
          icon={<RefreshCw className={`w-3.5 h-3.5 ${busyLabel === "Refresh" ? "animate-spin" : ""}`} />}
          disabled={busy || checkedRoots.length === 0}
          onClick={() => void refreshChecked()}
        />
        <ToolbarButton
          label="Fetch"
          icon={<Download className="w-3.5 h-3.5" />}
          disabled={busy || checkedRoots.length === 0}
          onClick={() => void batchFetch()}
        />
        <ToolbarButton
          label="Pull"
          icon={<GitMerge className="w-3.5 h-3.5" />}
          disabled={busy || checkedRoots.length === 0}
          onClick={() => void batchPull()}
        />
        <ToolbarButton
          label="Push"
          icon={<Upload className="w-3.5 h-3.5" />}
          disabled={busy || checkedRoots.length === 0}
          onClick={() => void batchPush()}
        />
      </header>

      <div className="flex-1 min-h-0 flex">
        <aside
          data-testid="workspace-git-sidebar"
          className="w-[340px] min-w-[260px] max-w-[45%] shrink-0 border-r border-[var(--taomni-divider)] bg-[var(--taomni-quick-bg)] flex flex-col"
        >
          <div className="h-9 shrink-0 flex items-center gap-2 border-b border-[var(--taomni-divider)] px-3">
            <label className="inline-flex items-center gap-2 text-[12px]">
              <input
                type="checkbox"
                className="accent-[var(--taomni-accent)]"
                checked={allChecked}
                disabled={normalizedRoots.length === 0}
                onChange={(event) => setAllChecked(event.target.checked)}
              />
              <span>Repositories</span>
              <span className="text-[11px] text-[var(--taomni-text-muted)]">
                {checkedRoots.length}/{normalizedRoots.length}
              </span>
            </label>
            <div className="flex-1" />
            {busyLabel && <Loader2 className="w-3.5 h-3.5 animate-spin text-[var(--taomni-accent)]" />}
          </div>
          <div className="h-9 shrink-0 flex items-center gap-1.5 border-b border-[var(--taomni-divider)] px-2">
            <div className="relative min-w-0 flex-1">
              <Search className="w-3.5 h-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-[var(--taomni-text-muted)]" />
              <input
                className="taomni-input h-7 w-full pl-7"
                value={repoFilter}
                placeholder="Filter repositories"
                onChange={(event) => setRepoFilter(event.target.value)}
              />
            </div>
            <button
              type="button"
              className={`taomni-btn h-7 px-2 text-[11px] ${showCleanRepos ? "" : "bg-[var(--taomni-hover)]"}`}
              title={showCleanRepos ? "Hide clean repositories" : "Show clean repositories"}
              onClick={() => setShowCleanRepos((current) => !current)}
            >
              Changed
            </button>
          </div>
          <div className="flex-1 min-h-0 overflow-auto">
            {normalizedRoots.length === 0 ? (
              <EmptyState title="No Git repositories detected" />
            ) : filteredSidebarRoots.length === 0 ? (
              <EmptyState title="No repositories match the filter" />
            ) : filteredSidebarRoots.map((root) => {
              const state = snapshots[root.repoRoot];
              const snapshot = state?.snapshot ?? null;
              const selected = selectedRoot?.repoRoot === root.repoRoot;
              const checked = checkedRepoRoots.has(root.repoRoot);
              return (
                <RepoRow
                  key={root.repoRoot}
                  root={root}
                  snapshot={snapshot}
                  loading={!!state?.loading}
                  error={state?.error ?? null}
                  selected={selected}
                  checked={checked}
                  workspacePath={root.path}
                  onChecked={(next) => toggleChecked(root.repoRoot, next)}
                  onSelect={() => setSelectedRepoRoot(root.repoRoot)}
                />
              );
            })}
          </div>
        </aside>

        <main className="flex-1 min-w-0 min-h-0">
          {selectedRoot ? (
            <GitPanel
              key={`${selectedRoot.repoRoot}:${panelVersion}`}
              repoRoot={selectedRoot.repoRoot}
              visible={visible}
              onOpenWorkspace={onOpenWorkspace}
              changeCountOverride={totalChangedFiles}
              workspaceHeader={{
                title,
                summary: `${normalizedRoots.length} repositories · ${totalChangedFiles} changed files`,
                selectedRepoName: selectedRoot.name,
                selectedRepoRoot: selectedRoot.repoRoot,
              }}
              workspaceLogView={(
                <WorkspaceCommitLog
                  roots={normalizedRoots}
                  busy={busy}
                />
              )}
              changesView={(
                <WorkspaceChangesView
                  roots={normalizedRoots}
                  snapshots={snapshots}
                  busy={busy}
                  treeMode={treeMode}
                  setTreeMode={setTreeMode}
                  checkedKeys={checkedChangeKeys}
                  checkedCount={checkedChangeKeys.size}
                  checkedRepoCount={checkedRepoCount}
                  selectedKeys={selectedChangeKeys}
                  selectedCount={selectedOperationKeys.length}
                  focusedKey={focusedChangeKey}
                  pair={pair}
                  pairLoading={pairLoading}
                  commitMessage={commitMessage}
                  setCommitMessage={setCommitMessage}
                  canCommitAndPush={canPushCheckedChanges}
                  scopeSummary={`${normalizedRoots.length} repositories · ${totalChangedFiles} changed files`}
                  stageAll={stageAllChanges}
                  unstageAll={unstageAllChanges}
                  stageSelected={stageSelectedChanges}
                  unstageSelected={unstageSelectedChanges}
                  discardSelected={discardSelectedChanges}
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
      </div>
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

function RepoRow({
  root,
  snapshot,
  loading,
  error,
  selected,
  checked,
  workspacePath,
  onChecked,
  onSelect,
}: {
  root: GitWorkspaceRootInfo;
  snapshot: GitSnapshot | null;
  loading: boolean;
  error: string | null;
  selected: boolean;
  checked: boolean;
  workspacePath: string;
  onChecked: (checked: boolean) => void;
  onSelect: () => void;
}) {
  const branch = snapshot?.detached ? `detached ${snapshot.headOid ?? ""}` : snapshot?.currentBranch ?? "";
  const changes = snapshot?.changes ?? [];
  const relation = repoRelationLabel(root.repoRoot, workspacePath);
  return (
    <div
      className={`group border-b border-[var(--taomni-divider)] ${selected ? "bg-[var(--taomni-hover)]" : "hover:bg-[var(--taomni-hover)]"}`}
    >
      <div className="flex items-start gap-2 px-3 py-2">
        <input
          type="checkbox"
          className="mt-1 accent-[var(--taomni-accent)]"
          checked={checked}
          onChange={(event) => onChecked(event.target.checked)}
          onClick={(event) => event.stopPropagation()}
          aria-label={`Select ${root.name}`}
        />
        <button
          type="button"
          className="min-w-0 flex-1 text-left"
          onClick={onSelect}
        >
          <div className="flex items-center gap-2">
            <span className="min-w-0 truncate text-[13px] font-medium">{root.name || gitRepoName(root.repoRoot)}</span>
            {loading && <Loader2 className="w-3 h-3 shrink-0 animate-spin text-[var(--taomni-accent)]" />}
            {error && <AlertTriangle className="w-3.5 h-3.5 shrink-0 text-red-500" />}
          </div>
          <div className="mt-1 flex items-center gap-2 text-[11px] text-[var(--taomni-text-muted)]">
            <GitCommitHorizontal className="w-3 h-3 shrink-0" />
            <span className="min-w-0 truncate">{branch || "No branch"}</span>
          </div>
          <div className="mt-1 truncate text-[11px] text-[var(--taomni-text-muted)]" title={root.repoRoot}>
            {relation ? `${relation} · ${root.repoRoot}` : root.repoRoot}
          </div>
          {error && (
            <div className="mt-1 truncate text-[11px] text-red-500" title={error}>
              {error}
            </div>
          )}
        </button>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <span className={`rounded px-1.5 py-0.5 text-[11px] ${changes.length > 0 ? "bg-[var(--taomni-accent)] text-white" : "bg-[var(--taomni-hover)] text-[var(--taomni-text-muted)]"}`}>
            {changes.length}
          </span>
          {snapshot && (snapshot.ahead > 0 || snapshot.behind > 0) && (
            <span className="text-[10px] text-[var(--taomni-text-muted)]">
              ↑{snapshot.ahead} ↓{snapshot.behind}
            </span>
          )}
        </div>
      </div>
      {snapshot && changes.length === 0 && !loading && !error ? (
        <div className="px-9 pb-2 text-[11px] text-[var(--taomni-text-muted)]">
          No changes
        </div>
      ) : null}
    </div>
  );
}

function repoRelationLabel(repoRoot: string, workspacePath: string): string | null {
  const repo = normalizePath(repoRoot);
  const workspace = normalizePath(workspacePath);
  if (!repo || !workspace || repo === workspace) return null;
  if (repo.startsWith(`${workspace}/`)) return `inside ${repo.slice(workspace.length + 1)}`;
  if (workspace.startsWith(`${repo}/`)) return `root ${workspace.slice(repo.length + 1)}`;
  return null;
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

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
