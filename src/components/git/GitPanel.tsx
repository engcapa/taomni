import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { AlertTriangle, Braces, GitBranch, GitFork, GitMerge, Loader2, Ellipsis, Plus, RefreshCcw, RefreshCw, Upload, Download } from "lucide-react";
import { gitCheckoutBranch, gitCherryPick, gitOperationState, gitOperationContinue, gitOperationAbort, gitRebaseSkip, gitResolveConflict, gitCleanUntracked, gitCommit, gitCreateBranch, gitDeleteBranch, gitDeleteRemote, gitBlobPair, GIT_REF_WORKTREE, gitDiscard, gitFetch, gitMergeBranch, gitRenameBranch, gitSetUpstream, gitCreateTag, gitDeleteTag, gitPushTag, gitCheckoutTag, gitPull, gitPush, gitRepoName, gitReset, gitRevert, gitSaveRemoteAuth, gitSaveSettings, gitSetRemote, gitSnapshot, gitStage, gitStashApply, gitStashDrop, gitStashSave, gitStashShow, gitUnstage, selectedRemote, type GitBranch as GitBranchInfo, type GitBlobPair, type GitLogEntry, type GitOperationState, type GitRepoSettings, type GitSnapshot, type GitStashEntry } from "../../lib/git";
import { notifyGitRepoChanged, subscribeGitRepoRefresh } from "../../lib/gitRefresh";
import { alertAppDialog, promptAppDialog } from "../../lib/appDialogs";
import { rememberRecentBranch } from "../../lib/gitRefList";
import { ContextMenu } from "../ContextMenu";
import { CommitLog } from "./CommitLog";
import { CompareView } from "./CompareView";
import { useAppStore } from "../../stores/appStore";
import { type GitView, EMPTY_SETTINGS, type RemoteDraft, normalizeSettings, buildRemoteDrafts, errorMessage, pullBranchForRemote, operationLabel } from "./panel/model";
import { confirmAndRun, checkoutBranch } from "./panel/operationActions";
import { BranchBadge, IconButton } from "./panel/controls";
import { ChangesView } from "./panel/ChangesView";
import { BranchesView } from "./panel/BranchesView";
import { TagsView } from "./panel/TagsView";
import { StashView } from "./panel/StashView";
import { WorkspaceSettingsSwitcher, SettingsView } from "./panel/SettingsView";
import { changeMenuItems, commitMenuItems } from "./panel/menus";


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
  const [menu, setMenu] = useState<{ x: number; y: number; path: string } | null>(null);
  const [headerMenu, setHeaderMenu] = useState<{ x: number; y: number } | null>(null);
  const [commitMenu, setCommitMenu] = useState<{ x: number; y: number; entry: GitLogEntry } | null>(null);
  const [repoRefreshRevision, setRepoRefreshRevision] = useState(0);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const anchorRef = useRef<string | null>(null);
  /** The workspace header reuses this panel across repositories: only the latest refresh commits. */
  const refreshSequenceRef = useRef(0);
  const [operation, setOperation] = useState<GitOperationState | null>(null);
  const [compare, setCompare] = useState<{ refA: string; refB: string; title: string } | null>(null);
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
    (path: string, mods: { ctrl: boolean; shift: boolean }) => {
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

  return (
    <div
      ref={rootRef}
      data-testid="git-panel"
      className="h-full w-full min-h-0 flex flex-col bg-[var(--taomni-bg)] text-[var(--taomni-text)]"
    >
      <header className={`${embedded ? "h-9 px-2" : "h-10 px-3"} shrink-0 flex items-center gap-2 border-b border-[var(--taomni-divider)] bg-[var(--taomni-quick-bg)]`}>
        {embedded ? (
          <span className="max-w-40 truncate text-[11px] text-[var(--taomni-text-muted)]" title={repoRoot}>
            {repoName}
          </span>
        ) : workspaceHeader ? (
          <>
            <GitBranch className="w-4 h-4 text-[var(--taomni-accent)]" />
            {workspaceHeader.repoSelector ? (
              <>
                <span className="shrink-0 font-semibold leading-4">Git</span>
                {workspaceHeader.repoSelector}
              </>
            ) : (
              <>
                <div className="min-w-0">
                  <div className="font-semibold leading-4 truncate">Workspace Git · {workspaceHeader.title}</div>
                  <div className="text-[11px] text-[var(--taomni-text-muted)] truncate max-w-[520px]">{workspaceHeader.summary}</div>
                </div>
                <span className="taomni-divider-v h-5 mx-1" />
                <span
                  className="inline-flex items-center gap-1 h-6 max-w-56 rounded bg-[var(--taomni-hover)] px-2 text-[11px]"
                  title={workspaceHeader.selectedRepoRoot}
                >
                  <span className="shrink-0 text-[var(--taomni-text-muted)]">Repository detail</span>
                  <span className="min-w-0 truncate font-medium">{workspaceHeader.selectedRepoName}</span>
                </span>
              </>
            )}
          </>
        ) : (
          <>
            <GitBranch className="w-4 h-4 text-[var(--taomni-accent)]" />
            <div className="min-w-0">
              <div className="font-semibold leading-4 truncate">Git · {repoName}</div>
              <div className="text-[11px] text-[var(--taomni-text-muted)] truncate max-w-[520px]">{repoRoot}</div>
            </div>
            <span className="taomni-divider-v h-5 mx-1" />
          </>
        )}
        {workspaceHeader?.branchBadge ?? <BranchBadge snapshot={snapshot} />}
        {workspaceHeader?.changeSummary ?? (displayedChangeCount !== null && (
          <span className="text-[11px] text-[var(--taomni-text-muted)]">
            {displayedChangeCount} changes
            {snapshot && (snapshot.ahead || snapshot.behind) ? ` · ↑${snapshot.ahead} ↓${snapshot.behind}` : ""}
          </span>
        ))}
        <div className="flex-1" />
        {workspaceHeader?.actionControls ?? (
          <>
            <select
              className="taomni-input h-7 w-32"
              value={remoteName}
              onChange={(event) => setRemoteName(event.target.value)}
              disabled={!snapshot?.remotes.length}
            >
              {snapshot?.remotes.length ? snapshot.remotes.map((remote) => (
                <option key={remote.name} value={remote.name}>{remote.name}</option>
              )) : <option value="">No remote</option>}
            </select>
            <IconButton label="Fetch" icon={<Download className="w-3.5 h-3.5" />} disabled={busy || !remoteName} onClick={() => void runAction("Fetch", () => gitFetch(repoRoot, remoteName))} />
            <IconButton label="Pull" icon={<GitMerge className="w-3.5 h-3.5" />} disabled={busy || !remoteName} onClick={() => void runAction("Pull", () => gitPull(repoRoot, remoteName, pullBranchForRemote(snapshot, remoteName)))} />
            <IconButton label="Push" icon={<Upload className="w-3.5 h-3.5" />} disabled={busy || !remoteName} onClick={() => void runAction("Push", () => gitPush(repoRoot, remoteName, snapshot?.currentBranch ?? null, !snapshot?.upstream))} />
            <button
              type="button"
              className="taomni-btn h-7 w-7 inline-flex items-center justify-center"
              title="More Git actions"
              aria-label="More Git actions"
              onClick={(event) => setHeaderMenu({ x: event.clientX, y: event.clientY })}
            >
              <Ellipsis className="w-3.5 h-3.5 text-[var(--taomni-text)]" />
            </button>
            <IconButton label="Refresh" icon={<RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />} disabled={loading} onClick={() => void refresh()} />
          </>
        )}
      </header>

      <nav className="h-9 shrink-0 flex items-center gap-1 px-3 border-b border-[var(--taomni-divider)]">
        {(["changes", "log", "branches", "tags", "stash", "settings"] as GitView[]).map((item) => (
          <button
            key={item}
            type="button"
            data-testid={item === "log" ? "git-log-tab" : undefined}
            className={`h-7 px-3 rounded text-[12px] capitalize ${view === item ? "bg-[var(--taomni-accent)] text-white" : "hover:bg-[var(--taomni-hover)]"}`}
            onClick={() => switchView(item)}
          >
            {item}
          </button>
        ))}
        {(busy || loading) && <Loader2 className="w-3.5 h-3.5 animate-spin ml-1" />}
        {error && <span className="ml-2 text-[11px] text-red-500 truncate">{error}</span>}
      </nav>

      {(operation && operation.kind !== "none") || hasConflicts ? (
        <div className="shrink-0 flex items-center gap-2 px-3 py-1.5 border-b border-amber-500/30 bg-amber-500/10 text-[12px]">
          <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0" />
          <span className="min-w-0">
            {operationLabel(operation)}
            {operation?.conflictedPaths.length
              ? ` — ${operation.conflictedPaths.length} conflicted file(s). Resolve and stage them, then continue.`
              : " Resolve conflicts, stage them, then continue or abort."}
          </span>
          <div className="flex-1" />
          {operation && operation.kind !== "none" ? (
            <>
              <button
                className="taomni-btn h-7 px-2"
                type="button"
                disabled={busy}
                onClick={() => void runAction(`Continue ${operation.kind}`, () => gitOperationContinue(repoRoot, operation.kind))}
              >
                Continue
              </button>
              {operation.kind === "rebase" && (
                <button
                  className="taomni-btn h-7 px-2"
                  type="button"
                  disabled={busy}
                  onClick={() => void runAction("Skip", () => gitRebaseSkip(repoRoot))}
                >
                  Skip
                </button>
              )}
              <button
                className="taomni-btn h-7 px-2 text-red-500"
                type="button"
                disabled={busy}
                onClick={() => void runAction(`Abort ${operation.kind}`, () => gitOperationAbort(repoRoot, operation.kind))}
              >
                Abort
              </button>
            </>
          ) : null}
        </div>
      ) : null}

      <main className="flex-1 min-h-0">
        {compare ? (
          <CompareView
            repoRoot={repoRoot}
            refA={compare.refA}
            refB={compare.refB}
            title={compare.title}
            onClose={() => setCompare(null)}
          />
        ) : historyPath ? (
            <CommitLog
              repoRoot={repoRoot}
              headOid={snapshot?.headOid ?? null}
              branches={snapshot?.branches ?? []}
              busy={busy}
              pathFilter={historyPath}
              onClose={() => setHistoryPath(null)}
            onContextMenu={(entry, x, y) => setCommitMenu({ x, y, entry })}
          />
        ) : (
        <>
        {mountedViews.has("changes") && (
          <div className="h-full min-h-0" style={{ display: view === "changes" ? "block" : "none" }}>
          {changesView ?? (
            <ChangesView
              changes={changesList}
              treeMode={treeMode}
              setTreeMode={setTreeMode}
              checked={checked}
              checkedCount={checkedPaths.length}
              selected={selected}
              activePath={selectedPath}
              onToggleChecked={toggleChecked}
              onSelect={handleSelect}
              onContextMenu={openMenu}
              pair={pair}
              pairLoading={pairLoading}
              commitMessage={commitMessage}
              setCommitMessage={setCommitMessage}
              amendChecked={amendChecked}
              setAmendChecked={setAmendChecked}
              busy={busy}
              hasRemote={!!remoteName}
              stagePaths={(paths) => {
                if (paths.length) void runAction("Stage", () => gitStage(repoRoot, paths));
              }}
              unstagePaths={(paths) => {
                if (paths.length) void runAction("Unstage", () => gitUnstage(repoRoot, paths));
              }}
              discardPaths={discardPaths}
              commit={() => doCommit(false)}
              commitAndPush={() => doCommit(true)}
            />
          )}
          </div>
        )}
        {mountedViews.has("log") && (
          <div className="h-full min-h-0 git-log-view" style={{ display: view === "log" ? "block" : "none" }}>
            {workspaceLogView ?? (
              <CommitLog
                repoRoot={repoRoot}
                headOid={snapshot?.headOid ?? null}
                branches={snapshot?.branches ?? []}
                busy={busy}
                onContextMenu={(entry, x, y) => setCommitMenu({ x, y, entry })}
              />
            )}
          </div>
        )}
        {mountedViews.has("branches") && (
          <div className="h-full min-h-0" style={{ display: view === "branches" ? "block" : "none" }}>
          {workspaceBranchesView ?? <BranchesView
            snapshot={snapshot}
            selected={selectedBranch}
            setSelected={setSelectedBranch}
            busy={busy}
            onCreate={async () => {
              const name = await promptAppDialog({ title: "Create branch", label: "Branch name" });
              if (name) {
                await runAction("Create branch", async () => {
                  await gitCreateBranch(repoRoot, name, selectedBranch?.name ?? null, true);
                  rememberRecentBranch(repoRoot, name);
                });
              }
            }}
            onCheckout={(branch) => void checkoutBranch(repoRoot, branch, runAction)}
            onMerge={(branch) => void confirmAndRun("Merge branch", `Merge ${branch.name} into current branch?`, false, () => runAction("Merge", () => gitMergeBranch(repoRoot, branch.name)))}
            onDelete={(branch) => void confirmAndRun("Delete branch", `Delete local branch ${branch.name}?`, true, () => runAction("Delete branch", () => gitDeleteBranch(repoRoot, branch.name, false)))}
            onRename={async (branch) => {
              const next = await promptAppDialog({ title: "Rename branch", label: "New name", initialValue: branch.name });
              if (next && next !== branch.name) {
                await runAction("Rename branch", async () => {
                  await gitRenameBranch(repoRoot, branch.name, next);
                  rememberRecentBranch(repoRoot, next);
                });
              }
            }}
            onPush={(branch) => void runAction("Push branch", () => gitPush(repoRoot, remoteName || null, branch.name, !branch.upstream))}
            onSetUpstream={async (branch) => {
              const up = await promptAppDialog({
                title: "Set upstream",
                label: "Upstream (remote/branch, empty to clear)",
                initialValue: branch.upstream ?? `${remoteName || "origin"}/${branch.name}`,
                allowEmpty: true,
              });
              if (up !== null) await runAction("Set upstream", () => gitSetUpstream(repoRoot, branch.name, up || null));
            }}
            onCompare={(branch) => {
              if (!snapshot?.currentBranch) return;
              setCompare({ refA: branch.name, refB: snapshot.currentBranch, title: `${branch.name} → ${snapshot.currentBranch}` });
            }}
          />}
          </div>
        )}
        {mountedViews.has("tags") && (
          <div className="h-full min-h-0" style={{ display: view === "tags" ? "block" : "none" }}>
          {workspaceTagsView ?? <TagsView
            snapshot={snapshot}
            busy={busy}
            hasRemote={!!remoteName}
            onCreate={async () => {
              const name = await promptAppDialog({ title: "Create tag", label: "Tag name" });
              if (!name) return;
              const message = await promptAppDialog({ title: "Create tag", label: "Annotation message (empty = lightweight)", allowEmpty: true });
              await runAction("Create tag", () => gitCreateTag(repoRoot, name, null, message || null));
            }}
            onCheckout={(tag) => void confirmAndRun("Checkout tag", `Checkout ${tag.name}? This detaches HEAD.`, false, () => runAction("Checkout tag", () => gitCheckoutTag(repoRoot, tag.name)))}
            onDelete={(tag) => void confirmAndRun("Delete tag", `Delete tag ${tag.name}?`, true, () => runAction("Delete tag", () => gitDeleteTag(repoRoot, tag.name)))}
            onPush={(tag) => void runAction("Push tag", () => gitPushTag(repoRoot, remoteName || null, tag.name, false))}
          />}
          </div>
        )}
        {mountedViews.has("stash") && (
          <div className="h-full min-h-0" style={{ display: view === "stash" ? "block" : "none" }}>
          <StashView
            snapshot={snapshot}
            selected={selectedStash}
            setSelected={setSelectedStash}
            diff={diff}
            diffLoading={diffLoading}
            busy={busy}
            includeUntracked={includeUntracked}
            setIncludeUntracked={setIncludeUntracked}
            onSave={async () => {
              const message = await promptAppDialog({ title: "Stash changes", label: "Message", allowEmpty: true });
              if (message !== null) await runAction("Stash", () => gitStashSave(repoRoot, message, includeUntracked));
            }}
            onApply={() => selectedStash && void runAction("Apply stash", () => gitStashApply(repoRoot, selectedStash.selector, false))}
            onPop={() => selectedStash && void runAction("Pop stash", () => gitStashApply(repoRoot, selectedStash.selector, true))}
            onDrop={() => selectedStash && void confirmAndRun("Drop stash", `Drop ${selectedStash.selector}?`, true, () => runAction("Drop stash", () => gitStashDrop(repoRoot, selectedStash.selector)))}
          />
          </div>
        )}
        {mountedViews.has("settings") && (
          <div className="h-full min-h-0" style={{ display: view === "settings" ? "block" : "none" }}>
            <WorkspaceSettingsSwitcher
              aggregateView={workspaceSettingsAggregateView}
              currentView={workspaceSettingsView ?? <SettingsView
                snapshot={snapshot}
                settings={settingsDraft}
                setSettings={setSettingsDraft}
                remoteDrafts={remoteDrafts}
                setRemoteDrafts={setRemoteDrafts}
                busy={busy}
                onSaveSettings={() => void runAction("Save Git settings", () => gitSaveSettings(repoRoot, settingsDraft))}
                onSaveRemote={(remote, draft) => void runAction("Save remote", async () => {
                  await gitSetRemote(repoRoot, draft.name || remote.name, draft.fetchUrl, draft.pushUrl);
                  await gitSaveRemoteAuth(repoRoot, draft.name || remote.name, draft.username, draft.token, false);
                  setRemoteDrafts({ ...remoteDrafts, [remote.name]: { ...draft, token: "" } });
                })}
                onClearToken={(remote) => void runAction("Clear remote token", async () => {
                  await gitSaveRemoteAuth(repoRoot, remote.name, remoteDrafts[remote.name]?.username ?? remote.username, null, true);
                })}
                onDeleteRemote={(remote) => void confirmAndRun("Delete remote", `Delete remote ${remote.name}?`, true, () => runAction("Delete remote", () => gitDeleteRemote(repoRoot, remote.name)))}
                onAddRemote={async () => {
                  const name = await promptAppDialog({ title: "Add remote", label: "Remote name", initialValue: "origin" });
                  if (!name) return;
                  const url = await promptAppDialog({ title: "Add remote", label: "Remote URL" });
                  if (!url) return;
                  await runAction("Add remote", () => gitSetRemote(repoRoot, name, url, null));
                }}
              />}
            />
          </div>
        )}
        </>
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
              disabled: busy || !remoteName,
              onClick: syncCurrentBranch,
            },
            {
              label: "Checkout branch...",
              icon: <GitFork className="w-3.5 h-3.5" />,
              disabled: busy,
              onClick: checkoutBranchByName,
            },
            {
              label: "New branch...",
              icon: <Plus className="w-3.5 h-3.5" />,
              disabled: busy,
              onClick: createBranchFromHead,
            },
            {
              label: "Open code workspace",
              icon: <Braces className="w-3.5 h-3.5" />,
              disabled: !onOpenWorkspace,
              onClick: () => onOpenWorkspace?.(repoRoot),
            },
            { label: "", separator: true },
            {
              label: "Force push with lease...",
              icon: <Upload className="w-3.5 h-3.5" />,
              disabled: busy || !remoteName || !snapshot?.currentBranch,
              danger: true,
              onClick: forcePushCurrentBranch,
            },
          ]}
        />
      )}
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={changeMenuItems({
            repoRoot,
            opPaths,
            conflicted: changesList.some((c) => opPaths.includes(c.path) && c.conflict),
            onStage: stageSelected,
            onUnstage: unstageSelected,
            onDiscard: discardSelected,
            onShowDiff: () => setSelectedPath(menu.path),
            onShowHistory: () => setHistoryPath(menu.path),
            onAcceptOurs: () => resolveConflict("ours"),
            onAcceptTheirs: () => resolveConflict("theirs"),
            onMarkResolved: markResolved,
          })}
        />
      )}
      {commitMenu && (
        <ContextMenu
          x={commitMenu.x}
          y={commitMenu.y}
          onClose={() => setCommitMenu(null)}
          items={commitMenuItems(commitMenu.entry, {
            onCherryPick: (e) =>
              void confirmAndRun("Cherry-pick", `Cherry-pick ${e.shortOid}: ${e.subject}?`, false, () =>
                runAction("Cherry-pick", () => gitCherryPick(repoRoot, e.oid))),
            onRevert: (e) =>
              void confirmAndRun("Revert commit", `Revert ${e.shortOid}: ${e.subject}?`, false, () =>
                runAction("Revert", () => gitRevert(repoRoot, e.oid))),
            onReset: (e, mode) =>
              void confirmAndRun(`Reset ${mode}`, `Reset current branch to ${e.shortOid} using --${mode}? `, mode === "hard", () =>
                runAction("Reset", () => gitReset(repoRoot, e.oid, mode))),
            onNewBranch: async (e) => {
              const name = await promptAppDialog({ title: "New branch from commit", label: "Branch name" });
              if (name) await runAction("Create branch", () => gitCreateBranch(repoRoot, name, e.oid, true));
            },
          })}
        />
      )}
    </div>
  );
}
