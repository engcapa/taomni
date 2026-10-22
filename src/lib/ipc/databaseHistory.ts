import { invoke } from "@tauri-apps/api/core";

// --- Database SQL History ---

export interface DbSqlHistoryEntry {
  id: string;
  savedSessionId?: string | null;
  engine: string;
  host: string;
  port: number;
  catalog?: string | null;
  databaseName?: string | null;
  schemaName?: string | null;
  sqlContent: string;
  startedAt: number;
  durationMs?: number | null;
  rowsAffected?: number | null;
  rowCount?: number | null;
  hasResultSet: boolean;
  error?: string | null;
  createdAt: number;
  panelId?: string | null;
  tabName?: string | null;
}

export async function dbAppendHistory(entry: DbSqlHistoryEntry): Promise<void> {
  return invoke<void>("db_append_history", { entry });
}

export async function dbListHistory(options: {
  savedSessionId?: string | null;
  engine?: string | null;
  limit?: number | null;
} = {}): Promise<DbSqlHistoryEntry[]> {
  return invoke<DbSqlHistoryEntry[]>("db_list_history", {
    savedSessionId: options.savedSessionId ?? null,
    engine: options.engine ?? null,
    limit: options.limit ?? null,
  });
}

export async function dbDeleteHistory(id: string): Promise<void> {
  return invoke<void>("db_delete_history", { id });
}

export async function dbClearHistory(savedSessionId?: string | null): Promise<void> {
  return invoke<void>("db_clear_history", { savedSessionId: savedSessionId ?? null });
}

export async function dbUpdateHistoryTabName(
  savedSessionId: string,
  panelId: string,
  tabName: string | null,
): Promise<number> {
  return invoke<number>("db_update_history_tab_name", { savedSessionId, panelId, tabName });
}
