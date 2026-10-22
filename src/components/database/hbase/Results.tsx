import { Loader2, Trash2, X } from "lucide-react";
import { type MouseEvent as ReactMouseEvent } from "react";
import { useT } from "../../../lib/i18n";
import { useContextMenu, type MenuItem } from "../../ContextMenu";
import { QueryResultGrid, type QueryRefreshMode } from "../QueryResultGrid";
import { activeSheet, type PanelState, type ResultSubTab } from "./model";

// PLACEHOLDER_REST
export function ResultArea({
  panel,
  onSheetSelect,
  onSheetClose,
  onCloseSheets,
  onTabChange,
  onRefreshSheet,
  onCancel,
  onStatus,
}: {
  panel: PanelState;
  onSheetSelect: (sheetId: string) => void;
  onSheetClose: (sheetId: string) => void;
  onCloseSheets: (sheetIds: string[]) => void;
  onTabChange: (sheetId: string, tab: ResultSubTab) => void;
  onRefreshSheet: (sheetId: string, mode: QueryRefreshMode) => void;
  onCancel: () => void;
  onStatus: (message: string) => void;
}) {
  const t = useT();
  const sheetMenu = useContextMenu();
  const sheet = activeSheet(panel);
  const tab = "h-6 px-3 text-[11px] inline-flex items-center";

  const openSheetMenu = (event: ReactMouseEvent, sheetId: string) => {
    const idx = panel.sheets.findIndex((candidate) => candidate.id === sheetId);
    if (idx < 0) return;
    const isFirst = idx === 0;
    const isLast = idx === panel.sheets.length - 1;
    const onlyOne = panel.sheets.length <= 1;
    const items: MenuItem[] = [
      {
        label: t("tabs.close"),
        testId: "result-sheet-close",
        icon: <X className="w-3 h-3" />,
        onClick: () => onSheetClose(sheetId),
      },
      {
        label: t("tabs.closeOthersShort"),
        testId: "result-sheet-close-others",
        icon: <Trash2 className="w-3 h-3" />,
        onClick: () =>
          onCloseSheets(panel.sheets.filter((candidate) => candidate.id !== sheetId).map((candidate) => candidate.id)),
        disabled: onlyOne,
      },
      {
        label: t("tabs.closeLeftShort"),
        testId: "result-sheet-close-left",
        icon: <Trash2 className="w-3 h-3" />,
        onClick: () => onCloseSheets(panel.sheets.slice(0, idx).map((candidate) => candidate.id)),
        disabled: isFirst,
      },
      {
        label: t("tabs.closeRightShort"),
        testId: "result-sheet-close-right",
        icon: <Trash2 className="w-3 h-3" />,
        onClick: () => onCloseSheets(panel.sheets.slice(idx + 1).map((candidate) => candidate.id)),
        disabled: isLast,
      },
      {
        label: t("tabs.closeAll"),
        testId: "result-sheet-close-all",
        icon: <Trash2 className="w-3 h-3" />,
        onClick: () => onCloseSheets(panel.sheets.map((candidate) => candidate.id)),
      },
    ];
    sheetMenu.show(event, items);
  };

  return (
    <div className="h-full flex flex-col min-h-0" style={{ background: "var(--taomni-bg)", fontSize: "var(--taomni-db-font-size, 12px)" }}>
      {sheetMenu.render}
      <div className="h-7 shrink-0 flex items-end gap-1 px-1 overflow-hidden" style={{ background: "var(--taomni-chrome-bg)", borderBottom: "1px solid var(--taomni-divider)" }}>
        {panel.sheets.length === 0 ? (
          <span className="px-2 pb-1 text-[11px] text-[var(--taomni-text-muted)]">Result sheets</span>
        ) : (
          panel.sheets.map((rs) => {
            const active = rs.id === sheet?.id;
            return (
              <button
                key={rs.id}
                type="button"
                data-testid="result-sheet-tab"
                data-sheet-id={rs.id}
                className="h-6 max-w-[170px] px-2 inline-flex items-center gap-1 text-[11px]"
                style={{
                  background: active ? "var(--taomni-tab-active)" : "var(--taomni-tab-inactive)",
                  color: active ? "var(--taomni-accent)" : "var(--taomni-text-muted)",
                  border: "1px solid var(--taomni-tab-border)",
                  borderBottom: active ? "1px solid var(--taomni-tab-active)" : "1px solid var(--taomni-divider)",
                  borderTopLeftRadius: 4,
                  borderTopRightRadius: 4,
                }}
                onClick={() => onSheetSelect(rs.id)}
                onContextMenu={(event) => openSheetMenu(event, rs.id)}
                title={rs.command}
              >
                <span className="truncate">{rs.title}</span>
                {rs.running && <Loader2 className="w-3 h-3 shrink-0 animate-spin" />}
                {(rs.error || rs.warnings.length > 0) && <span className="text-[10px] shrink-0">●</span>}
                <X className="w-3 h-3 shrink-0 hover:text-[var(--taomni-text)]" onClick={(e) => { e.stopPropagation(); onSheetClose(rs.id); }} />
              </button>
            );
          })
        )}
      </div>
      {sheet && (
        <div className="h-7 shrink-0 flex items-center gap-1 px-1" style={{ borderBottom: "1px solid var(--taomni-divider)" }}>
          <button type="button" className={tab} style={{ color: sheet.resultTab === "results" ? "var(--taomni-accent)" : "var(--taomni-text-muted)" }} onClick={() => onTabChange(sheet.id, "results")}>Results</button>
          <button type="button" className={tab} style={{ color: sheet.resultTab === "messages" ? "var(--taomni-accent)" : "var(--taomni-text-muted)" }} onClick={() => onTabChange(sheet.id, "messages")}>
            Messages{(sheet.error || sheet.warnings.length > 0) ? " ●" : ""}
          </button>
          <span className="ml-auto truncate px-2 text-[10px] text-[var(--taomni-text-muted)] font-mono" title={sheet.command}>{sheet.command.replace(/\s+/g, " ")}</span>
        </div>
      )}
      <div className="flex-1 min-h-0 flex flex-col">
        {!sheet ? (
          <div className="flex-1 flex items-center justify-center text-[12px] text-[var(--taomni-text-muted)]">Run a command to create a result sheet.</div>
        ) : sheet.resultTab === "results" ? (
          sheet.result ? (
            <div className={`flex-1 min-h-0 flex flex-col ${sheet.cancelling ? "opacity-50 pointer-events-none" : ""}`}>
              <QueryResultGrid
                result={sheet.result}
                sourceSql={sheet.command}
                running={sheet.running}
                cancelling={sheet.cancelling}
                onRefresh={(mode) => onRefreshSheet(sheet.id, mode)}
                onCancel={onCancel}
                onStatus={onStatus}
              />
            </div>
          ) : (
            <div className="flex-1 flex items-center justify-center text-[12px] text-[var(--taomni-text-muted)]">{sheet.running ? "Running…" : sheet.error ? "See Messages." : "No result."}</div>
          )
        ) : (
          <div className="flex-1 overflow-auto taomni-scroll-y p-2 text-[12px] font-mono" style={{ fontSize: "var(--taomni-db-font-size, 12px)" }}>
            {sheet.error && <div style={{ color: "#d9534f" }}>{sheet.error}</div>}
            {sheet.warnings.map((w, i) => (<div key={i} style={{ color: "#e6a817" }}>{w}</div>))}
            {!sheet.error && sheet.warnings.length === 0 && <div className="text-[var(--taomni-text-muted)]">{sheet.result?.rowsAffected != null ? sheet.command : "No messages."}</div>}
          </div>
        )}
      </div>
    </div>
  );
}

export function StatusBar({ panel }: { panel: PanelState; }) {
  const sheet = activeSheet(panel);
  const r = sheet?.result ?? null;
  return (
    <div className="h-6 shrink-0 flex items-center gap-3 px-2 text-[11px] text-[var(--taomni-text-muted)]" style={{ background: "var(--taomni-quick-bg)", borderTop: "1px solid var(--taomni-divider)" }}>
      {sheet?.running ? (
        <span className="inline-flex items-center gap-1"><Loader2 className="w-3 h-3 animate-spin" /> {sheet.cancelling ? "Cancelling" : "Running"} {(sheet.elapsedMs / 1000).toFixed(1)}s</span>
      ) : r ? (
        <>
          {r.columns.length > 0 && <span>{r.rows.length} rows</span>}
          {r.columns.length > 0 && <span>{r.columns.length} cols</span>}
          <span>{r.durationMs} ms</span>
        </>
      ) : (
        <span>{panel.sheets.length} result sheet(s)</span>
      )}
    </div>
  );
}
