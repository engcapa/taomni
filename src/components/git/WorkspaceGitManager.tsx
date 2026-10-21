import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { Braces, Download, Ellipsis, GitCommitHorizontal, GitFork, GitMerge, Plus, RefreshCcw, RefreshCw, Upload } from "lucide-react";
import { GIT_REF_WORKTREE, gitBlobPair, gitCheckoutBranch, gitCleanUntracked, gitCommit, gitCreateBranch, gitDiscard, gitFetch, gitPull, gitPush, gitSnapshot, gitStage, gitUnstage, selectedRemote, type GitBlobPair, type GitSnapshot } from "../../lib/git";
import { notifyGitRepoChanged, subscribeGitRepoRefresh } from "../../lib/gitRefresh";
import { alertAppDialog, confirmAppDialog, promptAppDialog } from "../../lib/appDialogs";
import { normalizeWorktreeToMatchHead } from "../../lib/diffWhitespace";
import { workspaceWriteFile } from "../../lib/editor/workspace";
import { useAppStore } from "../../stores/appStore";
import type { GitWorkspaceRootInfo } from "../../types";
import { ContextMenu } from "../ContextMenu";
import { GitPanel } from "./GitPanel";
import { WorkspaceCommitLog } from "./WorkspaceCommitLog";
import { WorkspaceChangesView } from "./WorkspaceChangesView";
import { retainWorkspaceChangeKeys, workspaceChangeKey, workspacePathsByRepoFromKeys } from "./workspaceGitKeys";
import { filterSnapshotRoots, isMissingRepoPathError, retainDeadRepoRoots } from "../../lib/workspaceGitManagerSync";
import { collectLocalBranchNames, resolveCommitBranchPlan } from "../../lib/workspaceGitCommitTarget";
import { dedupeRoots, type RepoScope, type RepoSnapshotState, type FocusedPairState, errorMessage, type BatchResult, pullBranchForRemote } from "./workspace/model";
import { workspaceRootsKey, loadRepoScope, initialRepoScope, rootsForScope, normalizeRepoScope, saveRepoScope } from "./workspace/scope";
import { discardConfirmMessage, confirmCommitOperation, remoteOperationConfirmMessage } from "./workspace/operationConfirmations";
import { RepoSelector } from "./workspace/RepoSelector";
import { ToolbarButton, EmptyState } from "./workspace/controls";
import { WorkspaceBranchesView } from "./workspace/BranchesView";
import { WorkspaceTagsView } from "./workspace/TagsView";
import { WorkspaceSettingsAggregateView } from "./workspace/SettingsAggregateView";
import { workspaceChangeMenuItems } from "./workspace/changeMenu";


