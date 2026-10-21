import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { alertAppDialog, promptAppDialog } from "../../lib/appDialogs";
import {
  GIT_REF_WORKTREE,
  gitBlobPair,
  gitCheckoutBranch,
  gitCleanUntracked,
  gitCommit,
  gitCreateBranch,
  gitDiscard,
  gitOperationState,
  gitPull,
  gitPush,
  gitRepoName,
  gitResolveConflict,
  gitSnapshot,
  gitStage,
  gitStashShow,
  gitUnstage,
  selectedRemote,
  type GitBlobPair,
  type GitBranch as GitBranchInfo,
  type GitLogEntry,
  type GitOperationState,
  type GitRepoSettings,
  type GitSnapshot,
  type GitStashEntry,
} from "../../lib/git";
import { notifyGitRepoChanged, subscribeGitRepoRefresh } from "../../lib/gitRefresh";
import { useAppStore } from "../../stores/appStore";
import { GitPanelView } from "./panel/GitPanelView";
import { buildRemoteDrafts, EMPTY_SETTINGS, errorMessage, normalizeSettings, pullBranchForRemote, type GitView, type RemoteDraft } from "./panel/model";
import { confirmAndRun } from "./panel/operationActions";

interface GitPanelProps {
  repoRoot: string;
  visible?: boolean;
  embedded?: boolean;
  onOpenWorkspace?: (repoRoot: string) => void;
  changesView?: ReactNode;
  workspaceLogView?: ReactNode;
  workspaceBranchesView?: ReactNode;
  workspaceTagsView?: ReactNode;
  workspaceSettingsView?: ReactNode;
  workspaceSettingsAggregateView?: ReactNode | ((showCurrent: () => void) => ReactNode);
  workspaceHeader?: {
    title: string;
    summary: string;
    selectedRepoName: string;
    selectedRepoRoot: string;
    repoSelector?: ReactNode;
    branchBadge?: ReactNode;
    changeSummary?: ReactNode;
    actionControls?: ReactNode;
  };
  changeCountOverride?: number | null;
  refreshToken?: number;
}

