import { Play, SquareDashedMousePointer, Clock, Plus, Loader2, FileJson, MessageSquare, RefreshCw, Trash2 } from "lucide-react";
import { type DbSqlHistoryEntry } from "../../../lib/ipc";
import { formatDurationMs, formatFullDateTime } from "./formatting";


export function HistoryDropdown({
  entries,
  loading,
  onRefresh,
  onRun,
  onSelect,
  onOpenTab,
  onJson,
  onAskAi,
  onDelete,
  onClear,
  onClose,
}: {
  entries: DbSqlHistoryEntry[];
  loading: boolean;
  onRefresh: () => void;
  onRun: (entry: DbSqlHistoryEntry) => void;
  onSelect: (entry: DbSqlHistoryEntry) => void;
  onOpenTab: (entry: DbSqlHistoryEntry) => void;
  onJson: (entry: DbSqlHistoryEntry) => void;
  onAskAi: (entry: DbSqlHistoryEntry) => void;
  onDelete: (entry: DbSqlHistoryEntry) => void;
  onClear: () => void;
  onClose: () => void;
}) {
  const iconButton = "h-6 px-1.5 inline-flex items-center gap-1 rounded text-[10px] hover:bg-[var(--taomni-hover)] disabled:opacity-40";
  return (
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} />
      <div
        data-testid="db-query-history-panel"
        className="absolute right-2 top-9 z-50 w-[620px] max-w-[calc(100vw-24px)] max-h-[440px] overflow-hidden rounded shadow-lg flex flex-col"
        style={{ background: "var(--taomni-panel-bg)", border: "1px solid var(--taomni-divider)" }}
      >
        <div
          className="h-8 shrink-0 flex items-center gap-2 px-2"
          style={{ borderBottom: "1px solid var(--taomni-divider)", background: "var(--taomni-quick-bg)" }}
        >
          <Clock className="w-3.5 h-3.5 text-[var(--taomni-accent)]" />
          <span className="text-[12px] font-semibold">Query history</span>
          <span className="text-[10px] text-[var(--taomni-text-muted)]">{entries.length}</span>
          <div className="flex-1" />
          <button type="button" data-testid="db-query-history-refresh" className={iconButton} onClick={onRefresh} title="Refresh query history">
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} /> Refresh
          </button>
          <button type="button" data-testid="db-query-history-clear" className={iconButton} onClick={onClear} disabled={entries.length === 0} title="Clear this session history">
            <Trash2 className="w-3.5 h-3.5" /> Clear
          </button>
        </div>
        {loading ? (
          <div className="px-3 py-4 text-[11px] text-[var(--taomni-text-muted)] inline-flex items-center gap-2">
            <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading query history...
          </div>
        ) : entries.length === 0 ? (
          <div className="px-3 py-4 text-[11px] text-[var(--taomni-text-muted)]">No query history yet.</div>
        ) : (
          <div className="overflow-auto taomni-scroll-y">
            {entries.map((entry) => {
              const duration = formatDurationMs(entry.durationMs);
              const sql = entry.sqlContent.replace(/\s+/g, " ").trim();
              const hasJson = entry.hasResultSet && !entry.error;
              return (
                <div
                  key={entry.id}
                  data-testid="db-query-history-entry"
                  className="px-2 py-2 border-b border-[var(--taomni-divider)] last:border-0 hover:bg-[var(--taomni-hover)]"
                >
                  <div className="flex items-center gap-2 text-[10px] text-[var(--taomni-text-muted)]">
                    <span className="font-mono">{formatFullDateTime(entry.startedAt)}</span>
                    {duration && <span>{duration}</span>}
                    {entry.hasResultSet ? <span>{entry.rowCount ?? 0} rows</span> : <span>{entry.rowsAffected ?? 0} affected</span>}
                    {entry.error && <span className="text-[#d9534f] truncate">Error</span>}
                    <span className="ml-auto truncate">{entry.schemaName ?? entry.databaseName ?? entry.engine}</span>
                  </div>
                  <div className="mt-1 flex items-center gap-2 min-w-0">
                    {entry.tabName && (
                      <span
                        data-testid="db-query-history-entry-name"
                        className="shrink-0 max-w-[140px] truncate rounded px-1.5 py-0.5 text-[10px]"
                        style={{ background: "var(--taomni-selected)", color: "var(--taomni-accent)" }}
                        title={entry.tabName}
                      >
                        {entry.tabName}
                      </span>
                    )}
                    <button
                      type="button"
                      className="flex-1 min-w-0 text-left truncate font-mono text-[11px] text-[var(--taomni-text)]"
                      title={entry.sqlContent}
                      onClick={() => onSelect(entry)}
                    >
                      {sql}
                    </button>
                  </div>
                  {entry.error && (
                    <div className="mt-1 truncate text-[10px] text-[#d9534f]" title={entry.error}>
                      {entry.error}
                    </div>
                  )}
                  <div className="mt-1.5 flex items-center gap-1">
                    <button type="button" data-testid="db-query-history-run" className={iconButton} onClick={() => onRun(entry)} title="Run this historical SQL">
                      <Play className="w-3 h-3" /> Run
                    </button>
                    <button type="button" data-testid="db-query-history-select" className={iconButton} onClick={() => onSelect(entry)} title="Select this SQL in the current editor">
                      <SquareDashedMousePointer className="w-3 h-3" /> Select
                    </button>
                    <button type="button" data-testid="db-query-history-open-tab" className={iconButton} onClick={() => onOpenTab(entry)} title="Open and run in a new query panel">
                      <Plus className="w-3 h-3" /> +Tab
                    </button>
                    <button type="button" data-testid="db-query-history-json" className={iconButton} onClick={() => onJson(entry)} disabled={!hasJson} title={hasJson ? "Copy in-memory result as JSON" : "Run this SQL again to make JSON available"}>
                      <FileJson className="w-3 h-3" /> JSON
                    </button>
                    <button type="button" data-testid="db-query-history-ask-ai" className={iconButton} onClick={() => onAskAi(entry)} title="Ask AI about this SQL">
                      <MessageSquare className="w-3 h-3" /> Ask AI
                    </button>
                    <div className="flex-1" />
                    <button type="button" data-testid="db-query-history-delete" className={iconButton} onClick={() => onDelete(entry)} title="Delete this history entry">
                      <Trash2 className="w-3 h-3" />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </>
  );
}
