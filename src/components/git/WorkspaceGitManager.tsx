import {
  useCallback,
  useEffect,
  useMemo,
  useState,
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
  Upload,
} from "lucide-react";
import {
  gitFetch,
  gitPull,
  gitPush,
  gitRepoName,
  gitSnapshot,
  selectedRemote,
  type GitSnapshot,
} from "../../lib/git";
import { alertAppDialog } from "../../lib/appDialogs";
import { useAppStore } from "../../stores/appStore";
import type { GitWorkspaceRootInfo } from "../../types";
import { GitPanel } from "./GitPanel";

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

  const selectedRoot = useMemo(
    () => normalizedRoots.find((root) => root.repoRoot === selectedRepoRoot) ?? normalizedRoots[0] ?? null,
    [normalizedRoots, selectedRepoRoot],
  );
  const checkedRoots = useMemo(
    () => normalizedRoots.filter((root) => checkedRepoRoots.has(root.repoRoot)),
    [checkedRepoRoots, normalizedRoots],
  );
  const totalChangedFiles = useMemo(
    () => normalizedRoots.reduce((total, root) => total + (snapshots[root.repoRoot]?.snapshot?.changes.length ?? 0), 0),
    [normalizedRoots, snapshots],
  );
  const allChecked = normalizedRoots.length > 0 && checkedRoots.length === normalizedRoots.length;
  const title = workspaceName?.trim() || "Code Workspace";

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
    if (!visible || normalizedRoots.length === 0) return;
    void refreshRepos(normalizedRoots);
  }, [normalizedRoots, refreshRepos, visible]);

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
        <aside className="w-[340px] min-w-[260px] max-w-[45%] shrink-0 border-r border-[var(--taomni-divider)] bg-[var(--taomni-quick-bg)] flex flex-col">
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
          <div className="flex-1 min-h-0 overflow-auto">
            {normalizedRoots.length === 0 ? (
              <EmptyState title="No Git repositories detected" />
            ) : normalizedRoots.map((root) => {
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
            />
          ) : (
            <EmptyState title="No Git repositories detected" />
          )}
        </main>
      </div>
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
  onChecked,
  onSelect,
}: {
  root: GitWorkspaceRootInfo;
  snapshot: GitSnapshot | null;
  loading: boolean;
  error: string | null;
  selected: boolean;
  checked: boolean;
  onChecked: (checked: boolean) => void;
  onSelect: () => void;
}) {
  const branch = snapshot?.detached ? `detached ${snapshot.headOid ?? ""}` : snapshot?.currentBranch ?? "";
  const changes = snapshot?.changes ?? [];
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
            {root.repoRoot}
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
