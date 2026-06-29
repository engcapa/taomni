import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronDown, Loader2, Search, X } from "lucide-react";
import { Group as PanelGroup, Panel, Separator as PanelResizeHandle } from "react-resizable-panels";
import {
  gitBlobPair,
  gitCommitFiles,
  gitLog,
  type GitBlobPair,
  type GitChange,
  type GitLogEntry,
} from "../../lib/git";
import { buildGraph, graphColor, type GraphRow } from "../../lib/gitGraph";
import { DiffViewer } from "./DiffViewer";

const ROW_H = 44;
const LANE_W = 14;

function GraphCell({ row, maxWidth }: { row: GraphRow; maxWidth: number }) {
  const width = Math.max(maxWidth, 1) * LANE_W;
  const cx = (col: number) => col * LANE_W + LANE_W / 2;
  const mid = ROW_H / 2;
  return (
    <svg width={width} height={ROW_H} className="shrink-0" style={{ display: "block" }}>
      {row.edges.map((e, i) => {
        const color = graphColor(e.color);
        const x1 = cx(e.fromColumn);
        const x2 = cx(e.toColumn);
        let d: string;
        if (e.fromColumn === row.column && e.toColumn === row.column) {
          d = `M ${x1} 0 L ${x1} ${ROW_H}`; // node lane passing straight through
        } else if (e.toColumn === row.column && e.fromColumn !== row.column) {
          d = `M ${x1} 0 C ${x1} ${mid}, ${x2} ${mid}, ${x2} ${mid}`; // incoming into node
        } else if (e.fromColumn === row.column && e.toColumn !== row.column) {
          d = `M ${x1} ${mid} C ${x2} ${mid}, ${x2} ${mid}, ${x2} ${ROW_H}`; // outgoing from node
        } else {
          d = `M ${x1} 0 C ${x1} ${mid}, ${x2} ${mid}, ${x2} ${ROW_H}`; // pass-through
        }
        return <path key={i} d={d} stroke={color} strokeWidth={1.5} fill="none" />;
      })}
      <circle cx={cx(row.column)} cy={mid} r={4} fill={graphColor(row.color)} stroke="var(--taomni-bg)" strokeWidth={1} />
    </svg>
  );
}

// COMMIT_LOG
export interface CommitLogProps {
  repoRoot: string;
  headOid: string | null;
  busy: boolean;
  onContextMenu: (entry: GitLogEntry, x: number, y: number) => void;
  pathFilter?: string | null;
  onClose?: () => void;
}

