import { dbExecuteStream, dbCancel, type DbTxStatus } from "../../../lib/ipc";
import { type SqlEditorRunContext } from "../SqlEditorPanel";
import { type QueryRefreshMode } from "../QueryResultGrid";
import { choiceAppDialog, confirmAppDialog } from "../../../lib/appDialogs";
import { dangerousConfirmationMessage } from "../../../lib/sqlDangerousStatements";
import { type ExecutionLogRun, createExecutionRun, finishExecutionRun, patchExecutionEntry, prependExecutionRun, replaceExecutionRun } from "../../../lib/dbExecutionLog";
import { type SqlStatementRange } from "../../../lib/sqlStatements";
import { type PanelState, type ResultSheet, type QueryExecutionSummary, type SqlStatementSourceRef } from "./types";
import { emptyQueryResult, sourceRefForRange, newResultSheet } from "./queryModel";
import { MAX_HISTORY } from "./persistence";
import { successMessage } from "./formatting";



export interface StreamQueryIntoSheetContext {
  patchSheet: (panelId: string, sheetId: string, patch: Partial<ResultSheet>) => void;
  timersRef: import("react").RefObject<Record<string, number>>;
  connectionSessionId: string | null;
  updateSheet: (panelId: string, sheetId: string, updater: (sheet: ResultSheet) => ResultSheet) => void;
  metadataCache: import("../../../lib/dbMetadataCache").DbMetadataCache | null;
  info: import("../../../types").DbConnectInfo;
  activeSchema: string | null;
}


export function createStreamQueryIntoSheet(controllerContext: StreamQueryIntoSheetContext): (panelId: string, sheetId: string, sql: string, maxRows: number, resetRowsOnColumns?: boolean) => Promise<QueryExecutionSummary> {
  return async (
      panelId: string,
      sheetId: string,
      sql: string,
      maxRows: number,
      resetRowsOnColumns = false,
    ): Promise<QueryExecutionSummary> => {
      const started = Date.now();
      const timer = setInterval(() => {
        controllerContext.patchSheet(panelId, sheetId, { elapsedMs: Date.now() - started });
      }, 100);
      controllerContext.timersRef.current[sheetId] = timer;
      let sawDone = false;
      let columnCount = 0;
      let rowCount = 0;
      let summary: QueryExecutionSummary | null = null;
      try {
        if (!controllerContext.connectionSessionId) throw new Error("Database connection is still starting.");
        await dbExecuteStream(controllerContext.connectionSessionId, sql, maxRows, (event) => {
          if (event.kind === "columns") {
            columnCount = event.columns.length;
            controllerContext.updateSheet(panelId, sheetId, (current) => {
              const result = current.result ?? emptyQueryResult();
              return {
                ...current,
                result: {
                  ...result,
                  columns: event.columns,
                  rows: resetRowsOnColumns ? [] : result.rows,
                },
              };
            });
          } else if (event.kind === "rows") {
            rowCount += event.rows.length;
            controllerContext.updateSheet(panelId, sheetId, (current) => {
              const result = current.result ?? emptyQueryResult();
              const remaining = Math.max(0, current.rowLimit - result.rows.length);
              const rows = remaining > 0 ? event.rows.slice(0, remaining) : [];
              return { ...current, result: { ...result, rows: [...result.rows, ...rows] } };
            });
          } else {
            sawDone = true;
            const warnings = event.warnings ?? [];
            const elapsedMs = Date.now() - started;
            summary = {
              ok: true,
              durationMs: event.durationMs,
              rowsAffected: event.rowsAffected,
              rowCount,
              hasResultSet: columnCount > 0,
              error: null,
            };
            controllerContext.updateSheet(panelId, sheetId, (current) => {
              const result = current.result ?? emptyQueryResult();
              return {
                ...current,
                result: {
                  ...result,
                  rowsAffected: event.rowsAffected,
                  durationMs: event.durationMs,
                  warnings,
                },
                warnings,
                running: false,
                cancelling: false,
                elapsedMs,
                error: null,
                resultTab: warnings.length > 0 ? "messages" : "results",
              };
            });
          }
        });
        if (!sawDone) {
          controllerContext.patchSheet(panelId, sheetId, { running: false, cancelling: false, elapsedMs: Date.now() - started });
          summary = {
            ok: true,
            durationMs: Date.now() - started,
            rowsAffected: null,
            rowCount,
            hasResultSet: columnCount > 0,
            error: null,
          };
        }
        controllerContext.metadataCache?.invalidateSql(sql, {
          engine: controllerContext.info.engine,
          activeSchema: controllerContext.activeSchema,
          defaultCatalog: controllerContext.info.catalog,
        });
        return summary ?? {
          ok: true,
          durationMs: Date.now() - started,
          rowsAffected: null,
          rowCount,
          hasResultSet: columnCount > 0,
          error: null,
        };
      } catch (err) {
        const error = String(err);
        controllerContext.patchSheet(panelId, sheetId, {
          running: false,
          cancelling: false,
          elapsedMs: Date.now() - started,
          error,
          warnings: [],
          resultTab: "messages",
        });
        return {
          ok: false,
          durationMs: Date.now() - started,
          rowsAffected: null,
          rowCount,
          hasResultSet: columnCount > 0,
          error,
        };
      } finally {
        if (controllerContext.timersRef.current[sheetId] === timer) {
          clearInterval(timer);
          delete controllerContext.timersRef.current[sheetId];
        }
      }
    };
}



