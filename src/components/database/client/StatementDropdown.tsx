import { Play, SquareDashedMousePointer, Plus, FileJson, MessageSquare } from "lucide-react";
import { type EditorStatementAction } from "./types";


export function StatementDropdown({
  action,
  hasJson,
  onRun,
  onSelect,
  onOpenTab,
  onJson,
  onAskAi,
  onClose,
}: {
  action: EditorStatementAction;
  hasJson: boolean;
  onRun: (action: EditorStatementAction) => void;
  onSelect: (action: EditorStatementAction) => void;
  onOpenTab: (action: EditorStatementAction) => void;
  onJson: (action: EditorStatementAction) => void;
  onAskAi: (action: EditorStatementAction) => void;
  onClose: () => void;
}) {
  const iconButton = "h-6 px-1.5 inline-flex items-center gap-1 rounded text-[10px] hover:bg-[var(--taomni-hover)] disabled:opacity-40";
  const compactSql = action.range.sql.replace(/\s+/g, " ").trim();
  return (
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} />
      <div
        data-testid="db-current-statement-panel"
        className="absolute right-2 top-9 z-50 w-[560px] max-w-[calc(100vw-24px)] overflow-hidden rounded shadow-lg flex flex-col"
        style={{ background: "var(--taomni-panel-bg)", border: "1px solid var(--taomni-divider)" }}
      >
        <div
          className="h-8 shrink-0 flex items-center gap-2 px-2"
          style={{ borderBottom: "1px solid var(--taomni-divider)", background: "var(--taomni-quick-bg)" }}
        >
          <SquareDashedMousePointer className="w-3.5 h-3.5 text-[var(--taomni-accent)]" />
          <span className="text-[12px] font-semibold">Current statement</span>
          <span className="text-[10px] text-[var(--taomni-text-muted)]">
            {action.range.from}-{action.range.to}
          </span>
        </div>
        <div className="px-2 py-2">
          <div
            className="truncate font-mono text-[11px] text-[var(--taomni-text)]"
            title={action.range.sql}
          >
            {compactSql}
          </div>
          <div className="mt-2 flex items-center gap-1">
            <button type="button" data-testid="db-current-statement-run" className={iconButton} onClick={() => onRun(action)} title="Run this SQL statement">
              <Play className="w-3 h-3" /> Run
            </button>
            <button type="button" data-testid="db-current-statement-select" className={iconButton} onClick={() => onSelect(action)} title="Select this SQL statement in the editor">
              <SquareDashedMousePointer className="w-3 h-3" /> Select
            </button>
            <button type="button" data-testid="db-current-statement-open-tab" className={iconButton} onClick={() => onOpenTab(action)} title="Open and run in a new query panel">
              <Plus className="w-3 h-3" /> +Tab
            </button>
            <button type="button" data-testid="db-current-statement-json" className={iconButton} onClick={() => onJson(action)} disabled={!hasJson} title={hasJson ? "Copy in-memory result as JSON" : "Run this statement to make JSON available"}>
              <FileJson className="w-3 h-3" /> JSON
            </button>
            <button type="button" data-testid="db-current-statement-ask-ai" className={iconButton} onClick={() => onAskAi(action)} title="Ask AI about this SQL statement">
              <MessageSquare className="w-3 h-3" /> Ask AI
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
