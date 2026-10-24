import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { GIT_REF_WORKTREE, gitBlobPair, gitCheckoutBranch, gitCommit, gitCreateBranch, gitPush, selectedRemote, type GitBlobPair } from "../../lib/git";
import { collectLocalBranchNames, resolveCommitBranchPlan } from "../../lib/workspaceGitCommitTarget";
import { useAppStore } from "../../stores/appStore";
import type { GitWorkspaceRootInfo } from "../../types";
import { GitPanel } from "./GitPanel";
import { errorMessage, type FocusedPairState } from "./workspace/model";
import { confirmCommitOperation } from "./workspace/operationConfirmations";
import { useWorkspaceGitBatch } from "./workspace/useWorkspaceGitBatch";
import { useWorkspaceGitChanges } from "./workspace/useWorkspaceGitChanges";
import { useWorkspaceGitRepositories } from "./workspace/useWorkspaceGitRepositories";
import { WorkspaceGitManagerView } from "./workspace/WorkspaceGitManagerView";
import { retainWorkspaceChangeKeys, workspaceChangeKey } from "./workspaceGitKeys";

interface WorkspaceGitManagerProps {
  workspaceName?: string | null;
  roots: GitWorkspaceRootInfo[];
  activeRepoRoot?: string | null;
  visible?: boolean;
  onOpenWorkspace?: (repoRoot: string, path?: string | null) => void;
  /** Absolute path to focus in the diff view once the repository snapshot lands. */
  initialChangePath?: string | null;
}