export interface RunQueryContext {
  panelsRef: import("react").RefObject<PanelState[]>;
  statementRangesForRun: (sqlText: string, context?: SqlEditorRunContext) => SqlStatementRange[];
  setStatusMessage: (message: string) => void;
  historyRef: import("react").RefObject<Record<string, string[]>>;
  setPanels: import("react").Dispatch<import("react").SetStateAction<PanelState[]>>;
  cancelRequestedRef: import("react").RefObject<Record<string, boolean>>;
  rowLimit: number;
  tabLimit: number;
  streamQueryIntoSheet: (panelId: string, sheetId: string, sql: string, maxRows: number, resetRowsOnColumns?: boolean) => Promise<QueryExecutionSummary>;
  appendSqlHistory: (sql: string, startedAt: number, summary: QueryExecutionSummary, panelId: string) => Promise<void>;
  txStatusRef: import("react").RefObject<DbTxStatus | null>;
  refreshTxStatus: () => Promise<void>;
}


export function createRunQuery(controllerContext: RunQueryContext): (panelId: string, sqlText: string, options?: { context?: SqlEditorRunContext; origin?: SqlStatementSourceRef["origin"]; historyId?: string; parentSheetId?: string; sheetTitle?: string; }) => Promise<void> {
  return async (
      panelId: string,
      sqlText: string,
      options: {
        context?: SqlEditorRunContext;
        origin?: SqlStatementSourceRef["origin"];
        historyId?: string;
        parentSheetId?: string;
        /** Overrides the default "Result N" title (e.g. "Explain"). */
        sheetTitle?: string;
      } = {},
    ) => {
      const trimmed = sqlText.trim();
      if (!trimmed) return;
      const panel = controllerContext.panelsRef.current.find((p) => p.id === panelId);
      if (panel?.sheets.some((sheet) => sheet.running)) return;
      const statementRanges = controllerContext.statementRangesForRun(sqlText, options.context);
      if (statementRanges.length === 0) return;
      const dangerMessage = dangerousConfirmationMessage(statementRanges.map((range) => range.sql));
      if (dangerMessage) {
        const confirmed = await confirmAppDialog({
          title: "Confirm dangerous statements",
          message: dangerMessage,
          confirmLabel: "Execute",
          danger: true,
        });
        if (!confirmed) {
          controllerContext.setStatusMessage("Run canceled: dangerous statements were not executed.");
          return;
        }
      }
      // Record in-memory history per executable statement (newest first, dedup consecutive).
      const panelHistory = controllerContext.historyRef.current[panelId] ?? [];
      const nextHistory = [...panelHistory];
      for (const range of [...statementRanges].reverse()) {
        if (nextHistory[0] !== range.sql) {
          nextHistory.unshift(range.sql);
        }
      }
      controllerContext.historyRef.current[panelId] = nextHistory.slice(0, MAX_HISTORY);

      const baseOrdinal = panel?.sheets.length ?? 0;
      let run = createExecutionRun(statementRanges.map((range) => range.sql), Date.now());
      const publishRun = (next: ExecutionLogRun, logActive?: boolean) => {
        run = next;
        controllerContext.setPanels((prev) =>
          prev.map((p) =>
            p.id === panelId
              ? {
                  ...p,
                  log: p.log.some((candidate) => candidate.id === next.id)
                    ? replaceExecutionRun(p.log, next)
                    : prependExecutionRun(p.log, next),
                  logActive: logActive ?? p.logActive,
                }
              : p,
          ),
        );
      };
      // Read through a closure: the flag is flipped asynchronously by cancelQuery.
      const cancelRequested = () => controllerContext.cancelRequestedRef.current[panelId] === true;
      controllerContext.cancelRequestedRef.current[panelId] = false;
      let skipAllErrors = false;
      publishRun(run);
      for (const [index, statement] of statementRanges.entries()) {
        const sourceRef = sourceRefForRange(panelId, statement, options.origin ?? "editor", {
          historyId: options.historyId,
          parentSheetId: options.parentSheetId,
        });
        const sheet = newResultSheet(statement.sql, baseOrdinal + index + 1, controllerContext.rowLimit, sourceRef);
        if (options.sheetTitle) sheet.title = options.sheetTitle;
        const entryId = run.entries[index].id;
        controllerContext.setPanels((prev) =>
          prev.map((p) => {
            if (p.id !== panelId) return p;
            const sheets = [...p.sheets, sheet].slice(-controllerContext.tabLimit);
            return {
              ...p,
              sheets,
              activeSheetId: sheet.id,
              // A run starts on its results; a Log opened mid-run stays open.
              logActive: index === 0 ? false : p.logActive,
            };
          }),
        );
        publishRun(patchExecutionEntry(run, entryId, { status: "running", startedAt: sheet.createdAt, sheetId: sheet.id }));
        const summary = await controllerContext.streamQueryIntoSheet(panelId, sheet.id, statement.sql, controllerContext.rowLimit);
        const cancelled = !summary.ok && cancelRequested();
        publishRun(
          patchExecutionEntry(run, entryId, {
            status: summary.ok ? "success" : cancelled ? "cancelled" : "failed",
            durationMs: summary.durationMs,
            rowCount: summary.hasResultSet ? summary.rowCount : null,
            rowsAffected: summary.rowsAffected,
            message: summary.ok ? successMessage(summary) : summary.error,
          }),
        );
        await controllerContext.appendSqlHistory(statement.sql, sheet.createdAt, summary, panelId);
        if (summary.ok) continue;
        const hasMore = index < statementRanges.length - 1;
        if (cancelled || !hasMore) break;
        if (!skipAllErrors) {
          const choice = await choiceAppDialog({
            title: "Statement failed",
            message: `Statement ${index + 1} of ${statementRanges.length} failed:\n${summary.error ?? "Unknown error"}\n\nSkip continues with the next statement. Skip all also ignores later errors in this run.`,
            primaryLabel: "Skip all",
            secondaryLabel: "Skip",
            cancelLabel: "Stop",
          });
          if (choice === null) break;
          if (choice === "primary") skipAllErrors = true;
        }
        publishRun(patchExecutionEntry(run, entryId, { message: `${summary.error ?? "Unknown error"} (skipped, run continued)` }));
      }
      const finished = finishExecutionRun(run, Date.now());
      const needsAttention = finished.entries.some((entry) => entry.status === "failed" || entry.status === "cancelled");
      publishRun(finished, needsAttention ? true : undefined);
      if (controllerContext.txStatusRef.current?.manual) await controllerContext.refreshTxStatus();
    };
}



