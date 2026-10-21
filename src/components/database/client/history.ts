import { dbAppendHistory, dbListHistory, type DbSqlHistoryEntry } from "../../../lib/ipc";
import { type PanelState, type QueryExecutionSummary } from "./types";
import { createSqlHistoryId } from "./queryModel";
import { MAX_HISTORY } from "./persistence";



export interface RefreshHistoryContext {
  setHistoryLoading: import("react").Dispatch<import("react").SetStateAction<boolean>>;
  workspaceSessionId: string;
  info: import("../../../types").DbConnectInfo;
  setHistoryEntries: import("react").Dispatch<import("react").SetStateAction<DbSqlHistoryEntry[]>>;
  setStatusMessage: (message: string) => void;
}


export function createRefreshHistory(controllerContext: RefreshHistoryContext): () => Promise<void> {
  return async () => {
    controllerContext.setHistoryLoading(true);
    try {
      const entries = await dbListHistory({
        savedSessionId: controllerContext.workspaceSessionId,
        engine: controllerContext.info.engine,
        limit: MAX_HISTORY,
      });
      controllerContext.setHistoryEntries(entries);
    } catch (err) {
      controllerContext.setStatusMessage(`Query history load failed: ${String(err)}`);
    } finally {
      controllerContext.setHistoryLoading(false);
    }
  };
}



export interface AppendSqlHistoryContext {
  panelsRef: import("react").RefObject<PanelState[]>;
  workspaceSessionId: string;
  info: import("../../../types").DbConnectInfo;
  activeSchema: string | null;
  historyPanelId: string | null;
  refreshHistory: () => Promise<void>;
  setStatusMessage: (message: string) => void;
}


export function createAppendSqlHistory(controllerContext: AppendSqlHistoryContext): (sql: string, startedAt: number, summary: QueryExecutionSummary, panelId: string) => Promise<void> {
  return async (
      sql: string,
      startedAt: number,
      summary: QueryExecutionSummary,
      panelId: string,
    ) => {
      const sourcePanel = controllerContext.panelsRef.current.find((panel) => panel.id === panelId);
      const entry: DbSqlHistoryEntry = {
        id: createSqlHistoryId(),
        savedSessionId: controllerContext.workspaceSessionId,
        engine: controllerContext.info.engine,
        host: controllerContext.info.host,
        port: controllerContext.info.port,
        catalog: controllerContext.info.catalog ?? null,
        databaseName: controllerContext.info.database ?? null,
        schemaName: controllerContext.activeSchema ?? null,
        sqlContent: sql,
        startedAt,
        durationMs: summary.durationMs,
        rowsAffected: summary.rowsAffected,
        rowCount: summary.rowCount,
        hasResultSet: summary.hasResultSet,
        error: summary.error,
        createdAt: Date.now(),
        panelId,
        tabName: sourcePanel?.displayName ?? null,
      };
      try {
        await dbAppendHistory(entry);
        if (controllerContext.historyPanelId) {
          await controllerContext.refreshHistory();
        }
      } catch (err) {
        controllerContext.setStatusMessage(`Query history save failed: ${String(err)}`);
      }
    };
}
