import { Channel, invoke } from "@tauri-apps/api/core";
import type { DbConnectInfo } from "../../types";
import { withVaultLockedNotice } from "./vault";

// --- Database client (MySQL / PostgreSQL / PanWeiDB / Oracle / SQL Server / StarRocks / ClickHouse / Presto / Redis) ---

/** Strip the frontend-only `sessionId` to build the Rust `DbConfig` payload. */
export function toDbConfigPayload(info: DbConnectInfo): Record<string, unknown> {
  return {
    engine: info.engine,
    host: info.host,
    port: info.port,
    username: info.username ?? null,
    password: info.password ?? null,
    catalog: info.catalog ?? null,
    database: info.database ?? null,
    ssl: info.ssl ?? false,
    timeoutSecs: info.timeoutSecs ?? null,
    httpPort: info.httpPort ?? null,
    protocol: info.protocol ?? null,
    // Presto/Trino header dialect (X-Presto-* vs X-Trino-*). Must reach Rust.
    prestoDialect: info.prestoDialect ?? null,
    dbIndex: info.dbIndex ?? null,
    networkSettings: info.networkSettings ?? null,
  };
}

export interface DbConnectResult {
  ok: boolean;
}

export async function dbConnect(info: DbConnectInfo): Promise<DbConnectResult> {
  return withVaultLockedNotice(() =>
    invoke<DbConnectResult>("db_connect", {
      sessionId: info.sessionId,
      config: toDbConfigPayload(info),
    }),
  );
}

export async function dbPing(sessionId: string): Promise<string> {
  return invoke<string>("db_ping", { sessionId });
}

/**
 * One-shot connection health check used by the "Test connection" button in the
 * session editor. Opens a throwaway connection, pings it, then disconnects so
 * no handle lingers in `AppState`.
 */
export async function dbTestConnection(info: DbConnectInfo): Promise<string> {
  const probeId = `db-test-${globalThis.crypto?.randomUUID?.() ?? Date.now()}`;
  const probe: DbConnectInfo = { ...info, sessionId: probeId };
  await dbConnect(probe);
  try {
    return await dbPing(probeId);
  } finally {
    await dbDisconnect(probeId).catch(() => undefined);
  }
}

export async function dbDisconnect(sessionId: string): Promise<void> {
  return invoke("db_disconnect", { sessionId });
}

export interface DbSchema {
  name: string;
}

export interface DbCatalog {
  name: string;
}

export interface DbTable {
  name: string;
  kind: "table" | "view" | "materialized_view";
  rowCount?: number | null;
}

export interface DbColumnDescription {
  name: string;
  type: string;
  nullable: boolean;
  default: string | null;
  primaryKey: boolean;
}

export interface DbForeignKey {
  name: string;
  columns: string[];
  referencedSchema: string | null;
  referencedTable: string;
  referencedColumns: string[];
}

export interface DbIndex {
  name: string;
  columns: string[];
  unique: boolean;
}

/** A non-table schema object (routine, trigger, event, sequence, dictionary). */
export interface DbObject {
  name: string;
  /** "procedure" | "function" | "trigger" | "event" | "sequence" | "dictionary". */
  kind: string;
  /** Owning table for triggers (used to DROP/DISABLE on PostgreSQL). */
  owner?: string;
}

export interface DbColumn {
  name: string;
  type: string;
}

export interface DbQueryResult {
  columns: DbColumn[];
  rows: (string | null)[][];
  rowsAffected: number;
  durationMs: number;
  warnings: string[];
}

export interface DbResultSqlFilter {
  columnIndex: number;
  text: string;
  mode: "fuzzy" | "exact";
  selectedValues: (string | null)[];
}

export interface DbResultSqlSort {
  columnIndex: number;
  dir: "asc" | "desc";
}

export interface DbResultSqlRewriteRequest {
  engine: string;
  sourceSql: string;
  resultColumns: string[];
  visibleColumnIndexes: number[];
  globalFilterText: string;
  filters: DbResultSqlFilter[];
  sorts: DbResultSqlSort[];
}