export interface CancelQueryContext {
  panelsRef: import("react").RefObject<PanelState[]>;
  cancelRequestedRef: import("react").RefObject<Record<string, boolean>>;
  setPanels: import("react").Dispatch<import("react").SetStateAction<PanelState[]>>;
  connectionSessionId: string | null;
}


export function createCancelQuery(controllerContext: CancelQueryContext): (panelId?: string) => void {
  return (panelId?: string) => {
    for (const panel of controllerContext.panelsRef.current) {
      if ((!panelId || panel.id === panelId) && panel.sheets.some((sheet) => sheet.running)) {
        controllerContext.cancelRequestedRef.current[panel.id] = true;
      }
    }
    controllerContext.setPanels((prev) =>
      prev.map((p) =>
        panelId && p.id !== panelId
          ? p
          : {
              ...p,
              sheets: p.sheets.map((sheet) => (sheet.running ? { ...sheet, cancelling: true } : sheet)),
            },
      ),
    );
    if (controllerContext.connectionSessionId) {
      void dbCancel(controllerContext.connectionSessionId).catch(() => undefined);
    }
  };
}



export interface RefreshSheetContext {
  panelsRef: import("react").RefObject<PanelState[]>;
  rowLimit: number;
  timersRef: import("react").RefObject<Record<string, number>>;
  patchSheet: (panelId: string, sheetId: string, patch: Partial<ResultSheet>) => void;
  streamQueryIntoSheet: (panelId: string, sheetId: string, sql: string, maxRows: number, resetRowsOnColumns?: boolean) => Promise<QueryExecutionSummary>;
}


export function createRefreshSheet(controllerContext: RefreshSheetContext): (panelId: string, sheetId: string, mode: QueryRefreshMode, sqlOverride?: string) => Promise<void> {
  return async (panelId: string, sheetId: string, mode: QueryRefreshMode, sqlOverride?: string) => {
      const panel = controllerContext.panelsRef.current.find((p) => p.id === panelId);
      const sheet = panel?.sheets.find((candidate) => candidate.id === sheetId);
      const trimmed = (sqlOverride ?? sheet?.sql ?? "").trim();
      if (!panel || !sheet || !trimmed) return;
      if (panel.sheets.some((candidate) => candidate.running)) return;

      const effectiveLimit = mode === "currentLimit" ? controllerContext.rowLimit : sheet.rowLimit;
      if (controllerContext.timersRef.current[sheetId]) {
        clearInterval(controllerContext.timersRef.current[sheetId]);
        delete controllerContext.timersRef.current[sheetId];
      }
      controllerContext.patchSheet(panelId, sheetId, {
        sql: trimmed,
        result: mode === "clearView" ? emptyQueryResult() : sheet.result ?? emptyQueryResult(),
        error: null,
        warnings: [],
        running: true,
        cancelling: false,
        elapsedMs: 0,
        createdAt: Date.now(),
        rowLimit: effectiveLimit,
        resultTab: "results",
      });

      await controllerContext.streamQueryIntoSheet(panelId, sheetId, trimmed, effectiveLimit, true);
    };
}
