import { invoke } from "@tauri-apps/api/core";

// --- Database Saved Queries ---

export type DbSavedQueryScope = "connection" | "engine";

export interface DbSavedQuery {
  id: string;
  scopeType: DbSavedQueryScope;
  scopeId: string;
  engine: string;
  catalogName?: string | null;
  databaseName?: string | null;
  schemaName?: string | null;
  namespaceKey: string;
  name: string;
  content: string;
  remarks?: string | null;
  tags: string[];
  revision: number;
  archivedAt?: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface DbListSavedQueriesRequest {
  connectionId?: string | null;
  engine?: string | null;
  catalogName?: string | null;
  databaseName?: string | null;
  schemaName?: string | null;
  includeAllNamespaces: boolean;
  includeArchived: boolean;
}

export async function dbListSavedQueries(
  request: DbListSavedQueriesRequest,
): Promise<DbSavedQuery[]> {
  return invoke<DbSavedQuery[]>("db_list_saved_queries", { request });
}

export async function dbGetSavedQuery(id: string): Promise<DbSavedQuery | null> {
  return invoke<DbSavedQuery | null>("db_get_saved_query", { id });
}

export async function dbSaveSavedQuery(query: DbSavedQuery): Promise<DbSavedQuery> {
  return invoke<DbSavedQuery>("db_save_saved_query", { query });
}

export async function dbArchiveSavedQuery(
  id: string,
  revision: number,
  archivedAt: number | null,
  updatedAt: number,
): Promise<number> {
  return invoke<number>("db_archive_saved_query", { id, revision, archivedAt, updatedAt });
}

export async function dbDeleteSavedQuery(id: string): Promise<boolean> {
  return invoke<boolean>("db_delete_saved_query", { id });
}