export interface DbResultSqlRewriteResponse {
  sql: string | null;
  mode: "inline" | "unsupported";
  reason: string | null;
  warnings: string[];
}

export type DbQueryStreamEvent =
  | { kind: "columns"; columns: DbColumn[] }
  | { kind: "rows"; rows: (string | null)[][] }
  | { kind: "done"; rowsAffected: number; durationMs: number; warnings: string[] };

export async function dbListCatalogs(sessionId: string): Promise<DbCatalog[]> {
  return invoke<DbCatalog[]>("db_list_catalogs", { sessionId });
}

export async function dbListSchemas(
  sessionId: string,
  catalog?: string | null,
): Promise<DbSchema[]> {
  return invoke<DbSchema[]>("db_list_schemas", { sessionId, catalog: catalog ?? null });
}

export async function dbListTables(
  sessionId: string,
  schema?: string | null,
  catalog?: string | null,
): Promise<DbTable[]> {
  return invoke<DbTable[]>("db_list_tables", {
    sessionId,
    schema: schema ?? null,
    catalog: catalog ?? null,
  });
}

export async function dbSearchTables(
  sessionId: string,
  schema: string | null,
  catalog: string | null,
  prefix: string,
  limit: number,
): Promise<DbTable[]> {
  return invoke<DbTable[]>("db_search_tables", {
    sessionId,
    schema,
    catalog,
    prefix,
    limit,
  });
}

export async function dbDescribeTable(
  sessionId: string,
  schema: string | null,
  table: string,
  catalog?: string | null,
): Promise<DbColumnDescription[]> {
  return invoke<DbColumnDescription[]>("db_describe_table", {
    sessionId,
    schema: schema ?? null,
    table,
    catalog: catalog ?? null,
  });
}

export async function dbListForeignKeys(
  sessionId: string,
  schema: string | null,
  table: string,
  catalog?: string | null,
): Promise<DbForeignKey[]> {
  return invoke<DbForeignKey[]>("db_list_foreign_keys", {
    sessionId,
    schema: schema ?? null,
    table,
    catalog: catalog ?? null,
  });
}

export async function dbListIndexes(
  sessionId: string,
  schema: string | null,
  table: string,
): Promise<DbIndex[]> {
  return invoke<DbIndex[]>("db_list_indexes", {
    sessionId,
    schema: schema ?? null,
    table,
  });
}

export async function dbListObjects(
  sessionId: string,
  schema: string | null,
  kind: string,
): Promise<DbObject[]> {
  return invoke<DbObject[]>("db_list_objects", {
    sessionId,
    schema: schema ?? null,
    kind,
  });
}

export async function dbObjectDdl(
  sessionId: string,
  schema: string | null,
  kind: string,
  name: string,
): Promise<string> {
  return invoke<string>("db_object_ddl", {
    sessionId,
    schema: schema ?? null,
    kind,
    name,
  });
}

export async function dbTableStats(
  sessionId: string,
  schema: string | null,
  table: string,
): Promise<DbQueryResult> {
  return invoke<DbQueryResult>("db_table_stats", {
    sessionId,
    schema: schema ?? null,
    table,
  });
}

export async function dbExecute(sessionId: string, sql: string): Promise<DbQueryResult> {
  return invoke<DbQueryResult>("db_execute", { sessionId, sql });
}

export async function dbRewriteResultSql(
  request: DbResultSqlRewriteRequest,
): Promise<DbResultSqlRewriteResponse> {
  return invoke<DbResultSqlRewriteResponse>("db_rewrite_result_sql", { request });
}

export async function dbExecuteStream(
  sessionId: string,
  sql: string,
  maxRows: number | null,
  onEvent: (event: DbQueryStreamEvent) => void,
): Promise<void> {
  const channel = new Channel<DbQueryStreamEvent>();
  channel.onmessage = onEvent;
  return invoke("db_execute_stream", { sessionId, sql, maxRows: maxRows ?? null, onEvent: channel });
}

export async function dbCancel(sessionId: string): Promise<void> {
  return invoke("db_cancel", { sessionId });
}