interface WorkspaceGitManagerProps {
  workspaceName?: string | null;
  roots: GitWorkspaceRootInfo[];
  activeRepoRoot?: string | null;
  visible?: boolean;
  onOpenWorkspace?: (repoRoot: string, path?: string | null) => void;
}


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
  const [targetBranch, setTargetBranch] = useState("");
  const [uncheckedChangeKeys, setUncheckedChangeKeys] = useState<Set<string>>(() => new Set());
  const [selectedChangeKeys, setSelectedChangeKeys] = useState<Set<string>>(() => new Set());
  const [focusedChangeKey, setFocusedChangeKey] = useState<string | null>(null);
  const [changeMenu, setChangeMenu] = useState<{ x: number; y: number } | null>(null);
  const [pairState, setPairState] = useState<FocusedPairState | null>(null);
  /** Bumped only when a current snapshot lands, so diffs re-read after real refreshes. */
  const [snapshotRevisions, setSnapshotRevisions] = useState<Record<string, number>>({});
  const [repoRemoteNames, setRepoRemoteNames] = useState<Record<string, string>>({});
  const [headerMenu, setHeaderMenu] = useState<{ x: number; y: number } | null>(null);
  const [treeMode, setTreeMode] = useState(() => {
    try {
      return localStorage.getItem("taomni.git.workspace.changes.tree") === "tree";
    } catch {
      return false;
    }
  });
  /** Repo paths that failed with missing-cwd style errors; skip further snapshots. */
  const [deadRepoRoots, setDeadRepoRoots] = useState<Set<string>>(() => new Set());
  const anchorChangeKeyRef = useRef<string | null>(null);
  /** Per-repository snapshot request sequence; only the latest response may commit. */
  const refreshSequenceRef = useRef(new Map<string, number>());
  const liveRepoRootsRef = useRef(new Set<string>());
  const pairGenerationRef = useRef(0);

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
  const focusedPairTarget = useMemo(() => {
    if (!focusedChange) return null;
    const { repoRoot, change } = focusedChange;
    const revision = snapshotRevisions[repoRoot] ?? 0;
    return {
      key: [repoRoot, change.path, change.oldPath ?? "", change.status, change.staged, change.unstaged, revision].join("\u0000"),
      repoRoot,
      path: change.path,
      oldPath: change.oldPath,
    };
    // Depend on the identity fields, not the change object: a loading toggle
    // rebuilds the object without changing what the diff should show.
  }, [
    focusedChange?.repoRoot,
    focusedChange?.change.path,
    focusedChange?.change.oldPath,
    focusedChange?.change.status,
    focusedChange?.change.staged,
    focusedChange?.change.unstaged,
    focusedChange ? snapshotRevisions[focusedChange.repoRoot] : undefined,
  ]);
  const focusedPairKey = focusedPairTarget?.key ?? null;
  const currentPairState = pairState && pairState.key === focusedPairKey ? pairState : null;
  const pair = currentPairState?.pair ?? null;
  const pairLoading = !!focusedPairTarget && !currentPairState;
  const totalChangedFiles = allChanges.length;
  const title = workspaceName?.trim() || "Code Workspace";
  const singleRepoMode = normalizedRoots.length === 1;
  const liveRoots = useMemo(
    () => filterSnapshotRoots(normalizedRoots, deadRepoRoots),
    [deadRepoRoots, normalizedRoots],
  );

  useEffect(() => {
    try {
      localStorage.setItem("taomni.git.workspace.changes.tree", treeMode ? "tree" : "flat");
    } catch {
      /* ignore */
    }
  }, [treeMode]);

  useEffect(() => {
    liveRepoRootsRef.current = new Set(normalizedRoots.map((root) => root.repoRoot));
    setDeadRepoRoots((current) => {
      const next = retainDeadRepoRoots(current, normalizedRoots);
      if (next.size === current.size && [...next].every((root) => current.has(root))) return current;
      return next;
    });
    setSnapshots((current) => {
      const live = new Set(normalizedRoots.map((root) => root.repoRoot));
      const entries = Object.entries(current).filter(([repoRoot]) => live.has(repoRoot));
      if (entries.length === Object.keys(current).length) return current;
      return Object.fromEntries(entries);
    });
  }, [normalizedRoots]);

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
    if (deadRepoRoots.has(repoRoot)) {
      const message = `Repository path no longer exists: ${repoRoot}`;
      setSnapshots((current) => ({
        ...current,
        [repoRoot]: {
          snapshot: null,
          loading: false,
          error: message,
        },
      }));
      throw new Error(message);
    }
    const sequence = (refreshSequenceRef.current.get(repoRoot) ?? 0) + 1;
    refreshSequenceRef.current.set(repoRoot, sequence);
    // A superseded or removed-root response still resolves for its caller but
    // never commits: a late A must not overwrite a newer A, nor revive a root.
    const isCurrent = () => (
      refreshSequenceRef.current.get(repoRoot) === sequence
      && liveRepoRootsRef.current.has(repoRoot)
    );
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
      if (isCurrent()) {
        setSnapshots((current) => ({
          ...current,
          [repoRoot]: {
            snapshot,
            loading: false,
            error: null,
          },
        }));
        setSnapshotRevisions((current) => ({ ...current, [repoRoot]: (current[repoRoot] ?? 0) + 1 }));
      }
      return snapshot;
    } catch (err) {
      const message = errorMessage(err);
      if (!isCurrent()) throw err;
      if (isMissingRepoPathError(message)) {
        setDeadRepoRoots((current) => {
          if (current.has(repoRoot)) return current;
          const next = new Set(current);
          next.add(repoRoot);
          return next;
        });
      }
      setSnapshots((current) => ({
        ...current,
        [repoRoot]: {
          snapshot: isMissingRepoPathError(message) ? null : (current[repoRoot]?.snapshot ?? null),
          loading: false,
          error: message,
        },
      }));
      throw err;
    }
  }, [deadRepoRoots]);

  const refreshRepos = useCallback(async (targets = liveRoots) => {
    const snapshotTargets = filterSnapshotRoots(targets, deadRepoRoots);
    await Promise.allSettled(snapshotTargets.map((root) => refreshRepo(root.repoRoot)));
  }, [deadRepoRoots, liveRoots, refreshRepo]);

  useEffect(() => subscribeGitRepoRefresh((repoRoot) => {
    if (deadRepoRoots.has(repoRoot)) return;
    if (normalizedRoots.some((root) => root.repoRoot === repoRoot)) {
      void refreshRepo(repoRoot);
      setPanelVersion((current) => current + 1);
    }
  }), [deadRepoRoots, normalizedRoots, refreshRepo]);

  useEffect(() => {
    if (!visible || liveRoots.length === 0 || singleRepoMode) return;
    void refreshRepos(liveRoots);
  }, [liveRoots, refreshRepos, singleRepoMode, visible]);

  const loadFocusedPair = useCallback(async (
    target: NonNullable<typeof focusedPairTarget>,
  ): Promise<GitBlobPair | null> => {
    const generation = ++pairGenerationRef.current;
    const isCurrent = () => pairGenerationRef.current === generation;
    try {
      const next = await gitBlobPair(target.repoRoot, target.path, "HEAD", GIT_REF_WORKTREE, target.oldPath);
      if (!isCurrent()) return null;
      setPairState({ key: target.key, repoRoot: target.repoRoot, pair: next });
      return next;
    } catch (err) {
      if (!isCurrent()) return null;
      setPairState({ key: target.key, repoRoot: target.repoRoot, pair: null });
      setStatusMessage(errorMessage(err));
      return null;
    }
  }, [setStatusMessage]);

  useEffect(() => {
    if (!focusedPairTarget) {
      pairGenerationRef.current += 1;
      setPairState(null);
      return;
    }
    void loadFocusedPair(focusedPairTarget);
    // Leaving this key invalidates its in-flight read even if nothing replaces it.
    return () => {
      pairGenerationRef.current += 1;
    };
  }, [focusedPairTarget, loadFocusedPair]);

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
        await refreshRepo(focusedChange.repoRoot);
        setStatusMessage(`Normalized line endings: ${focusedChange.change.path}`);
      } catch (err) {
        setStatusMessage(errorMessage(err));
      } finally {
        setBusyLabel(null);
      }
    })();
  }, [focusedChange, pair, refreshRepo, reloadFocusedPair, setStatusMessage]);

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
    await refreshRepo(focusedChange.repoRoot);
    setStatusMessage(`Saved ${focusedChange.change.path}`);
  }, [focusedChange, refreshRepo, reloadFocusedPair, setStatusMessage]);

  const commitBranchOptions = useMemo(
    () => collectLocalBranchNames(scopedRoots.map((root) => snapshots[root.repoRoot]?.snapshot ?? null)),
    [scopedRoots, snapshots],
  );

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
        targetBranch,
      });
      if (!decision) return;
      await runChangeAction(decision === "commit-and-push" ? "Commit and Push" : "Commit", targets, async (_root, snapshot) => {
        const selectedPaths = new Set(checkedChangePathsByRepo[snapshot.repoRoot] ?? []);
        const paths = snapshot.changes
          .filter((change) => selectedPaths.has(change.path))
          .map((change) => change.path);
        if (paths.length === 0) return "skipped";
        const plan = resolveCommitBranchPlan(snapshot, targetBranch);
        if (plan.action === "checkout") {
          await gitCheckoutBranch(snapshot.repoRoot, plan.targetBranch);
        } else if (plan.action === "create") {
          await gitCreateBranch(snapshot.repoRoot, plan.targetBranch, null, true);
        }
        await gitCommit(snapshot.repoRoot, message, false, paths);
        if (decision === "commit-and-push") {
          const refreshed = await refreshRepo(snapshot.repoRoot).catch(() => snapshot);
          const remote = selectedRemote(refreshed);
          const branchName = plan.action === "stay"
            ? (refreshed.currentBranch ?? snapshot.currentBranch)
            : plan.targetBranch;
          if (remote && branchName) {
            const hasUpstream = !!refreshed.upstream && plan.action === "stay";
            await gitPush(snapshot.repoRoot, remote.name, branchName, !hasUpstream);
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
    refreshRepo,
    runChangeAction,
    snapshots,
    targetBranch,
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
                targetBranch={targetBranch}
                setTargetBranch={setTargetBranch}
                branchOptions={commitBranchOptions}
                branchPlaceholder="Current branch (or type a new name)"
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
                onNormalizeLineEndings={normalizeFocusedLineEndings}
                normalizeLineEndingsBusy={busyLabel === "Normalize EOL"}
                onOpenInEditor={onOpenWorkspace ? openFocusedInEditor : undefined}
                onSaveWorktree={saveFocusedWorktree}
                worktreeEditable={!!focusedChange && focusedChange.change.status !== "deleted"}
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

export { type RailGroup } from "./workspace/model";
