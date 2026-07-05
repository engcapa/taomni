import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronDown, GitCommitHorizontal, Loader2, Search } from "lucide-react";
import { Group as PanelGroup, Panel, Separator as PanelResizeHandle } from "react-resizable-panels";
import {
  gitBlobPair,
  gitCommitFiles,
  gitLog,
  type GitBlobPair,
  type GitChange,
  type GitLogEntry,
} from "../../lib/git";
import type { GitWorkspaceRootInfo } from "../../types";
import { DiffViewer } from "./DiffViewer";

const AUTO_PREVIEW_FILE_LIMIT = 300;

interface WorkspaceCommit extends GitLogEntry {
  repoRoot: string;
  repoName: string;
}

export interface WorkspaceCommitLogProps {
  roots: GitWorkspaceRootInfo[];
  busy: boolean;
}

export function WorkspaceCommitLog({ roots, busy }: WorkspaceCommitLogProps) {
  const [entries, setEntries] = useState<WorkspaceCommit[]>([]);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [appliedQuery, setAppliedQuery] = useState("");
  const [repoFilter, setRepoFilter] = useState("");
  const [allBranches, setAllBranches] = useState(false);
  const [limit, setLimit] = useState(120);
  const [error, setError] = useState<string | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [files, setFiles] = useState<GitChange[]>([]);
  const [filePath, setFilePath] = useState<string | null>(null);
  const [pair, setPair] = useState<GitBlobPair | null>(null);
  const [pairLoading, setPairLoading] = useState(false);

  useEffect(() => {
    const id = window.setTimeout(() => setAppliedQuery(query.trim()), 300);
    return () => window.clearTimeout(id);
  }, [query]);

  const visibleRoots = useMemo(() => (
    repoFilter ? roots.filter((root) => root.repoRoot === repoFilter) : roots
  ), [repoFilter, roots]);

  const loadEntries = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const results = await Promise.allSettled(visibleRoots.map(async (root) => {
        const commits = await gitLog(root.repoRoot, limit, {
          grep: appliedQuery || null,
          all: allBranches,
        });
        return commits.map((entry) => ({
          ...entry,
          repoRoot: root.repoRoot,
          repoName: root.name,
        }));
      }));
      const loaded: WorkspaceCommit[] = [];
      const failures: string[] = [];
      results.forEach((result, index) => {
        const root = visibleRoots[index];
        if (result.status === "fulfilled") {
          loaded.push(...result.value);
        } else if (root) {
          failures.push(`${root.name}: ${errorMessage(result.reason)}`);
        }
      });
      loaded.sort((a, b) => commitTime(b.date) - commitTime(a.date));
      const next = loaded.slice(0, limit);
      setEntries(next);
      setSelectedKey((current) => (
        current && next.some((entry) => entryKey(entry) === current)
          ? current
          : next[0] ? entryKey(next[0]) : null
      ));
      setError(failures.length ? `${failures.length} repos failed to load` : null);
    } finally {
      setLoading(false);
    }
  }, [allBranches, appliedQuery, limit, visibleRoots]);

  useEffect(() => {
    void loadEntries();
  }, [loadEntries]);

  const selected = useMemo(
    () => entries.find((entry) => entryKey(entry) === selectedKey) ?? null,
    [entries, selectedKey],
  );

  useEffect(() => {
    let cancelled = false;
    if (!selected) {
      setFiles([]);
      setFilePath(null);
      setPair(null);
      setPairLoading(false);
      return;
    }
    setFiles([]);
    setFilePath(null);
    setPair(null);
    setPairLoading(false);
    gitCommitFiles(selected.repoRoot, selected.oid)
      .then((list) => {
        if (cancelled) return;
        setFiles(list);
        setFilePath(list.length > AUTO_PREVIEW_FILE_LIMIT ? null : list[0]?.path ?? null);
      })
      .catch(() => {
        if (!cancelled) setFiles([]);
      });
    return () => {
      cancelled = true;
    };
  }, [selected]);

  useEffect(() => {
    let cancelled = false;
    const file = files.find((entry) => entry.path === filePath) ?? null;
    if (!selected || !file) {
      setPair(null);
      setPairLoading(false);
      return;
    }
    setPairLoading(true);
    gitBlobPair(selected.repoRoot, file.path, `${selected.oid}^`, selected.oid, file.oldPath)
      .then((next) => {
        if (!cancelled) setPair(next);
      })
      .catch(() => {
        if (!cancelled) setPair(null);
      })
      .finally(() => {
        if (!cancelled) setPairLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selected, filePath, files]);

  const diffEmptyLabel =
    files.length > AUTO_PREVIEW_FILE_LIMIT && !filePath
      ? `Large commit (${files.length} files). Select a file to preview its diff.`
      : "Select a file to preview its diff";

  return (
    <div className="h-full min-h-0 flex flex-col">
      <PanelGroup orientation="horizontal" id="workspace-git-log-layout">
        <Panel id="workspace-log-list" defaultSize={42} minSize={28} className="min-w-0 min-h-0 flex flex-col border-r border-[var(--taomni-divider)]">
          <div className="h-9 shrink-0 flex items-center gap-2 px-2 border-b border-[var(--taomni-divider)]">
            <div className="relative flex-1 min-w-0">
              <Search className="w-3.5 h-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-[var(--taomni-text-muted)]" />
              <input
                className="taomni-input h-7 w-full pl-7"
                placeholder="Filter messages"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </div>
            <select
              className="taomni-input h-7 w-40"
              value={repoFilter}
              onChange={(event) => setRepoFilter(event.target.value)}
            >
              <option value="">All repositories</option>
              {roots.map((root) => (
                <option key={root.repoRoot} value={root.repoRoot}>{root.name}</option>
              ))}
            </select>
            <label className="flex items-center gap-1 text-[12px] select-none whitespace-nowrap">
              <input type="checkbox" checked={allBranches} onChange={(event) => setAllBranches(event.target.checked)} />
              All branches
            </label>
            {loading && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
          </div>
          {error && (
            <div className="shrink-0 px-3 py-1 text-[11px] text-red-500 border-b border-[var(--taomni-divider)]">
              {error}
            </div>
          )}
          <div className="flex-1 min-h-0 overflow-auto">
            {entries.length === 0 ? (
              <div className="h-full min-h-24 flex items-center justify-center text-[12px] text-[var(--taomni-text-muted)]">
                {loading ? "Loading..." : "No commits"}
              </div>
            ) : entries.map((entry) => (
              <button
                key={entryKey(entry)}
                type="button"
                className={`w-full min-h-[82px] px-3 py-2 flex items-start gap-2 text-left border-b border-[var(--taomni-divider)] hover:bg-[var(--taomni-hover)] ${
                  selectedKey === entryKey(entry) ? "bg-[var(--taomni-hover)]" : ""
                }`}
                title={commitTooltip(entry)}
                onClick={() => setSelectedKey(entryKey(entry))}
              >
                <GitCommitHorizontal className="mt-0.5 w-4 h-4 shrink-0 text-[var(--taomni-accent)]" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-start gap-1 min-w-0">
                    <span className="shrink-0 mt-0.5 rounded border border-[var(--taomni-divider)] bg-[var(--taomni-quick-bg)] px-1 text-[10px] text-[var(--taomni-text-muted)]">
                      {entry.repoName}
                    </span>
                    {entry.refs.slice(0, 3).map((ref) => (
                      <span
                        key={ref}
                        className="shrink-0 mt-0.5 text-[10px] px-1 rounded bg-[var(--taomni-accent)]/15 text-[var(--taomni-accent)] border border-[var(--taomni-accent)]/30"
                      >
                        {ref}
                      </span>
                    ))}
                    <span className="min-w-0 text-[12px] leading-4 font-medium line-clamp-2">{entry.subject}</span>
                  </div>
                  {commitBodyPreview(entry) && (
                    <div className="mt-0.5 text-[11px] leading-4 text-[var(--taomni-text-muted)] line-clamp-1">
                      {commitBodyPreview(entry)}
                    </div>
                  )}
                  <div className="mt-1 text-[11px] text-[var(--taomni-text-muted)] truncate">
                    <span className="taomni-mono text-[var(--taomni-accent)]">{entry.shortOid}</span> · {entry.authorName} · {formatDate(entry.date)}
                  </div>
                </div>
              </button>
            ))}
            {entries.length >= limit && (
              <button
                className="w-full py-2 text-[12px] text-[var(--taomni-accent)] hover:bg-[var(--taomni-hover)] inline-flex items-center justify-center gap-1"
                type="button"
                disabled={loading || busy}
                onClick={() => setLimit((current) => current + 120)}
              >
                <ChevronDown className="w-3.5 h-3.5" /> Load more
              </button>
            )}
          </div>
        </Panel>
        <PanelResizeHandle className="w-[3px] bg-[var(--taomni-divider)] hover:bg-[var(--taomni-accent)] cursor-col-resize" />
        <Panel id="workspace-log-details" defaultSize={58} minSize={35} className="min-w-0 min-h-0">
          <PanelGroup orientation="vertical" id="workspace-git-log-detail-layout">
            <Panel id="workspace-log-files" defaultSize={30} minSize={15} className="min-h-0 flex flex-col border-b border-[var(--taomni-divider)]">
              <div className="h-8 shrink-0 flex items-center gap-2 px-3 border-b border-[var(--taomni-divider)] text-[12px] font-semibold">
                {selected ? (
                  <>
                    <span className="shrink-0 rounded border border-[var(--taomni-divider)] bg-[var(--taomni-quick-bg)] px-1.5 py-0.5 text-[10px] text-[var(--taomni-text-muted)]">
                      {selected.repoName}
                    </span>
                    <span className="min-w-0 truncate">{selected.shortOid} · {files.length} file(s)</span>
                  </>
                ) : "Commit"}
              </div>
              {selected && (
                <div className="shrink-0 px-3 py-2 border-b border-[var(--taomni-divider)]">
                  <div className="text-[12px] leading-5 font-semibold text-[var(--taomni-text)] whitespace-pre-wrap">
                    {selected.subject}
                  </div>
                  {selected.body.trim() && (
                    <div className="mt-1 max-h-28 overflow-auto whitespace-pre-wrap text-[11px] leading-4 text-[var(--taomni-text-muted)]">
                      {selected.body.trim()}
                    </div>
                  )}
                  <div className="mt-1 text-[11px] text-[var(--taomni-text-muted)] truncate">
                    {selected.authorName} &lt;{selected.authorEmail}&gt; · {formatDate(selected.date)}
                  </div>
                </div>
              )}
              <div className="flex-1 min-h-0 overflow-auto">
                {files.length === 0 ? (
                  <div className="h-full min-h-16 flex items-center justify-center text-[12px] text-[var(--taomni-text-muted)]">
                    {selected ? "No file changes" : "Select a commit"}
                  </div>
                ) : files.map((file) => (
                  <button
                    key={file.path}
                    type="button"
                    className={`w-full px-3 py-1 flex items-center gap-2 text-left border-b border-[var(--taomni-divider)] hover:bg-[var(--taomni-hover)] ${
                      filePath === file.path ? "bg-[var(--taomni-hover)]" : ""
                    }`}
                    onClick={() => setFilePath(file.path)}
                  >
                    <span className={`shrink-0 w-[58px] text-center rounded px-1 py-0.5 text-[10px] uppercase ${statusColor(file.status)}`}>
                      {file.status}
                    </span>
                    <span className="truncate text-[12px]">{file.path}</span>
                  </button>
                ))}
              </div>
            </Panel>
            <PanelResizeHandle className="h-[3px] bg-[var(--taomni-divider)] hover:bg-[var(--taomni-accent)] cursor-row-resize" />
            <Panel id="workspace-log-diff" defaultSize={70} minSize={20} className="min-h-0 flex flex-col">
              <DiffViewer pair={pair} loading={pairLoading} emptyLabel={diffEmptyLabel} />
            </Panel>
          </PanelGroup>
        </Panel>
      </PanelGroup>
    </div>
  );
}

function entryKey(entry: WorkspaceCommit): string {
  return `${entry.repoRoot}\u0000${entry.oid}`;
}

function commitTime(value: string): number {
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? 0 : time;
}

function statusColor(status: string): string {
  switch (status) {
    case "added":
      return "bg-emerald-500/15 text-emerald-500";
    case "deleted":
      return "bg-red-500/15 text-red-500";
    case "renamed":
    case "copied":
      return "bg-purple-500/15 text-purple-500";
    default:
      return "bg-blue-500/15 text-blue-500";
  }
}

function commitBodyPreview(entry: GitLogEntry): string {
  return entry.body.trim().replace(/\s+/g, " ");
}

function commitTooltip(entry: WorkspaceCommit): string {
  const message = [entry.subject, entry.body.trim()].filter(Boolean).join("\n\n");
  return `${entry.repoName} · ${message}\n\n${entry.shortOid} · ${entry.authorName} · ${formatDate(entry.date)}`;
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : String(error);
}
