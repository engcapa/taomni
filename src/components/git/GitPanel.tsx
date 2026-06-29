import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  GitBranch,
  GitCommitHorizontal,
  GitFork,
  GitMerge,
  Loader2,
  Plus,
  RefreshCw,
  Save,
  Settings,
  Trash2,
  Upload,
  Download,
} from "lucide-react";
import { Group as PanelGroup, Panel, Separator as PanelResizeHandle } from "react-resizable-panels";
import {
  gitChangeLabel,
  gitCheckoutBranch,
  gitCherryPick,
  gitCherryPickAbort,
  gitCherryPickContinue,
  gitCleanUntracked,
  gitCommit,
  gitCreateBranch,
  gitDeleteBranch,
  gitDeleteRemote,
  gitDiff,
  gitDiscard,
  gitFetch,
  gitLog,
  gitMergeBranch,
  gitPull,
  gitPush,
  gitRepoName,
  gitReset,
  gitRevert,
  gitSaveRemoteAuth,
  gitSaveSettings,
  gitSetRemote,
  gitSnapshot,
  gitStage,
  gitStashApply,
  gitStashDrop,
  gitStashSave,
  gitStashShow,
  gitUnstage,
  selectedRemote,
  type GitBranch as GitBranchInfo,
  type GitChange,
  type GitLogEntry,
  type GitRemote,
  type GitRepoSettings,
  type GitResetMode,
  type GitSnapshot,
  type GitStashEntry,
} from "../../lib/git";
import { alertAppDialog, confirmAppDialog, promptAppDialog } from "../../lib/appDialogs";
import { useAppStore } from "../../stores/appStore";

interface GitPanelProps {
  repoRoot: string;
}

type GitView = "changes" | "log" | "branches" | "stash" | "settings";

const EMPTY_SETTINGS: GitRepoSettings = {
  userName: null,
  userEmail: null,
  httpProxy: null,
  httpsProxy: null,
  pullRebase: null,
  pushDefault: null,
  coreAutocrlf: null,
  coreFilemode: null,
  commitGpgsign: null,
};