export function GitPanel({
  repoRoot,
  visible = true,
  embedded = false,
  onOpenWorkspace,
  changesView,
  workspaceLogView,
  workspaceBranchesView,
  workspaceTagsView,
  workspaceSettingsView,
  workspaceSettingsAggregateView,
  workspaceHeader,
  changeCountOverride = null,
  refreshToken = 0,
}: GitPanelProps) {
  const setStatusMessage = useAppStore((s) => s.setStatusMessage);
  const setUiFontSize = useAppStore((s) => s.setUiFontSize);
  const [view, setView] = useState<GitView>("changes");
  const [mountedViews, setMountedViews] = useState<Set<GitView>>(() => new Set(["changes"]));
  const [snapshot, setSnapshot] = useState<GitSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [selectedBranch, setSelectedBranch] = useState<GitBranchInfo | null>(null);
  const [selectedStash, setSelectedStash] = useState<GitStashEntry | null>(null);
  const [diff, setDiff] = useState("");
  const [diffLoading, setDiffLoading] = useState(false);
  const [pair, setPair] = useState<GitBlobPair | null>(null);
  const [pairLoading, setPairLoading] = useState(false);
  const [commitMessage, setCommitMessage] = useState("");
  const [remoteName, setRemoteName] = useState("");
  const [settingsDraft, setSettingsDraft] = useState<GitRepoSettings>(EMPTY_SETTINGS);
  const [remoteDrafts, setRemoteDrafts] = useState<Record<string, RemoteDraft>>({});
  const [includeUntracked, setIncludeUntracked] = useState(false);
  // Track explicitly *unchecked* paths so new changes are committed by default.
  const [unchecked, setUnchecked] = useState<Set<string>>(() => new Set());
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [treeMode, setTreeMode] = useState(() => {
    try {
      return localStorage.getItem("taomni.git.changes.tree") !== "flat";
    } catch {
      return true;
    }
  });
  const [amendChecked, setAmendChecked] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number; path: string; } | null>(null);
  const [headerMenu, setHeaderMenu] = useState<{ x: number; y: number; } | null>(null);
  const [commitMenu, setCommitMenu] = useState<{ x: number; y: number; entry: GitLogEntry; } | null>(null);
  const [repoRefreshRevision, setRepoRefreshRevision] = useState(0);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const anchorRef = useRef<string | null>(null);
  /** The workspace header reuses this panel across repositories: only the latest refresh commits. */
  const refreshSequenceRef = useRef(0);
  const [operation, setOperation] = useState<GitOperationState | null>(null);
  const [compare, setCompare] = useState<{ refA: string; refB: string; title: string; } | null>(null);
  const [historyPath, setHistoryPath] = useState<string | null>(null);

  useEffect(() => {
    try {
      localStorage.setItem("taomni.git.changes.tree", treeMode ? "tree" : "flat");
    } catch {
      /* ignore */
    }
  }, [treeMode]);

  const repoName = useMemo(() => gitRepoName(repoRoot), [repoRoot]);
  const selectedChange = useMemo(
    () => snapshot?.changes.find((change) => change.path === selectedPath) ?? null,
    [selectedPath, snapshot],
  );
  const hasConflicts = !!snapshot?.changes.some((change) => change.conflict);
  const displayedChangeCount = changeCountOverride ?? snapshot?.changes.length ?? null;
  const setGitUiFontSize = useCallback(
    (size: number) => {
      const next = Math.min(18, Math.max(10, Math.round(size)));
      setUiFontSize(next);
      setStatusMessage(`UI font size ${next}px`);
    },
    [setStatusMessage, setUiFontSize],
  );

  useEffect(() => {
    if (!visible) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!event.ctrlKey || event.altKey || event.metaKey) return;

      const increase =
        event.key === "+" ||
        event.key === "=" ||
        event.code === "NumpadAdd";
      const decrease =
        event.key === "-" ||
        event.key === "_" ||
        event.code === "NumpadSubtract";
      const reset =
        event.key === "0" ||
        event.code === "Digit0" ||
        event.code === "Numpad0";

      if (!increase && !decrease && !reset) return;

      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();

      const current = useAppStore.getState().uiFontSize;
      if (increase) {
        setGitUiFontSize(current + 1);
      } else if (decrease) {
        setGitUiFontSize(current - 1);
      } else {
        setGitUiFontSize(12);
      }
    };

    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [setGitUiFontSize, visible]);

  useEffect(() => {
    if (!visible) return;
    const el = rootRef.current;
    if (!el) return;

    const handleWheel = (event: WheelEvent) => {
      if (!event.ctrlKey) return;
      event.preventDefault();
      event.stopPropagation();

      const current = useAppStore.getState().uiFontSize;
      if (event.deltaY < 0) {
        setGitUiFontSize(current + 1);
      } else if (event.deltaY > 0) {
        setGitUiFontSize(current - 1);
      }
    };

    el.addEventListener("wheel", handleWheel, { capture: true, passive: false });
    return () => el.removeEventListener("wheel", handleWheel, { capture: true });
  }, [setGitUiFontSize, visible]);

  const refresh = useCallback(async () => {
    const sequence = ++refreshSequenceRef.current;
    const isCurrent = () => refreshSequenceRef.current === sequence;
    setLoading(true);
    setError(null);
    try {
      const next = await gitSnapshot(repoRoot);
      if (!isCurrent()) return;
      setSnapshot(next);
      setSettingsDraft(normalizeSettings(next.settings));
      setRemoteDrafts((current) => buildRemoteDrafts(next.remotes, current));
      const paths = new Set(next.changes.map((c) => c.path));
      // Drop unchecked entries that no longer exist; everything else stays checked.
      setUnchecked((current) => new Set([...current].filter((p) => paths.has(p))));
      setSelected((current) => new Set([...current].filter((p) => paths.has(p))));
      setSelectedPath((current) =>
        current && next.changes.some((change) => change.path === current) ? current : next.changes[0]?.path ?? null,
      );
      setSelectedBranch((current) =>
        current && next.branches.some((branch) => branch.fullName === current.fullName)
          ? current
          : next.branches.find((branch) => branch.current) ?? next.branches[0] ?? null,
      );
      setSelectedStash((current) =>
        current && next.stashes.some((stash) => stash.selector === current.selector)
          ? current
          : next.stashes[0] ?? null,
      );
      const remote = selectedRemote(next);
      setRemoteName((current) => current || remote?.name || "");
      try {
        const nextOperation = await gitOperationState(repoRoot);
        if (isCurrent()) setOperation(nextOperation);
      } catch {
        if (isCurrent()) setOperation(null);
      }
    } catch (err) {
      if (!isCurrent()) return;
      const message = errorMessage(err);
      setError(message);
      setStatusMessage(message);
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, [repoRoot, setStatusMessage]);

  useEffect(() => {
    void refresh();
  }, [refresh, refreshToken, repoRefreshRevision]);

  useEffect(() => subscribeGitRepoRefresh((changedRepoRoot) => {
    if (changedRepoRoot === repoRoot) {
      setRepoRefreshRevision((current) => current + 1);
    }
  }), [repoRoot]);

  useEffect(() => {
    let cancelled = false;
    async function loadPair() {
      if (view !== "changes") {
        return;
      }
      if (!selectedChange) {
        setPair(null);
        return;
      }
      setPairLoading(true);
      try {
        // Local Changes diff: HEAD ↔ working tree (covers staged + unstaged combined;
        // untracked files have no HEAD side and show as fully added).
        const next = await gitBlobPair(
          repoRoot,
          selectedChange.path,
          "HEAD",
          GIT_REF_WORKTREE,
          selectedChange.oldPath,
        );
        if (!cancelled) setPair(next);
      } catch (err) {
        if (!cancelled) {
          setPair(null);
          setError(errorMessage(err));
        }
      } finally {
        if (!cancelled) setPairLoading(false);
      }
    }
    void loadPair();
    return () => {
      cancelled = true;
    };
  }, [repoRoot, selectedChange, view]);

  useEffect(() => {
    let cancelled = false;
    async function loadDiff() {
      if (view !== "stash") {
        return;
      }
      setDiffLoading(true);
      try {
        if (selectedStash) {
          const text = await gitStashShow(repoRoot, selectedStash.selector);
          if (!cancelled) setDiff(text || "(stash has no patch)");
        } else {
          setDiff("");
        }
      } catch (err) {
        if (!cancelled) setDiff(errorMessage(err));
      } finally {
        if (!cancelled) setDiffLoading(false);
      }
    }
    void loadDiff();
    return () => {
      cancelled = true;
    };
  }, [repoRoot, selectedStash, view]);

  const switchView = useCallback((next: GitView) => {
    setView(next);
    setMountedViews((current) => {
      if (current.has(next)) return current;
      const updated = new Set(current);
      updated.add(next);
      return updated;
    });
  }, []);

  const runAction = useCallback(
    async (label: string, action: () => Promise<void>) => {
      setBusy(true);
      setError(null);
      try {
        await action();
        await refresh();
        notifyGitRepoChanged(repoRoot);
        setStatusMessage(`${label} completed`);
      } catch (err) {
        const message = errorMessage(err);
        setError(message);
        setStatusMessage(message);
        await alertAppDialog({ title: label, message });
      } finally {
        setBusy(false);
      }
    },
    [refresh, repoRoot, setStatusMessage],
  );

  const changesList = useMemo(() => snapshot?.changes ?? [], [snapshot]);
  const orderedPaths = useMemo(
    () => [...changesList].map((c) => c.path).sort((a, b) => a.localeCompare(b)),
    [changesList],
  );
  const checked = useMemo(
    () => new Set(changesList.filter((c) => !unchecked.has(c.path)).map((c) => c.path)),
    [changesList, unchecked],
  );
  const checkedPaths = useMemo(() => [...checked], [checked]);
  const opPaths = selected.size > 0 ? [...selected] : selectedPath ? [selectedPath] : [];

  const toggleChecked = useCallback((paths: string[], value: boolean) => {
    setUnchecked((prev) => {
      const next = new Set(prev);
      for (const p of paths) {
        if (value) next.delete(p);
        else next.add(p);
      }
      return next;
    });
  }, []);

  const handleSelect = useCallback(
    (path: string, mods: { ctrl: boolean; shift: boolean; }) => {
      setSelectedPath(path);
      setSelected((prev) => {
        if (mods.ctrl) {
          const next = new Set(prev);
          if (next.has(path)) next.delete(path);
          else next.add(path);
          anchorRef.current = path;
          return next;
        }
        if (mods.shift && anchorRef.current) {
          const from = orderedPaths.indexOf(anchorRef.current);
          const to = orderedPaths.indexOf(path);
          if (from !== -1 && to !== -1) {
            const [lo, hi] = from <= to ? [from, to] : [to, from];
            return new Set(orderedPaths.slice(lo, hi + 1));
          }
        }
        anchorRef.current = path;
        return new Set([path]);
      });
    },
    [orderedPaths],
  );

  const stageSelected = () => opPaths.length && runAction("Stage", () => gitStage(repoRoot, opPaths));
  const unstageSelected = () => opPaths.length && runAction("Unstage", () => gitUnstage(repoRoot, opPaths));
  const discardPaths = (paths: string[]) => {
    if (paths.length === 0) return;
    const set = new Set(paths);
    const untracked = changesList.filter((c) => set.has(c.path) && c.status === "untracked").map((c) => c.path);
    const tracked = changesList.filter((c) => set.has(c.path) && c.status !== "untracked").map((c) => c.path);
    void confirmAndRun(
      "Discard changes",
      `Discard changes in ${paths.length} file(s)? This cannot be undone.`,
      true,
      () =>
        runAction("Discard", async () => {
          if (tracked.length) await gitDiscard(repoRoot, tracked);
          if (untracked.length) await gitCleanUntracked(repoRoot, untracked);
        }),
    );
  };
  const discardSelected = () => discardPaths(opPaths);
  const doCommit = (push: boolean) => {
    if (checkedPaths.length === 0 || !commitMessage.trim()) return;
    void runAction(
      push ? "Commit and Push" : "Commit",
      async () => {
        await gitCommit(repoRoot, commitMessage, amendChecked, checkedPaths);
        setCommitMessage("");
        setAmendChecked(false);
        if (push) {
          await gitPush(repoRoot, remoteName || null, snapshot?.currentBranch ?? null, !snapshot?.upstream);
        }
      },
    );
  };
  const syncCurrentBranch = () => {
    if (!remoteName) return;
    void runAction("Sync", async () => {
      await gitPull(repoRoot, remoteName, pullBranchForRemote(snapshot, remoteName));
      await gitPush(repoRoot, remoteName, snapshot?.currentBranch ?? null, !snapshot?.upstream);
    });
  };
  const checkoutBranchByName = () => {
    void (async () => {
      const branch = await promptAppDialog({
        title: "Checkout branch",
        label: "Checkout an existing branch",
        placeholder: "branch name",
        confirmLabel: "Checkout",
      });
      const target = branch?.trim();
      if (target) await runAction("Checkout", () => gitCheckoutBranch(repoRoot, target));
    })();
  };
  const createBranchFromHead = () => {
    void (async () => {
      const branch = await promptAppDialog({
        title: "New branch",
        label: "Create and checkout a branch",
        placeholder: "branch name",
        confirmLabel: "Create",
      });
      const target = branch?.trim();
      if (target) await runAction("New branch", () => gitCreateBranch(repoRoot, target, null, true));
    })();
  };
  const forcePushCurrentBranch = () => {
    if (!remoteName || !snapshot?.currentBranch) return;
    const branch = snapshot.currentBranch;
    const setUpstream = !snapshot.upstream;
    void confirmAndRun(
      "Force push",
      `Force push ${branch} to ${remoteName} using --force-with-lease?`,
      true,
      () => runAction("Force push", () => gitPush(repoRoot, remoteName, branch, setUpstream, true)),
    );
  };
  const resolveConflict = (side: "ours" | "theirs") => {
    const targets = changesList.filter((c) => opPaths.includes(c.path) && c.conflict).map((c) => c.path);
    if (targets.length === 0) return;
    void runAction(`Accept ${side}`, async () => {
      for (const p of targets) await gitResolveConflict(repoRoot, p, side);
    });
  };
  const markResolved = () => opPaths.length && runAction("Mark resolved", () => gitStage(repoRoot, opPaths));
  const openMenu = (path: string, event: ReactMouseEvent) => {
    event.preventDefault();
    if (!selected.has(path)) {
      setSelected(new Set([path]));
      setSelectedPath(path);
      anchorRef.current = path;
    }
    setMenu({ x: event.clientX, y: event.clientY, path });
  };

  return <GitPanelView
    rootRef={rootRef}
    embedded={embedded}
    repoRoot={repoRoot}
    repoName={repoName}
    workspaceHeader={workspaceHeader}
    snapshot={snapshot}
    displayedChangeCount={displayedChangeCount}
    remoteName={remoteName}
    setRemoteName={setRemoteName}
    busy={busy}
    runAction={runAction}
    setHeaderMenu={setHeaderMenu}
    loading={loading}
    refresh={refresh}
    view={view}
    switchView={switchView}
    error={error}
    operation={operation}
    hasConflicts={hasConflicts}
    compare={compare}
    setCompare={setCompare}
    historyPath={historyPath}
    setHistoryPath={setHistoryPath}
    setCommitMenu={setCommitMenu}
    mountedViews={mountedViews}
    changesView={changesView}
    changesList={changesList}
    treeMode={treeMode}
    setTreeMode={setTreeMode}
    checked={checked}
    checkedPaths={checkedPaths}
    selected={selected}
    selectedPath={selectedPath}
    toggleChecked={toggleChecked}
    handleSelect={handleSelect}
    openMenu={openMenu}
    pair={pair}
    pairLoading={pairLoading}
    commitMessage={commitMessage}
    setCommitMessage={setCommitMessage}
    amendChecked={amendChecked}
    setAmendChecked={setAmendChecked}
    discardPaths={discardPaths}
    doCommit={doCommit}
    workspaceLogView={workspaceLogView}
    workspaceBranchesView={workspaceBranchesView}
    selectedBranch={selectedBranch}
    setSelectedBranch={setSelectedBranch}
    workspaceTagsView={workspaceTagsView}
    selectedStash={selectedStash}
    setSelectedStash={setSelectedStash}
    diff={diff}
    diffLoading={diffLoading}
    includeUntracked={includeUntracked}
    setIncludeUntracked={setIncludeUntracked}
    workspaceSettingsAggregateView={workspaceSettingsAggregateView}
    workspaceSettingsView={workspaceSettingsView}
    settingsDraft={settingsDraft}
    setSettingsDraft={setSettingsDraft}
    remoteDrafts={remoteDrafts}
    setRemoteDrafts={setRemoteDrafts}
    headerMenu={headerMenu}
    syncCurrentBranch={syncCurrentBranch}
    checkoutBranchByName={checkoutBranchByName}
    createBranchFromHead={createBranchFromHead}
    onOpenWorkspace={onOpenWorkspace}
    forcePushCurrentBranch={forcePushCurrentBranch}
    menu={menu}
    setMenu={setMenu}
    opPaths={opPaths}
    stageSelected={stageSelected}
    unstageSelected={unstageSelected}
    discardSelected={discardSelected}
    setSelectedPath={setSelectedPath}
    resolveConflict={resolveConflict}
    markResolved={markResolved}
    commitMenu={commitMenu}
  />;
}