export function WorkspaceGitManager({
  workspaceName,
  roots,
  activeRepoRoot,
  visible = true,
  onOpenWorkspace,
  initialChangePath,
}: WorkspaceGitManagerProps) {
  const setStatusMessage = useAppStore((s) => s.setStatusMessage);
  const [busyLabel, setBusyLabel] = useState<string | null>(null);
  const [panelVersion, setPanelVersion] = useState(0);
  const [commitMessage, setCommitMessage] = useState("");
  const [targetBranch, setTargetBranch] = useState("");
  const [uncheckedChangeKeys, setUncheckedChangeKeys] = useState<Set<string>>(() => new Set());
  const [selectedChangeKeys, setSelectedChangeKeys] = useState<Set<string>>(() => new Set());
  const [focusedChangeKey, setFocusedChangeKey] = useState<string | null>(null);
  const [changeMenu, setChangeMenu] = useState<{ x: number; y: number; } | null>(null);
  const [pairState, setPairState] = useState<FocusedPairState | null>(null);
  const [repoRemoteNames, setRepoRemoteNames] = useState<Record<string, string>>({});
  const [headerMenu, setHeaderMenu] = useState<{ x: number; y: number; } | null>(null);
  const [treeMode, setTreeMode] = useState(() => {
    try {
      return localStorage.getItem("taomni.git.workspace.changes.tree") === "tree";
    } catch {
      return false;
    }
  });
  const anchorChangeKeyRef = useRef<string | null>(null);
  const pairGenerationRef = useRef(0);
  const repositories = useWorkspaceGitRepositories({
    roots,
    activeRepoRoot,
    setPanelVersion,
    visible,
  });
  const allChanges = useMemo(
    () => repositories.scopedRoots.flatMap((root) => (
      (repositories.snapshots[root.repoRoot]?.snapshot?.changes ?? []).map((change) => ({
        key: workspaceChangeKey(root.repoRoot, change.path),
        repoRoot: root.repoRoot,
        repoName: root.name,
        change,
      }))
    )),
    [repositories.scopedRoots, repositories.snapshots],
  );
  const allChangeKeys = useMemo(() => allChanges.map((entry) => entry.key), [allChanges]);
  const validChangeKeys = useMemo(() => new Set(allChangeKeys), [allChangeKeys]);
  // The editor's "compare in Git panel" action targets the current file; focus
  // its change once the repository snapshot has loaded (v6.1 review H6). The
  // focus is applied once per requested path so later refreshes do not steal
  // the user's selection.
  const appliedFocusPathRef = useRef<string | null>(null);
  useEffect(() => {
    if (!initialChangePath) {
      appliedFocusPathRef.current = null;
      return;
    }
    if (appliedFocusPathRef.current === initialChangePath) return;
    const normalized = initialChangePath.replace(/\\/g, "/");
    const match = allChanges.find((entry) => {
      const absolute = `${entry.repoRoot.replace(/\\/g, "/").replace(/\/+$/, "")}/${entry.change.path.replace(/^\/+/, "")}`;
      return absolute === normalized;
    });
    if (match) {
      appliedFocusPathRef.current = initialChangePath;
      setFocusedChangeKey(match.key);
    }
  }, [allChanges, initialChangePath]);
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
      const snapshot = repositories.snapshots[repoRoot]?.snapshot;
      return !!snapshot?.currentBranch && !!selectedRemote(snapshot);
    });
  }, [checkedChangePathsByRepo, repositories.snapshots]);
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
    const revision = repositories.snapshotRevisions[repoRoot] ?? 0;
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
    focusedChange ? repositories.snapshotRevisions[focusedChange.repoRoot] : undefined,
  ]);
  const focusedPairKey = focusedPairTarget?.key ?? null;
  const currentPairState = pairState && pairState.key === focusedPairKey ? pairState : null;
  const pair = currentPairState?.pair ?? null;
  const pairLoading = !!focusedPairTarget && !currentPairState;
  const totalChangedFiles = allChanges.length;
  const title = workspaceName?.trim() || "Code Workspace";

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

  const selectWorkspaceChange = useCallback((repoRoot: string, path: string, mods: { ctrl: boolean; shift: boolean; }) => {
    const key = workspaceChangeKey(repoRoot, path);
    repositories.setSelectedRepoRoot(repoRoot);
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
  const changes = useWorkspaceGitChanges({
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
  });

  const commitBranchOptions = useMemo(
    () => collectLocalBranchNames(repositories.scopedRoots.map((root) => repositories.snapshots[root.repoRoot]?.snapshot ?? null)),
    [repositories.scopedRoots, repositories.snapshots],
  );

  const commitWorkspaceChanges = useCallback((push: boolean) => {
    const message = commitMessage.trim();
    if (!message || checkedChangeKeys.size === 0) return;
    const targets = repositories.normalizedRoots.filter((root) => (checkedChangePathsByRepo[root.repoRoot]?.length ?? 0) > 0);
    void (async () => {
      const decision = await confirmCommitOperation({
        message,
        push,
        targets,
        checkedChangePathsByRepo,
        snapshots: repositories.snapshots,
        targetBranch,
      });
      if (!decision) return;
      await changes.runChangeAction(decision === "commit-and-push" ? "Commit and Push" : "Commit", targets, async (_root, snapshot) => {
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
          const refreshed = await repositories.refreshRepo(snapshot.repoRoot).catch(() => snapshot);
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
    repositories.normalizedRoots,
    repositories.refreshRepo,
    changes.runChangeAction,
    repositories.snapshots,
    targetBranch,
  ]);
  const batch = useWorkspaceGitBatch({
    repoRemoteNames,
    repositories,
    setBusyLabel,
    setStatusMessage,
    setPanelVersion,
  });

  const aggregate = useMemo(() => {
    let ahead = 0;
    let behind = 0;
    for (const root of repositories.scopedRoots) {
      const snapshot = repositories.snapshots[root.repoRoot]?.snapshot;
      if (!snapshot) continue;
      ahead += snapshot.ahead;
      behind += snapshot.behind;
    }
    return { ahead, behind };
  }, [repositories.scopedRoots, repositories.snapshots]);

  const busy = busyLabel !== null;
  const refreshOperationRoots = useCallback(async () => {
    if (repositories.operationRoots.length === 0) return;
    setBusyLabel("Refresh");
    try {
      await repositories.refreshRepos(repositories.operationRoots);
      setStatusMessage(`Refresh: ${repositories.operationRoots.length} completed`);
    } finally {
      setPanelVersion((current) => current + 1);
      setBusyLabel(null);
    }
  }, [repositories.operationRoots, repositories.refreshRepos, setStatusMessage]);

  const currentSnapshot = repositories.selectedRoot ? repositories.snapshots[repositories.selectedRoot.repoRoot]?.snapshot ?? null : null;
  const currentRemoteName = repositories.repoScopeIsMulti ? "" : batch.remoteNameForSnapshot(currentSnapshot);
  const operationDisabled = busy || repositories.operationRoots.length === 0;
  const scopeRepoCount = repositories.scopedRoots.length;
  const scopeSummary = `${scopeRepoCount} repositor${scopeRepoCount === 1 ? "y" : "ies"} · ${totalChangedFiles} changed files`;

  if (repositories.singleRepoMode && repositories.selectedRoot) {
    return (
      <GitPanel
        repoRoot={repositories.selectedRoot.repoRoot}
        visible={visible}
        onOpenWorkspace={onOpenWorkspace}
      />
    );
  }

  return <WorkspaceGitManagerView
    repositories={repositories}
    visible={visible}
    onOpenWorkspace={onOpenWorkspace}
    totalChangedFiles={totalChangedFiles}
    panelVersion={panelVersion}
    title={title}
    scopeSummary={scopeSummary}
    scopeRepoCount={scopeRepoCount}
    aggregate={aggregate}
    currentRemoteName={currentRemoteName}
    setRepoRemoteNames={setRepoRemoteNames}
    currentSnapshot={currentSnapshot}
    operationDisabled={operationDisabled}
    batch={batch}
    setHeaderMenu={setHeaderMenu}
    busyLabel={busyLabel}
    refreshOperationRoots={refreshOperationRoots}
    busy={busy}
    treeMode={treeMode}
    setTreeMode={setTreeMode}
    checkedChangeKeys={checkedChangeKeys}
    checkedRepoCount={checkedRepoCount}
    selectedChangeKeys={selectedChangeKeys}
    focusedChangeKey={focusedChangeKey}
    pair={pair}
    pairLoading={pairLoading}
    commitMessage={commitMessage}
    setCommitMessage={setCommitMessage}
    canPushCheckedChanges={canPushCheckedChanges}
    targetBranch={targetBranch}
    setTargetBranch={setTargetBranch}
    commitBranchOptions={commitBranchOptions}
    changes={changes}
    commitWorkspaceChanges={commitWorkspaceChanges}
    toggleChangeChecked={toggleChangeChecked}
    selectWorkspaceChange={selectWorkspaceChange}
    openWorkspaceChangeMenu={openWorkspaceChangeMenu}
    focusedChange={focusedChange}
    headerMenu={headerMenu}
    changeMenu={changeMenu}
    setChangeMenu={setChangeMenu}
    selectedOperationEntries={selectedOperationEntries}
  />;
}

export { type RailGroup } from "./workspace/model";