export function GitPanel({ repoRoot }: GitPanelProps) {
  const setStatusMessage = useAppStore((s) => s.setStatusMessage);
  const [view, setView] = useState<GitView>("changes");
  const [snapshot, setSnapshot] = useState<GitSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [selectedLog, setSelectedLog] = useState<GitLogEntry | null>(null);
  const [selectedBranch, setSelectedBranch] = useState<GitBranchInfo | null>(null);
  const [selectedStash, setSelectedStash] = useState<GitStashEntry | null>(null);
  const [diff, setDiff] = useState("");
  const [diffLoading, setDiffLoading] = useState(false);
  const [logEntries, setLogEntries] = useState<GitLogEntry[]>([]);
  const [commitMessage, setCommitMessage] = useState("");
  const [remoteName, setRemoteName] = useState("");
  const [settingsDraft, setSettingsDraft] = useState<GitRepoSettings>(EMPTY_SETTINGS);
  const [remoteDrafts, setRemoteDrafts] = useState<Record<string, RemoteDraft>>({});
  const [includeUntracked, setIncludeUntracked] = useState(false);

  const repoName = useMemo(() => gitRepoName(repoRoot), [repoRoot]);
  const selectedChange = useMemo(
    () => snapshot?.changes.find((change) => change.path === selectedPath) ?? null,
    [selectedPath, snapshot],
  );
  const hasConflicts = !!snapshot?.changes.some((change) => change.conflict);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const next = await gitSnapshot(repoRoot);
      setSnapshot(next);
      setSettingsDraft(normalizeSettings(next.settings));
      setRemoteDrafts((current) => buildRemoteDrafts(next.remotes, current));
      if (!selectedPath || !next.changes.some((change) => change.path === selectedPath)) {
        setSelectedPath(next.changes[0]?.path ?? null);
      }
      if (!selectedBranch || !next.branches.some((branch) => branch.fullName === selectedBranch.fullName)) {
        setSelectedBranch(next.branches.find((branch) => branch.current) ?? next.branches[0] ?? null);
      }
      if (!selectedStash || !next.stashes.some((stash) => stash.selector === selectedStash.selector)) {
        setSelectedStash(next.stashes[0] ?? null);
      }
      const remote = selectedRemote(next);
      setRemoteName((current) => current || remote?.name || "");
    } catch (err) {
      const message = errorMessage(err);
      setError(message);
      setStatusMessage(message);
    } finally {
      setLoading(false);
    }
  }, [repoRoot, selectedBranch, selectedPath, selectedStash, setStatusMessage]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (view !== "log") return;
    let cancelled = false;
    gitLog(repoRoot, 160)
      .then((entries) => {
        if (cancelled) return;
        setLogEntries(entries);
        setSelectedLog((current) =>
          current && entries.some((entry) => entry.oid === current.oid)
            ? current
            : entries[0] ?? null,
        );
      })
      .catch((err) => setError(errorMessage(err)));
    return () => {
      cancelled = true;
    };
  }, [repoRoot, snapshot?.headOid, view]);

  useEffect(() => {
    let cancelled = false;
    async function loadDiff() {
      setDiffLoading(true);
      try {
        if (view === "changes" && selectedChange) {
          const text = selectedChange.staged && !selectedChange.unstaged
            ? await gitDiff(repoRoot, selectedChange.path, true)
            : await gitDiff(repoRoot, selectedChange.path, false);
          if (!cancelled) setDiff(text || "(no diff available)");
        } else if (view === "log" && selectedLog) {
          const text = await gitDiff(repoRoot, null, false, selectedLog.oid);
          if (!cancelled) setDiff(text || "(commit has no patch)");
        } else if (view === "stash" && selectedStash) {
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
  }, [repoRoot, selectedChange, selectedLog, selectedStash, view]);

  const runAction = useCallback(
    async (label: string, action: () => Promise<void>, options: { refreshLog?: boolean } = {}) => {
      setBusy(true);
      setError(null);
      try {
        await action();
        await refresh();
        if (options.refreshLog || view === "log") {
          const entries = await gitLog(repoRoot, 160);
          setLogEntries(entries);
          setSelectedLog((current) =>
            current && entries.some((entry) => entry.oid === current.oid)
              ? current
              : entries[0] ?? null,
          );
        }
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
    [refresh, repoRoot, setStatusMessage, view],
  );

  const selectedPaths = selectedPath ? [selectedPath] : [];

  const stageAll = () => runAction("Stage all", () => gitStage(repoRoot, snapshot?.changes.map((c) => c.path) ?? []));
  const unstageAll = () =>
    runAction("Unstage all", () => gitUnstage(repoRoot, snapshot?.changes.filter((c) => c.staged).map((c) => c.path) ?? []));

  return (
    <div data-testid="git-panel" className="h-full w-full min-h-0 flex flex-col bg-[var(--taomni-bg)] text-[var(--taomni-text)]">
      <header className="h-10 shrink-0 flex items-center gap-2 px-3 border-b border-[var(--taomni-divider)] bg-[var(--taomni-quick-bg)]">
        <GitBranch className="w-4 h-4 text-[var(--taomni-accent)]" />
        <div className="min-w-0">
          <div className="font-semibold leading-4 truncate">Git · {repoName}</div>
          <div className="text-[11px] text-[var(--taomni-text-muted)] truncate max-w-[520px]">{repoRoot}</div>
        </div>
        <span className="taomni-divider-v h-5 mx-1" />
        <BranchBadge snapshot={snapshot} />
        {snapshot && (
          <span className="text-[11px] text-[var(--taomni-text-muted)]">
            {snapshot.changes.length} changes
            {snapshot.ahead || snapshot.behind ? ` · ↑${snapshot.ahead} ↓${snapshot.behind}` : ""}
          </span>
        )}
        <div className="flex-1" />
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
        <IconButton label="Pull" icon={<GitMerge className="w-3.5 h-3.5" />} disabled={busy || !remoteName} onClick={() => void runAction("Pull", () => gitPull(repoRoot, remoteName))} />
        <IconButton label="Push" icon={<Upload className="w-3.5 h-3.5" />} disabled={busy || !remoteName} onClick={() => void runAction("Push", () => gitPush(repoRoot, remoteName, snapshot?.currentBranch ?? null, !snapshot?.upstream))} />
        <IconButton label="Refresh" icon={<RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />} disabled={loading} onClick={() => void refresh()} />
      </header>

      <nav className="h-9 shrink-0 flex items-center gap-1 px-3 border-b border-[var(--taomni-divider)]">
        {(["changes", "log", "branches", "stash", "settings"] as GitView[]).map((item) => (
          <button
            key={item}
            type="button"
            className={`h-7 px-3 rounded text-[12px] capitalize ${view === item ? "bg-[var(--taomni-accent)] text-white" : "hover:bg-[var(--taomni-hover)]"}`}
            onClick={() => setView(item)}
          >
            {item}
          </button>
        ))}
        {(busy || loading) && <Loader2 className="w-3.5 h-3.5 animate-spin ml-1" />}
        {error && <span className="ml-2 text-[11px] text-red-500 truncate">{error}</span>}
      </nav>

      {hasConflicts && (
        <div className="h-9 shrink-0 flex items-center gap-2 px-3 border-b border-amber-500/30 bg-amber-500/10 text-[12px]">
          <AlertTriangle className="w-4 h-4 text-amber-600" />
          <span>Conflict state detected. Resolve files, stage them, then continue or abort the active operation.</span>
          <div className="flex-1" />
          <button className="taomni-btn h-7 px-2" type="button" onClick={() => void runAction("Continue cherry-pick", () => gitCherryPickContinue(repoRoot), { refreshLog: true })}>
            Continue cherry-pick
          </button>
          <button className="taomni-btn h-7 px-2" type="button" onClick={() => void runAction("Abort cherry-pick", () => gitCherryPickAbort(repoRoot), { refreshLog: true })}>
            Abort cherry-pick
          </button>
        </div>
      )}

      <main className="flex-1 min-h-0">
        {view === "changes" && (
          <ChangesView
            snapshot={snapshot}
            selectedPath={selectedPath}
            setSelectedPath={setSelectedPath}
            diff={diff}
            diffLoading={diffLoading}
            commitMessage={commitMessage}
            setCommitMessage={setCommitMessage}
            busy={busy}
            stageAll={stageAll}
            unstageAll={unstageAll}
            stageSelected={() => void runAction("Stage", () => gitStage(repoRoot, selectedPaths))}
            unstageSelected={() => void runAction("Unstage", () => gitUnstage(repoRoot, selectedPaths))}
            discardSelected={() => void confirmAndRun("Discard changes", `Discard changes in ${selectedPath}?`, true, () => runAction("Discard", () => selectedChange?.status === "untracked" ? gitCleanUntracked(repoRoot, selectedPaths) : gitDiscard(repoRoot, selectedPaths)))}
            commit={() => void runAction("Commit", async () => {
              await gitCommit(repoRoot, commitMessage, false);
              setCommitMessage("");
            }, { refreshLog: true })}
            amend={() => void runAction("Amend", async () => {
              await gitCommit(repoRoot, commitMessage, true);
              setCommitMessage("");
            }, { refreshLog: true })}
          />
        )}
        {view === "log" && (
          <LogView
            entries={logEntries}
            selected={selectedLog}
            setSelected={setSelectedLog}
            diff={diff}
            diffLoading={diffLoading}
            busy={busy}
            onCherryPick={() => selectedLog && void confirmAndRun("Cherry-pick", `Cherry-pick ${selectedLog.shortOid}: ${selectedLog.subject}?`, false, () => runAction("Cherry-pick", () => gitCherryPick(repoRoot, selectedLog.oid), { refreshLog: true }))}
            onRevert={() => selectedLog && void confirmAndRun("Revert commit", `Revert ${selectedLog.shortOid}: ${selectedLog.subject}?`, false, () => runAction("Revert", () => gitRevert(repoRoot, selectedLog.oid), { refreshLog: true }))}
            onReset={(mode) => selectedLog && void confirmAndRun(`Reset ${mode}`, `Reset current branch to ${selectedLog.shortOid} using --${mode}?`, mode === "hard", () => runAction("Reset", () => gitReset(repoRoot, selectedLog.oid, mode), { refreshLog: true }))}
          />
        )}
        {view === "branches" && (
          <BranchesView
            snapshot={snapshot}
            selected={selectedBranch}
            setSelected={setSelectedBranch}
            busy={busy}
            onCreate={async () => {
              const name = await promptAppDialog({ title: "Create branch", label: "Branch name" });
              if (name) await runAction("Create branch", () => gitCreateBranch(repoRoot, name, selectedBranch?.name ?? null, true), { refreshLog: true });
            }}
            onCheckout={() => selectedBranch && void checkoutBranch(repoRoot, selectedBranch, runAction)}
            onMerge={() => selectedBranch && void confirmAndRun("Merge branch", `Merge ${selectedBranch.name} into current branch?`, false, () => runAction("Merge", () => gitMergeBranch(repoRoot, selectedBranch.name), { refreshLog: true }))}
            onDelete={() => selectedBranch && void confirmAndRun("Delete branch", `Delete local branch ${selectedBranch.name}?`, true, () => runAction("Delete branch", () => gitDeleteBranch(repoRoot, selectedBranch.name, false)))}
          />
        )}
        {view === "stash" && (
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
        )}
        {view === "settings" && (
          <SettingsView
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
          />
        )}
      </main>
    </div>
  );
}

function ChangesView({
  snapshot,
  selectedPath,
  setSelectedPath,
  diff,
  diffLoading,
  commitMessage,
  setCommitMessage,
  busy,
  stageAll,
  unstageAll,
  stageSelected,
  unstageSelected,
  discardSelected,
  commit,
  amend,
}: {
  snapshot: GitSnapshot | null;
  selectedPath: string | null;
  setSelectedPath: (path: string) => void;
  diff: string;
  diffLoading: boolean;
  commitMessage: string;
  setCommitMessage: (message: string) => void;
  busy: boolean;
  stageAll: () => void;
  unstageAll: () => void;
  stageSelected: () => void;
  unstageSelected: () => void;
  discardSelected: () => void;
  commit: () => void;
  amend: () => void;
}) {
  const changes = snapshot?.changes ?? [];
  const selected = changes.find((change) => change.path === selectedPath) ?? null;
  return (
    <PanelGroup orientation="horizontal" id="git-changes-layout">
      <Panel id="changes-list" defaultSize={32} minSize={22} className="min-w-0 min-h-0 flex flex-col border-r border-[var(--taomni-divider)]">
        <div className="h-9 shrink-0 flex items-center gap-1 px-2 border-b border-[var(--taomni-divider)]">
          <button className="taomni-btn h-7 px-2" type="button" disabled={busy || changes.length === 0} onClick={stageAll}>Stage all</button>
          <button className="taomni-btn h-7 px-2" type="button" disabled={busy || !changes.some((c) => c.staged)} onClick={unstageAll}>Unstage all</button>
        </div>
        <div className="flex-1 min-h-0 overflow-auto">
          {changes.length === 0 ? (
            <EmptyState title="No local changes" />
          ) : changes.map((change) => (
            <button
              key={`${change.status}-${change.path}`}
              type="button"
              className={`w-full px-3 py-2 flex items-center gap-2 text-left border-b border-[var(--taomni-divider)] hover:bg-[var(--taomni-hover)] ${selectedPath === change.path ? "bg-[var(--taomni-hover)]" : ""}`}
              onClick={() => setSelectedPath(change.path)}
            >
              <StatusPill change={change} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[12px]">{change.path}</div>
                {change.oldPath && <div className="truncate text-[11px] text-[var(--taomni-text-muted)]">from {change.oldPath}</div>}
              </div>
            </button>
          ))}
        </div>
        <div className="shrink-0 border-t border-[var(--taomni-divider)] p-2 space-y-2">
          <textarea
            className="taomni-input w-full min-h-20 resize-none"
            value={commitMessage}
            placeholder="Commit message"
            onChange={(event) => setCommitMessage(event.target.value)}
          />
          <div className="flex items-center gap-1">
            <button className="taomni-btn h-7 px-2" type="button" disabled={busy || !commitMessage.trim()} onClick={commit}>Commit</button>
            <button className="taomni-btn h-7 px-2" type="button" disabled={busy || !commitMessage.trim()} onClick={amend}>Amend</button>
          </div>
        </div>
      </Panel>
      <PanelResizeHandle className="w-[3px] bg-[var(--taomni-divider)] hover:bg-[var(--taomni-accent)] cursor-col-resize" />
      <Panel id="changes-diff" defaultSize={68} minSize={35} className="min-w-0 min-h-0 flex flex-col">
        <div className="h-9 shrink-0 flex items-center gap-1 px-2 border-b border-[var(--taomni-divider)]">
          <span className="font-semibold truncate text-[12px]">{selected?.path ?? "Diff"}</span>
          <div className="flex-1" />
          <button className="taomni-btn h-7 px-2" type="button" disabled={busy || !selected} onClick={stageSelected}>Stage</button>
          <button className="taomni-btn h-7 px-2" type="button" disabled={busy || !selected?.staged} onClick={unstageSelected}>Unstage</button>
          <button className="taomni-btn h-7 px-2 text-red-500" type="button" disabled={busy || !selected} onClick={discardSelected}>Discard</button>
        </div>
        <DiffPane diff={diff} loading={diffLoading} />
      </Panel>
    </PanelGroup>
  );
}

function LogView({
  entries,
  selected,
  setSelected,
  diff,
  diffLoading,
  busy,
  onCherryPick,
  onRevert,
  onReset,
}: {
  entries: GitLogEntry[];
  selected: GitLogEntry | null;
  setSelected: (entry: GitLogEntry) => void;
  diff: string;
  diffLoading: boolean;
  busy: boolean;
  onCherryPick: () => void;
  onRevert: () => void;
  onReset: (mode: GitResetMode) => void;
}) {
  return (
    <PanelGroup orientation="horizontal" id="git-log-layout">
      <Panel id="log-list" defaultSize={38} minSize={26} className="min-w-0 min-h-0 flex flex-col border-r border-[var(--taomni-divider)]">
        <div className="h-9 shrink-0 flex items-center px-3 border-b border-[var(--taomni-divider)] text-[12px] font-semibold">Commit Log</div>
        <div className="flex-1 min-h-0 overflow-auto">
          {entries.length === 0 ? <EmptyState title="No commits" /> : entries.map((entry) => (
            <button
              key={entry.oid}
              type="button"
              className={`w-full px-3 py-2 text-left border-b border-[var(--taomni-divider)] hover:bg-[var(--taomni-hover)] ${selected?.oid === entry.oid ? "bg-[var(--taomni-hover)]" : ""}`}
              onClick={() => setSelected(entry)}
            >
              <div className="flex items-center gap-2 min-w-0">
                <span className="taomni-mono text-[11px] text-[var(--taomni-accent)]">{entry.shortOid}</span>
                <span className="truncate text-[12px]">{entry.subject}</span>
              </div>
              <div className="text-[11px] text-[var(--taomni-text-muted)] truncate">{entry.authorName} · {formatDate(entry.date)}</div>
            </button>
          ))}
        </div>
      </Panel>
      <PanelResizeHandle className="w-[3px] bg-[var(--taomni-divider)] hover:bg-[var(--taomni-accent)] cursor-col-resize" />
      <Panel id="log-diff" defaultSize={62} minSize={35} className="min-w-0 min-h-0 flex flex-col">
        <div className="h-9 shrink-0 flex items-center gap-1 px-2 border-b border-[var(--taomni-divider)]">
          <span className="font-semibold truncate text-[12px]">{selected ? `${selected.shortOid} · ${selected.subject}` : "Commit"}</span>
          <div className="flex-1" />
          <IconButton label="Cherry-pick" icon={<GitCommitHorizontal className="w-3.5 h-3.5" />} disabled={busy || !selected} onClick={onCherryPick} />
          <button className="taomni-btn h-7 px-2" type="button" disabled={busy || !selected} onClick={onRevert}>Revert</button>
          <select className="taomni-input h-7 w-28" disabled={busy || !selected} defaultValue="" onChange={(event) => {
            const mode = event.target.value as GitResetMode | "";
            event.target.value = "";
            if (mode) onReset(mode);
          }}>
            <option value="">Reset...</option>
            <option value="soft">Soft</option>
            <option value="mixed">Mixed</option>
            <option value="hard">Hard</option>
          </select>
        </div>
        <DiffPane diff={diff} loading={diffLoading} />
      </Panel>
    </PanelGroup>
  );
}

function BranchesView({
  snapshot,
  selected,
  setSelected,
  busy,
  onCreate,
  onCheckout,
  onMerge,
  onDelete,
}: {
  snapshot: GitSnapshot | null;
  selected: GitBranchInfo | null;
  setSelected: (branch: GitBranchInfo) => void;
  busy: boolean;
  onCreate: () => void;
  onCheckout: () => void;
  onMerge: () => void;
  onDelete: () => void;
}) {
  const branches = snapshot?.branches ?? [];
  return (
    <div className="h-full min-h-0 flex flex-col">
      <div className="h-9 shrink-0 flex items-center gap-1 px-2 border-b border-[var(--taomni-divider)]">
        <IconButton label="New branch" icon={<Plus className="w-3.5 h-3.5" />} disabled={busy} onClick={onCreate} />
        <button className="taomni-btn h-7 px-2" type="button" disabled={busy || !selected || selected.current} onClick={onCheckout}>Checkout</button>
        <button className="taomni-btn h-7 px-2" type="button" disabled={busy || !selected || selected.current || selected.remote} onClick={onMerge}>Merge into current</button>
        <button className="taomni-btn h-7 px-2 text-red-500" type="button" disabled={busy || !selected || selected.current || selected.remote} onClick={onDelete}>Delete local</button>
      </div>
      <div className="flex-1 min-h-0 overflow-auto">
        {branches.length === 0 ? <EmptyState title="No branches" /> : branches.map((branch) => (
          <button
            key={branch.fullName}
            type="button"
            className={`w-full px-3 py-2 flex items-center gap-2 text-left border-b border-[var(--taomni-divider)] hover:bg-[var(--taomni-hover)] ${selected?.fullName === branch.fullName ? "bg-[var(--taomni-hover)]" : ""}`}
            onClick={() => setSelected(branch)}
          >
            <GitFork className={`w-4 h-4 ${branch.current ? "text-[var(--taomni-accent)]" : "text-[var(--taomni-text-muted)]"}`} />
            <div className="min-w-0 flex-1">
              <div className="text-[12px] truncate">{branch.name}</div>
              <div className="text-[11px] text-[var(--taomni-text-muted)] truncate">
                {branch.remote ? "remote" : "local"}{branch.upstream ? ` · tracks ${branch.upstream}` : ""}{branch.subject ? ` · ${branch.subject}` : ""}
              </div>
            </div>
            {branch.current && <span className="text-[11px] text-[var(--taomni-accent)]">current</span>}
          </button>
        ))}
      </div>
    </div>
  );
}

function StashView({
  snapshot,
  selected,
  setSelected,
  diff,
  diffLoading,
  busy,
  includeUntracked,
  setIncludeUntracked,
  onSave,
  onApply,
  onPop,
  onDrop,
}: {
  snapshot: GitSnapshot | null;
  selected: GitStashEntry | null;
  setSelected: (stash: GitStashEntry) => void;
  diff: string;
  diffLoading: boolean;
  busy: boolean;
  includeUntracked: boolean;
  setIncludeUntracked: (value: boolean) => void;
  onSave: () => void;
  onApply: () => void;
  onPop: () => void;
  onDrop: () => void;
}) {
  const stashes = snapshot?.stashes ?? [];
  return (
    <PanelGroup orientation="horizontal" id="git-stash-layout">
      <Panel id="stash-list" defaultSize={34} minSize={24} className="min-w-0 min-h-0 flex flex-col border-r border-[var(--taomni-divider)]">
        <div className="h-9 shrink-0 flex items-center gap-2 px-2 border-b border-[var(--taomni-divider)]">
          <button className="taomni-btn h-7 px-2" type="button" disabled={busy} onClick={onSave}>Stash</button>
          <label className="flex items-center gap-1 text-[12px]">
            <input type="checkbox" checked={includeUntracked} onChange={(event) => setIncludeUntracked(event.target.checked)} />
            Include untracked
          </label>
        </div>
        <div className="flex-1 min-h-0 overflow-auto">
          {stashes.length === 0 ? <EmptyState title="No stashes" /> : stashes.map((stash) => (
            <button
              key={stash.selector}
              type="button"
              className={`w-full px-3 py-2 text-left border-b border-[var(--taomni-divider)] hover:bg-[var(--taomni-hover)] ${selected?.selector === stash.selector ? "bg-[var(--taomni-hover)]" : ""}`}
              onClick={() => setSelected(stash)}
            >
              <div className="taomni-mono text-[11px] text-[var(--taomni-accent)]">{stash.selector}</div>
              <div className="text-[12px] truncate">{stash.message}</div>
              <div className="text-[11px] text-[var(--taomni-text-muted)]">{stash.date}</div>
            </button>
          ))}
        </div>
      </Panel>
      <PanelResizeHandle className="w-[3px] bg-[var(--taomni-divider)] hover:bg-[var(--taomni-accent)] cursor-col-resize" />
      <Panel id="stash-diff" defaultSize={66} minSize={35} className="min-w-0 min-h-0 flex flex-col">
        <div className="h-9 shrink-0 flex items-center gap-1 px-2 border-b border-[var(--taomni-divider)]">
          <span className="font-semibold text-[12px] truncate">{selected?.selector ?? "Stash"}</span>
          <div className="flex-1" />
          <button className="taomni-btn h-7 px-2" type="button" disabled={busy || !selected} onClick={onApply}>Apply</button>
          <button className="taomni-btn h-7 px-2" type="button" disabled={busy || !selected} onClick={onPop}>Pop</button>
          <button className="taomni-btn h-7 px-2 text-red-500" type="button" disabled={busy || !selected} onClick={onDrop}>Drop</button>
        </div>
        <DiffPane diff={diff} loading={diffLoading} />
      </Panel>
    </PanelGroup>
  );
}

interface RemoteDraft {
  name: string;
  fetchUrl: string;
  pushUrl: string;
  username: string;
  token: string;
}

function SettingsView({
  snapshot,
  settings,
  setSettings,
  remoteDrafts,
  setRemoteDrafts,
  busy,
  onSaveSettings,
  onSaveRemote,
  onClearToken,
  onDeleteRemote,
  onAddRemote,
}: {
  snapshot: GitSnapshot | null;
  settings: GitRepoSettings;
  setSettings: (settings: GitRepoSettings) => void;
  remoteDrafts: Record<string, RemoteDraft>;
  setRemoteDrafts: (drafts: Record<string, RemoteDraft>) => void;
  busy: boolean;
  onSaveSettings: () => void;
  onSaveRemote: (remote: GitRemote, draft: RemoteDraft) => void;
  onClearToken: (remote: GitRemote) => void;
  onDeleteRemote: (remote: GitRemote) => void;
  onAddRemote: () => void;
}) {
  const remotes = snapshot?.remotes ?? [];
  return (
    <div className="h-full min-h-0 overflow-auto">
      <div className="max-w-[1100px] p-4 space-y-5">
        <section>
          <div className="flex items-center gap-2 mb-2">
            <Settings className="w-4 h-4" />
            <h2 className="font-semibold">Repository config</h2>
            <button className="taomni-btn h-7 px-2 ml-auto" type="button" disabled={busy} onClick={onSaveSettings}>
              <Save className="w-3.5 h-3.5 mr-1" /> Save config
            </button>
          </div>
          <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))" }}>
            <SettingInput label="user.name" value={settings.userName} onChange={(value) => setSettings({ ...settings, userName: value })} />
            <SettingInput label="user.email" value={settings.userEmail} onChange={(value) => setSettings({ ...settings, userEmail: value })} />
            <SettingInput label="http.proxy" value={settings.httpProxy} onChange={(value) => setSettings({ ...settings, httpProxy: value })} />
            <SettingInput label="https.proxy" value={settings.httpsProxy} onChange={(value) => setSettings({ ...settings, httpsProxy: value })} />
            <SettingInput label="pull.rebase" value={settings.pullRebase} onChange={(value) => setSettings({ ...settings, pullRebase: value })} />
            <SettingInput label="push.default" value={settings.pushDefault} onChange={(value) => setSettings({ ...settings, pushDefault: value })} />
            <SettingInput label="core.autocrlf" value={settings.coreAutocrlf} onChange={(value) => setSettings({ ...settings, coreAutocrlf: value })} />
            <SettingInput label="core.filemode" value={settings.coreFilemode} onChange={(value) => setSettings({ ...settings, coreFilemode: value })} />
            <SettingInput label="commit.gpgsign" value={settings.commitGpgsign} onChange={(value) => setSettings({ ...settings, commitGpgsign: value })} />
          </div>
        </section>

        <section>
          <div className="flex items-center gap-2 mb-2">
            <GitBranch className="w-4 h-4" />
            <h2 className="font-semibold">Remotes and credentials</h2>
            <button className="taomni-btn h-7 px-2 ml-auto" type="button" disabled={busy} onClick={onAddRemote}>
              <Plus className="w-3.5 h-3.5 mr-1" /> Add remote
            </button>
          </div>
          <div className="space-y-3">
            {remotes.length === 0 ? <EmptyState title="No remotes configured" /> : remotes.map((remote) => {
              const draft = remoteDrafts[remote.name] ?? remoteDraft(remote);
              const updateDraft = (next: RemoteDraft) => setRemoteDrafts({ ...remoteDrafts, [remote.name]: next });
              return (
                <div key={remote.name} className="border border-[var(--taomni-divider)] rounded-md overflow-hidden">
                  <div className="h-8 flex items-center px-3 bg-[var(--taomni-quick-bg)] border-b border-[var(--taomni-divider)]">
                    <span className="font-semibold">{remote.name}</span>
                    <span className="ml-2 text-[11px] text-[var(--taomni-text-muted)]">{remote.tokenRef ? "token stored in Vault" : "no token"}</span>
                    <div className="flex-1" />
                    <button className="taomni-btn h-6 px-2" type="button" disabled={busy} onClick={() => onSaveRemote(remote, draft)}>Save</button>
                    <button className="taomni-btn h-6 px-2 ml-1" type="button" disabled={busy || !remote.tokenRef} onClick={() => onClearToken(remote)}>Clear token</button>
                    <button className="taomni-btn h-6 px-2 ml-1 text-red-500" type="button" disabled={busy} onClick={() => onDeleteRemote(remote)}>
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                  <div className="grid gap-3 p-3" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))" }}>
                    <SettingInput label="name" value={draft.name} onChange={(value) => updateDraft({ ...draft, name: value ?? "" })} />
                    <SettingInput label="fetch URL" value={draft.fetchUrl} onChange={(value) => updateDraft({ ...draft, fetchUrl: value ?? "" })} />
                    <SettingInput label="push URL" value={draft.pushUrl} onChange={(value) => updateDraft({ ...draft, pushUrl: value ?? "" })} />
                    <SettingInput label="account / username" value={draft.username} onChange={(value) => updateDraft({ ...draft, username: value ?? "" })} />
                    <label className="text-[12px]">
                      <span className="block mb-1 text-[var(--taomni-text-muted)]">token</span>
                      <input
                        className="taomni-input w-full h-8"
                        type="password"
                        value={draft.token}
                        placeholder={remote.tokenRef ? "Stored in Vault; enter new token to replace" : "Personal access token"}
                        onChange={(event) => updateDraft({ ...draft, token: event.target.value })}
                      />
                    </label>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      </div>
    </div>
  );
}

function SettingInput({ label, value, onChange }: { label: string; value: string | null; onChange: (value: string | null) => void }) {
  return (
    <label className="text-[12px]">
      <span className="block mb-1 text-[var(--taomni-text-muted)]">{label}</span>
      <input className="taomni-input w-full h-8" value={value ?? ""} onChange={(event) => onChange(emptyToNull(event.target.value))} />
    </label>
  );
}

function DiffPane({ diff, loading }: { diff: string; loading: boolean }) {
  return (
    <div className="flex-1 min-h-0 overflow-auto bg-[var(--taomni-terminal-bg,#111827)]">
      {loading ? (
        <div className="h-full flex items-center justify-center text-[var(--taomni-text-muted)]">
          <Loader2 className="w-4 h-4 animate-spin mr-2" /> Loading diff
        </div>
      ) : diff ? (
        <pre className="taomni-mono text-[12px] leading-5 p-3 whitespace-pre-wrap break-words text-slate-100">{diff}</pre>
      ) : (
        <EmptyState title="Select an item to preview its diff" />
      )}
    </div>
  );
}

function BranchBadge({ snapshot }: { snapshot: GitSnapshot | null }) {
  if (!snapshot) return <span className="text-[11px] text-[var(--taomni-text-muted)]">No repo state</span>;
  return (
    <span className="inline-flex items-center gap-1 h-6 px-2 rounded bg-[var(--taomni-hover)] text-[12px]">
      <GitCommitHorizontal className="w-3.5 h-3.5" />
      {snapshot.detached ? `detached ${snapshot.headOid ?? ""}` : snapshot.currentBranch ?? "(no branch)"}
    </span>
  );
}

function StatusPill({ change }: { change: GitChange }) {
  const color = change.conflict
    ? "bg-red-500/15 text-red-500"
    : change.status === "untracked"
      ? "bg-amber-500/15 text-amber-500"
      : change.staged
        ? "bg-emerald-500/15 text-emerald-500"
        : "bg-blue-500/15 text-blue-500";
  return <span className={`w-20 text-center rounded px-1 py-0.5 text-[10px] uppercase ${color}`}>{gitChangeLabel(change)}</span>;
}

function IconButton({ label, icon, disabled, onClick }: { label: string; icon: React.ReactNode; disabled?: boolean; onClick: () => void }) {
  return (
    <button className="taomni-btn h-7 px-2 inline-flex items-center gap-1" type="button" disabled={disabled} onClick={onClick} title={label}>
      {icon}
      <span>{label}</span>
    </button>
  );
}

function EmptyState({ title }: { title: string }) {
  return <div className="h-full min-h-24 flex items-center justify-center text-[12px] text-[var(--taomni-text-muted)]">{title}</div>;
}

function normalizeSettings(settings: GitRepoSettings | null | undefined): GitRepoSettings {
  return { ...EMPTY_SETTINGS, ...(settings ?? {}) };
}

function buildRemoteDrafts(remotes: GitRemote[], current: Record<string, RemoteDraft>): Record<string, RemoteDraft> {
  const next: Record<string, RemoteDraft> = {};
  for (const remote of remotes) {
    next[remote.name] = current[remote.name] ?? remoteDraft(remote);
  }
  return next;
}

function remoteDraft(remote: GitRemote): RemoteDraft {
  return {
    name: remote.name,
    fetchUrl: remote.fetchUrl,
    pushUrl: remote.pushUrl ?? "",
    username: remote.username ?? "",
    token: "",
  };
}

function emptyToNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : String(error);
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

async function confirmAndRun(title: string, message: string, danger: boolean, action: () => Promise<void>) {
  const ok = await confirmAppDialog({ title, message, danger, confirmLabel: title });
  if (ok) await action();
}

async function checkoutBranch(
  repoRoot: string,
  branch: GitBranchInfo,
  runAction: (label: string, action: () => Promise<void>, options?: { refreshLog?: boolean }) => Promise<void>,
) {
  if (branch.remote) {
    const suggested = branch.name.split("/").slice(1).join("/") || branch.name;
    const localName = await promptAppDialog({
      title: "Checkout remote branch",
      label: "Local branch name",
      initialValue: suggested,
    });
    if (!localName) return;
    await runAction("Checkout remote branch", () => gitCreateBranch(repoRoot, localName, branch.name, true));
    return;
  }
  await runAction("Checkout branch", () => gitCheckoutBranch(repoRoot, branch.name));
}
