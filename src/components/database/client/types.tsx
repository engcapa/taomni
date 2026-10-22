import type { DbConnectInfo } from "../../../types";
import { type DbQueryResult, type DbSavedQuery } from "../../../lib/ipc";
import { type ExecutionLogRun } from "../../../lib/dbExecutionLog";
import { type SqlStatementRange } from "../../../lib/sqlStatements";
import { QUERY_WORKSPACE_CACHE_VERSION } from "./persistence";


export interface DbClientTabProps {
  tabId: string;
  info: DbConnectInfo;
  visible: boolean;
  onDetach?: () => void;
  chatToggle?: {
    open: boolean;
    onToggle: () => void;
  };
  detachedWindowControls?: {
    onReattach: () => void;
    onToggleOsFullscreen: () => void;
    osFullscreen: boolean;
  };
}


export type ResultSubTab = "results" | "messages";


export interface ResultSheet {
  id: string;
  title: string;
  baseSql: string;
  sql: string;
  sourceRef: SqlStatementSourceRef | null;
  generatedTargetPanelId: string | null;
  result: DbQueryResult | null;
  error: string | null;
  warnings: string[];
  running: boolean;
  cancelling: boolean;
  elapsedMs: number;
  resultTab: ResultSubTab;
  rowLimit: number;
  createdAt: number;
}


export interface SqlStatementSourceRef {
  id: string;
  panelId: string;
  origin: "editor" | "history" | "generated";
  sql: string;
  from: number | null;
  to: number | null;
  exactHash: string;
  historyId?: string;
  parentSheetId?: string;
}


export interface QueryExecutionSummary {
  ok: boolean;
  durationMs: number | null;
  rowsAffected: number | null;
  rowCount: number | null;
  hasResultSet: boolean;
  error: string | null;
}


export interface EditorStatementAction {
  panelId: string;
  doc: string;
  range: SqlStatementRange;
}


export interface PanelState {
  id: string;
  doc: string;
  sheets: ResultSheet[];
  activeSheetId: string | null;
  filePath: string | null;
  fileName: string | null;
  savedQuery: DbSavedQuery | null;
  displayName: string | null;
  dirty: boolean;
  createdAt: number;
  /** In-memory execution log, newest run first (not persisted). */
  log: ExecutionLogRun[];
  /** The Log tab is shown instead of the active result sheet. */
  logActive: boolean;
}


export interface QueryWorkspacePanelCache {
  id: string;
  filePath: string | null;
  fileName: string | null;
  cachePath: string | null;
}


export interface QueryWorkspaceCache {
  version: typeof QUERY_WORKSPACE_CACHE_VERSION;
  activePanelId: string | null;
  panels: QueryWorkspacePanelCache[];
}
