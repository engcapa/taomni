import { type MouseEvent as ReactMouseEvent } from "react";
import { Clock, X, Loader2, Trash2, ScrollText } from "lucide-react";
import { type DbResultSqlRewriteRequest } from "../../../lib/ipc";
import { QueryResultGrid, type QueryGridCommitPayload, type QueryGeneratedSqlSyncMode, type QueryRefreshMode } from "../QueryResultGrid";
import { useContextMenu, type MenuItem } from "../../ContextMenu";
import { useT } from "../../../lib/i18n";
import { type GridChangePreview } from "../../../lib/dbGridChanges";
import { ExecutionLogView } from "../ExecutionLogView";
import { type PanelState, type ResultSubTab } from "./types";
import { activeSheet, resultSheetTimingTitle } from "./queryModel";
import { formatClockTime, formatFullDateTime, formatDurationMs } from "./formatting";


export function ResultArea({
  panel,
  sqlEngine,
  onSheetSelect,
  onSheetClose,
  onCloseSheets,
  onTabChange,
  onRefreshSheet,
  onCommitGridChanges,
  onPreviewGridChanges,
  onGeneratedSqlSync,
  onGeneratedSqlQuery,
  onCancel,
  onStatus,
  onShowLog,
}: {
  panel: PanelState;
  sqlEngine: string;
  onShowLog: () => void;
  onSheetSelect: (sheetId: string) => void;
  onSheetClose: (sheetId: string) => void;
  onCloseSheets: (sheetIds: string[]) => void;
  onTabChange: (sheetId: string, tab: ResultSubTab) => void;
  onRefreshSheet: (sheetId: string, mode: QueryRefreshMode) => void;
  onCommitGridChanges: (sheetId: string, payload: QueryGridCommitPayload) => Promise<void>;
  onPreviewGridChanges: (sheetId: string, payload: QueryGridCommitPayload) => Promise<GridChangePreview>;
  onGeneratedSqlSync: (sheetId: string, sql: string, mode: QueryGeneratedSqlSyncMode) => void;
  onGeneratedSqlQuery: (
    sheetId: string,
    sql: string,
    rewriteRequest?: DbResultSqlRewriteRequest,
  ) => void | Promise<void>;
  onCancel: () => void;
  onStatus: (message: string) => void;
}) {
  const t = useT();
  const sheetMenu = useContextMenu();
  const showingLog = panel.logActive && panel.log.length > 0;
  const sheet = showingLog ? null : activeSheet(panel);
  const tab = "h-6 px-3 text-[11px] inline-flex items-center";
  const latestRun = panel.log[0] ?? null;
  const latestRunHasFailure = !!latestRun?.entries.some((entry) => entry.status === "failed" || entry.status === "cancelled");
  const waitingForFirstResult =
    !!sheet?.running &&
    sheet.result !== null &&
    sheet.result.columns.length === 0 &&
    sheet.result.rows.length === 0;

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
    <div
      className="h-full flex flex-col min-h-0"
      style={{ background: "var(--taomni-bg)", fontSize: "var(--taomni-db-font-size, 12px)" }}
    >
      {sheetMenu.render}
      <div
        className="h-7 shrink-0 flex items-end gap-1 px-1 overflow-hidden"
        style={{ background: "var(--taomni-chrome-bg)", borderBottom: "1px solid var(--taomni-divider)" }}
      >
        {panel.log.length > 0 && (
          <button
            type="button"
            data-testid="result-log-tab"
            data-active={showingLog ? "true" : "false"}
            className="h-6 shrink-0 px-2 inline-flex items-center gap-1 text-[11px]"
            style={{
              background: showingLog ? "var(--taomni-tab-active)" : "var(--taomni-tab-inactive)",
              color: showingLog ? "var(--taomni-accent)" : "var(--taomni-text-muted)",
              border: "1px solid var(--taomni-tab-border)",
              borderBottom: showingLog ? "1px solid var(--taomni-tab-active)" : "1px solid var(--taomni-divider)",
              borderTopLeftRadius: 4,
              borderTopRightRadius: 4,
            }}
            onClick={onShowLog}
            title="Execution log"
          >
            <ScrollText className="w-3 h-3" />
            Log
            {latestRunHasFailure && <span className="text-[10px]" style={{ color: "#d9534f" }}>●</span>}
          </button>
        )}
        {panel.sheets.length === 0 ? (
          panel.log.length === 0 && (
            <span className="px-2 pb-1 text-[11px] text-[var(--taomni-text-muted)]">Result sheets</span>
          )
        ) : (
          panel.sheets.map((resultSheet) => {
            const active = resultSheet.id === sheet?.id;
            return (
              <button
                key={resultSheet.id}
                type="button"
                data-testid="result-sheet-tab"
                data-sheet-id={resultSheet.id}
                className="h-6 max-w-[220px] min-w-0 px-2 inline-flex items-center gap-1 overflow-hidden text-[11px]"
                style={{
                  background: active ? "var(--taomni-tab-active)" : "var(--taomni-tab-inactive)",
                  color: active ? "var(--taomni-accent)" : "var(--taomni-text-muted)",
                  border: "1px solid var(--taomni-tab-border)",
                  borderBottom: active ? "1px solid var(--taomni-tab-active)" : "1px solid var(--taomni-divider)",
                  borderTopLeftRadius: 4,
                  borderTopRightRadius: 4,
                }}
                onClick={() => onSheetSelect(resultSheet.id)}
                onContextMenu={(event) => openSheetMenu(event, resultSheet.id)}
                title={resultSheetTimingTitle(resultSheet)}
              >
                <span className="truncate">{resultSheet.title}</span>
                <span className="shrink-0 font-mono text-[10px] opacity-80">
                  {formatClockTime(resultSheet.createdAt)}
                </span>
                {resultSheet.running && <Loader2 className="w-3 h-3 shrink-0 animate-spin" />}
                {(resultSheet.error || resultSheet.warnings.length > 0) && (
                  <span className="text-[10px] shrink-0">●</span>
                )}
                <X
                  className="w-3 h-3 shrink-0 hover:text-[var(--taomni-text)]"
                  onClick={(event) => {
                    event.stopPropagation();
                    onSheetClose(resultSheet.id);
                  }}
                />
              </button>
            );
          })
        )}
      </div>
      {sheet && (
        <div className="h-7 shrink-0 flex items-center gap-1 px-1" style={{ borderBottom: "1px solid var(--taomni-divider)" }}>
          <button
            type="button"
            className={tab}
            style={{ color: sheet.resultTab === "results" ? "var(--taomni-accent)" : "var(--taomni-text-muted)" }}
            onClick={() => onTabChange(sheet.id, "results")}
          >
            Results
          </button>
          <button
            type="button"
            className={tab}
            style={{ color: sheet.resultTab === "messages" ? "var(--taomni-accent)" : "var(--taomni-text-muted)" }}
            onClick={() => onTabChange(sheet.id, "messages")}
          >
            Messages{(sheet.error || sheet.warnings.length > 0) ? " ●" : ""}
          </button>
          <span
            className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap px-1.5 text-[10px] text-[var(--taomni-text-muted)] font-mono"
            title={resultSheetTimingTitle(sheet)}
          >
            <Clock className="w-3 h-3" />
            {formatFullDateTime(sheet.createdAt)}
            {sheet.running
              ? ` | ${formatDurationMs(sheet.elapsedMs) ?? "0 ms"}`
              : sheet.result
                ? ` | ${formatDurationMs(sheet.result.durationMs) ?? "0 ms"}`
                : ""}
          </span>
          <span className="ml-auto truncate px-2 text-[10px] text-[var(--taomni-text-muted)] font-mono" title={sheet.sql}>
            {sheet.sql.replace(/\s+/g, " ")}
          </span>
        </div>
      )}
      <div className="flex-1 min-h-0 flex flex-col">
        {showingLog ? (
          <ExecutionLogView runs={panel.log} onSelectSheet={onSheetSelect} />
        ) : !sheet ? (
          <div className="flex-1 flex items-center justify-center text-[12px] text-[var(--taomni-text-muted)]">
            Run a query to create a result sheet.
          </div>
        ) : sheet.resultTab === "results" ? (
          waitingForFirstResult ? (
            <div className="flex-1 flex items-center justify-center text-[12px] text-[var(--taomni-text-muted)]">
              {sheet.cancelling ? "Cancelling…" : "Running…"}
            </div>
          ) : sheet.result ? (
            <div className={`flex-1 min-h-0 flex flex-col ${sheet.cancelling ? "opacity-50 pointer-events-none" : ""}`}>
              <QueryResultGrid
                result={sheet.result}
                sourceSql={sheet.sql}
                baseSql={sheet.baseSql}
                sqlEngine={sqlEngine}
                running={sheet.running}
                cancelling={sheet.cancelling}
                onRefresh={(mode) => onRefreshSheet(sheet.id, mode)}
                onCancel={onCancel}
                onCommitChanges={(payload) => onCommitGridChanges(sheet.id, payload)}
                onPreviewChanges={(payload) => onPreviewGridChanges(sheet.id, payload)}
                onGeneratedSqlSync={(sql, mode) => onGeneratedSqlSync(sheet.id, sql, mode)}
                onGeneratedSqlQuery={(sql, rewriteRequest) => onGeneratedSqlQuery(sheet.id, sql, rewriteRequest)}
                onStatus={onStatus}
              />
            </div>
          ) : (
            <div className="flex-1 flex items-center justify-center text-[12px] text-[var(--taomni-text-muted)]">
              {sheet.running ? "Running…" : "Run a query to see results."}
            </div>
          )
        ) : (
          <div
            className="flex-1 overflow-auto taomni-scroll-y p-2 text-[12px] font-mono"
            style={{ fontSize: "var(--taomni-db-font-size, 12px)" }}
          >
            {sheet.error && <div style={{ color: "#d9534f" }}>{sheet.error}</div>}
            {sheet.warnings.map((w, i) => (
              <div key={i} style={{ color: "#e6a817" }}>
                {w}
              </div>
            ))}
            {!sheet.error && sheet.warnings.length === 0 && (
              <div className="text-[var(--taomni-text-muted)]">No messages.</div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
