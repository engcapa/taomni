import { type DbQueryResult, type DbSavedQuery } from "../../../lib/ipc";

export const MAX_HISTORY = 200;

export const DEFAULT_ROW_LIMIT = 50;

export const HBASE_TAB_LIMIT_SCOPE = "HBaseShell";

export type ResultSubTab = "results" | "messages";

export interface ResultSheet {
  id: string;
  title: string;
  command: string;
  result: DbQueryResult | null;
  error: string | null;
  warnings: string[];
  running: boolean;
  cancelling: boolean;
  elapsedMs: number;
  resultTab: ResultSubTab;
  createdAt: number;
}

export interface PanelState {
  id: string;
  doc: string;
  savedQueryId: string | null;
  savedQuery: DbSavedQuery | null;
  sheets: ResultSheet[];
  activeSheetId: string | null;
}

export function uid(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function createRuntimeHBaseSessionId(baseSessionId: string): string {
  return `${baseSessionId}::${uid()}`;
}

export function newSheet(command: string, ordinal: number): ResultSheet {
  return {
    id: uid(),
    title: `Result ${ordinal}`,
    command,
    result: null,
    error: null,
    warnings: [],
    running: true,
    cancelling: false,
    elapsedMs: 0,
    resultTab: "results",
    createdAt: Date.now(),
  };
}

export function newPanel(doc = "list", savedQuery: DbSavedQuery | null = null): PanelState {
  return {
    id: uid(),
    doc,
    savedQueryId: savedQuery?.id ?? null,
    savedQuery,
    sheets: [],
    activeSheetId: null,
  };
}

export function activeSheet(panel: PanelState): ResultSheet | null {
  return panel.sheets.find((s) => s.id === panel.activeSheetId) ?? null;
}