export function CommitLog({ repoRoot, headOid, busy, onContextMenu, pathFilter, onClose }: CommitLogProps) {
  const [entries, setEntries] = useState<GitLogEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [appliedQuery, setAppliedQuery] = useState("");
  const [allBranches, setAllBranches] = useState(false);
  const [limit, setLimit] = useState(200);
  const [selectedOid, setSelectedOid] = useState<string | null>(null);
  const [files, setFiles] = useState<GitChange[]>([]);
  const [filePath, setFilePath] = useState<string | null>(null);
  const [pair, setPair] = useState<GitBlobPair | null>(null);
  const [pairLoading, setPairLoading] = useState(false);

  // Debounce the message filter.
  useEffect(() => {
    const id = setTimeout(() => setAppliedQuery(query.trim()), 300);
    return () => clearTimeout(id);
  }, [query]);

  const loadEntries = useCallback(async () => {
    setLoading(true);
    try {
      const next = await gitLog(repoRoot, limit, {
        grep: appliedQuery || null,
        all: allBranches,
        path: pathFilter || null,
      });
      setEntries(next);
      setSelectedOid((current) =>
        current && next.some((e) => e.oid === current) ? current : next[0]?.oid ?? null,
      );
    } catch {
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }, [repoRoot, limit, appliedQuery, allBranches, pathFilter]);

  useEffect(() => {
    void loadEntries();
  }, [loadEntries, headOid]);

  const selected = useMemo(
    () => entries.find((e) => e.oid === selectedOid) ?? null,
    [entries, selectedOid],
  );

  // Load the changed-files list for the selected commit.
  useEffect(() => {
    let cancelled = false;
    if (!selected) {
      setFiles([]);
      setFilePath(null);
      return;
    }
    gitCommitFiles(repoRoot, selected.oid)
      .then((list) => {
        if (cancelled) return;
        setFiles(list);
        setFilePath(list[0]?.path ?? null);
      })
      .catch(() => {
        if (!cancelled) setFiles([]);
      });
    return () => {
      cancelled = true;
    };
  }, [repoRoot, selected]);

  // Load the diff for the selected file within the selected commit (parent ↔ commit).
  useEffect(() => {
    let cancelled = false;
    const file = files.find((f) => f.path === filePath) ?? null;
    if (!selected || !file) {
      setPair(null);
      return;
    }
    setPairLoading(true);
    gitBlobPair(repoRoot, file.path, `${selected.oid}^`, selected.oid, file.oldPath)
      .then((p) => {
        if (!cancelled) setPair(p);
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
  }, [repoRoot, selected, filePath, files]);

  const graph = useMemo(() => buildGraph(entries), [entries]);
  const maxWidth = useMemo(() => graph.reduce((m, r) => Math.max(m, r.width), 1), [graph]);

  // RENDER_LOG
  return (
    <div className="h-full min-h-0 flex flex-col">
      {pathFilter && (
        <div className="h-9 shrink-0 flex items-center gap-2 px-3 border-b border-[var(--taomni-divider)]">
          <span className="font-semibold text-[12px] truncate">History: {pathFilter}</span>
          <div className="flex-1" />
          {onClose && (
            <button className="taomni-btn h-7 px-2 inline-flex items-center gap-1" type="button" onClick={onClose}>
              <X className="w-3.5 h-3.5" /> Close
            </button>
          )}
        </div>
      )}
      <div className="flex-1 min-h-0">
        <PanelGroup orientation="horizontal" id="git-log-layout">
      <Panel id="log-list" defaultSize={42} minSize={28} className="min-w-0 min-h-0 flex flex-col border-r border-[var(--taomni-divider)]">
        <div className="h-9 shrink-0 flex items-center gap-2 px-2 border-b border-[var(--taomni-divider)]">
          <div className="relative flex-1 min-w-0">
            <Search className="w-3.5 h-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-[var(--taomni-text-muted)]" />
            <input
              className="taomni-input h-7 w-full pl-7"
              placeholder="Filter messages"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <label className="flex items-center gap-1 text-[12px] select-none whitespace-nowrap">
            <input type="checkbox" checked={allBranches} onChange={(e) => setAllBranches(e.target.checked)} />
            All branches
          </label>
          {loading && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
        </div>
        <div className="flex-1 min-h-0 overflow-auto">
          {entries.length === 0 ? (
            <div className="h-full min-h-24 flex items-center justify-center text-[12px] text-[var(--taomni-text-muted)]">
              {loading ? "Loading…" : "No commits"}
            </div>
          ) : (
            entries.map((entry, i) => (
              <div
                key={entry.oid}
                role="button"
                tabIndex={0}
                style={{ height: ROW_H }}
                className={`w-full flex items-center gap-2 pr-2 cursor-pointer border-b border-[var(--taomni-divider)] ${
                  selectedOid === entry.oid ? "bg-[var(--taomni-hover)]" : "hover:bg-[var(--taomni-hover)]"
                }`}
                onClick={() => setSelectedOid(entry.oid)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setSelectedOid(entry.oid);
                  onContextMenu(entry, e.clientX, e.clientY);
                }}
              >
                <GraphCell row={graph[i]} maxWidth={maxWidth} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1 min-w-0">
                    {entry.refs.map((ref) => (
                      <span
                        key={ref}
                        className="shrink-0 text-[10px] px-1 rounded bg-[var(--taomni-accent)]/15 text-[var(--taomni-accent)] border border-[var(--taomni-accent)]/30"
                      >
                        {ref}
                      </span>
                    ))}
                    <span className="truncate text-[12px]">{entry.subject}</span>
                  </div>
                  <div className="text-[11px] text-[var(--taomni-text-muted)] truncate">
                    <span className="taomni-mono text-[var(--taomni-accent)]">{entry.shortOid}</span> · {entry.authorName} · {formatDate(entry.date)}
                  </div>
                </div>
              </div>
            ))
          )}
          {entries.length >= limit && (
            <button
              className="w-full py-2 text-[12px] text-[var(--taomni-accent)] hover:bg-[var(--taomni-hover)] inline-flex items-center justify-center gap-1"
              type="button"
              disabled={loading || busy}
              onClick={() => setLimit((l) => l + 200)}
            >
              <ChevronDown className="w-3.5 h-3.5" /> Load more
            </button>
          )}
        </div>
      </Panel>
      <PanelResizeHandle className="w-[3px] bg-[var(--taomni-divider)] hover:bg-[var(--taomni-accent)] cursor-col-resize" />
      <Panel id="log-details" defaultSize={58} minSize={35} className="min-w-0 min-h-0">
        <PanelGroup orientation="vertical" id="git-log-detail-layout">
          <Panel id="log-files" defaultSize={30} minSize={15} className="min-h-0 flex flex-col border-b border-[var(--taomni-divider)]">
            <div className="h-8 shrink-0 flex items-center px-3 border-b border-[var(--taomni-divider)] text-[12px] font-semibold">
              {selected ? `${selected.shortOid} · ${files.length} file(s)` : "Commit"}
            </div>
            <div className="flex-1 min-h-0 overflow-auto">
              {files.length === 0 ? (
                <div className="h-full min-h-16 flex items-center justify-center text-[12px] text-[var(--taomni-text-muted)]">
                  {selected ? "No file changes" : "Select a commit"}
                </div>
              ) : (
                files.map((file) => (
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
                ))
              )}
            </div>
          </Panel>
          <PanelResizeHandle className="h-[3px] bg-[var(--taomni-divider)] hover:bg-[var(--taomni-accent)] cursor-row-resize" />
          <Panel id="log-diff" defaultSize={70} minSize={20} className="min-h-0 flex flex-col">
            <DiffViewer pair={pair} loading={pairLoading} emptyLabel="Select a file to preview its diff" />
          </Panel>
        </PanelGroup>
      </Panel>
    </PanelGroup>
      </div>
    </div>
  );
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

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}


