import { useEffect, useMemo, useState } from "react";
import { X } from "lucide-react";
import { Group as PanelGroup, Panel, Separator as PanelResizeHandle } from "react-resizable-panels";
import {
  gitBlobPair,
  gitCompare,
  type GitBlobPair,
  type GitChange,
} from "../../lib/git";
import { DiffViewer } from "./DiffViewer";

const AUTO_PREVIEW_FILE_LIMIT = 300;

export interface CompareViewProps {
  repoRoot: string;
  refA: string;
  refB: string;
  title: string;
  onClose: () => void;
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

export function CompareView({ repoRoot, refA, refB, title, onClose }: CompareViewProps) {
  const [files, setFiles] = useState<GitChange[]>([]);
  const [loading, setLoading] = useState(false);
  const [filePath, setFilePath] = useState<string | null>(null);
  const [pair, setPair] = useState<GitBlobPair | null>(null);
  const [pairLoading, setPairLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setFiles([]);
    setFilePath(null);
    setPair(null);
    setPairLoading(false);
    gitCompare(repoRoot, refA, refB)
      .then((list) => {
        if (cancelled) return;
        setFiles(list);
        setFilePath(list.length > AUTO_PREVIEW_FILE_LIMIT ? null : list[0]?.path ?? null);
      })
      .catch(() => {
        if (!cancelled) setFiles([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [repoRoot, refA, refB]);

  const file = useMemo(() => files.find((f) => f.path === filePath) ?? null, [files, filePath]);
  const diffEmptyLabel =
    files.length > AUTO_PREVIEW_FILE_LIMIT && !filePath
      ? `Large comparison (${files.length} files). Select a file to preview its diff.`
      : "Select a file to preview its diff";

  useEffect(() => {
    let cancelled = false;
    if (!file) {
      setPair(null);
      setPairLoading(false);
      return;
    }
    setPairLoading(true);
    gitBlobPair(repoRoot, file.path, refA, refB, file.oldPath)
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
  }, [repoRoot, refA, refB, file]);

  return (
    <div className="h-full min-h-0 flex flex-col">
      <div className="h-9 shrink-0 flex items-center gap-2 px-3 border-b border-[var(--taomni-divider)]">
        <span className="font-semibold text-[12px] truncate">Repository Diff: {title}</span>
        <span className="text-[11px] text-[var(--taomni-text-muted)]">{loading ? "comparing…" : `${files.length} file(s)`}</span>
        <div className="flex-1" />
        <button className="taomni-btn h-7 px-2 inline-flex items-center gap-1" type="button" onClick={onClose}>
          <X className="w-3.5 h-3.5" /> Close
        </button>
      </div>
      <div className="flex-1 min-h-0">
        <PanelGroup orientation="horizontal" id="git-compare-layout">
          <Panel id="compare-files" defaultSize={32} minSize={20} className="min-w-0 min-h-0 flex flex-col border-r border-[var(--taomni-divider)]">
            <div className="flex-1 min-h-0 overflow-auto">
              {files.length === 0 ? (
                <div className="h-full min-h-24 flex items-center justify-center text-[12px] text-[var(--taomni-text-muted)]">
                  {loading ? "Loading…" : "No differences"}
                </div>
              ) : (
                files.map((f) => (
                  <button
                    key={f.path}
                    type="button"
                    className={`w-full px-3 py-1.5 flex items-center gap-2 text-left border-b border-[var(--taomni-divider)] hover:bg-[var(--taomni-hover)] ${
                      filePath === f.path ? "bg-[var(--taomni-hover)]" : ""
                    }`}
                    onClick={() => setFilePath(f.path)}
                  >
                    <span className={`shrink-0 w-[58px] text-center rounded px-1 py-0.5 text-[10px] uppercase ${statusColor(f.status)}`}>
                      {f.status}
                    </span>
                    <span className="truncate text-[12px]">{f.path}</span>
                  </button>
                ))
              )}
            </div>
          </Panel>
          <PanelResizeHandle className="w-[3px] bg-[var(--taomni-divider)] hover:bg-[var(--taomni-accent)] cursor-col-resize" />
          <Panel id="compare-diff" defaultSize={68} minSize={35} className="min-w-0 min-h-0 flex flex-col">
            <DiffViewer pair={pair} loading={pairLoading} emptyLabel={diffEmptyLabel} />
          </Panel>
        </PanelGroup>
      </div>
    </div>
  );
}
