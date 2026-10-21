import type { DbConnectInfo } from "../../../types";
import { type DbQueryResult, type DbQueryWorkspaceTab } from "../../../lib/ipc";
import { type SqlStatementRange } from "../../../lib/sqlStatements";
import { asSqlEngine, qualifiedName as dialectQualifiedName, setDefaultSchemaSql } from "../../../lib/sqlDialect";
import { type SqlStatementSourceRef, type ResultSheet, type PanelState } from "./types";
import { formatFullDateTime, formatDurationMs } from "./formatting";


export function hashSqlText(sql: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < sql.length; i += 1) {
    hash ^= sql.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}


export function replacementEndWithExistingTerminator(sourceDoc: string, to: number, replacementSql: string): number {
  if (!replacementSql.trimEnd().endsWith(";")) return to;
  const trailingTerminator = /^[ \t]*;/.exec(sourceDoc.slice(to));
  return trailingTerminator ? to + trailingTerminator[0].length : to;
}


export function sourceRefForRange(
  panelId: string,
  range: SqlStatementRange,
  origin: SqlStatementSourceRef["origin"] = "editor",
  patch: Partial<Pick<SqlStatementSourceRef, "historyId" | "parentSheetId">> = {},
): SqlStatementSourceRef {
  const suffix = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return {
    id: `${panelId}:${range.from}:${range.to}:${hashSqlText(range.sql)}:${suffix}`,
    panelId,
    origin,
    sql: range.sql,
    from: range.from,
    to: range.to,
    exactHash: hashSqlText(range.sql),
    ...patch,
  };
}


export function resultSheetTimingTitle(sheet: ResultSheet): string {
  const lines = [`Started: ${formatFullDateTime(sheet.createdAt)}`];
  const duration = sheet.running
    ? formatDurationMs(sheet.elapsedMs)
    : formatDurationMs(sheet.result?.durationMs);
  if (duration) {
    lines.push(`${sheet.running ? "Elapsed" : "Duration"}: ${duration}`);
  }
  if (sheet.sql.trim()) {
    lines.push("", sheet.sql);
  }
  return lines.join("\n");
}


export function qualifiedName(engine: string, schema: string | null, table: string, catalog?: string | null): string {
  return dialectQualifiedName(asSqlEngine(engine), { catalog, schema, name: table });
}


export function schemaSwitchSql(engine: string, schema: string, catalog?: string | null): string {
  return setDefaultSchemaSql(asSqlEngine(engine), schema, catalog);
}


export function engineUsesDatabaseAsSchema(engine: string): boolean {
  return engine === "MySQL" || engine === "StarRocks" || engine === "ClickHouse" || engine === "Presto";
}


export function initialActiveSchema(info: DbConnectInfo): string | null {
  return engineUsesDatabaseAsSchema(info.engine) ? (info.database ?? null) : null;
}


export function unquoteIdent(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("`") && trimmed.endsWith("`")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"))
  ) {
    return trimmed.slice(1, -1).replace(/""/g, '"').replace(/``/g, "`").replace(/]]/g, "]");
  }
  return trimmed;
}


export function parseEditableSelectTarget(sql: string): { schema: string | null; table: string } | null {
  const cleaned = sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--.*$/gm, " ")
    .trim();
  if (!/^select\b/i.test(cleaned)) return null;
  if (/\b(join|union|group\s+by|having)\b/i.test(cleaned)) return null;
  const ident = String.raw`(?:"[^"]+"|` + "`[^`]+`" + String.raw`|\[[^\]]+\]|[A-Za-z_][\w$]*)`;
  const match = cleaned.match(new RegExp(String.raw`\bfrom\s+(${ident})(?:\s*\.\s*(${ident}))?(?:\s*\.\s*(${ident}))?`, "i"));
  if (!match) return null;
  return match[3]
    ? { schema: unquoteIdent(match[2]), table: unquoteIdent(match[3]) }
    : match[2]
    ? { schema: unquoteIdent(match[1]), table: unquoteIdent(match[2]) }
    : { schema: null, table: unquoteIdent(match[1]) };
}


export function newPanel(patch: Partial<PanelState> = {}): PanelState {
  return {
    id: globalThis.crypto?.randomUUID?.() ?? `panel-${Date.now()}-${Math.random()}`,
    doc: "",
    sheets: [],
    activeSheetId: null,
    filePath: null,
    fileName: null,
    savedQuery: null,
    displayName: null,
    dirty: false,
    createdAt: Date.now(),
    log: [],
    logActive: false,
    ...patch,
  };
}


export function workspaceTabFromPanel(
  workspaceId: string,
  panel: PanelState,
  tabOrder: number,
  content: string,
  updatedAt: number,
  dirty = panel.dirty,
): DbQueryWorkspaceTab {
  return {
    workspaceId,
    panelId: panel.id,
    tabOrder,
    content,
    filePath: panel.filePath,
    fileName: panel.fileName,
    savedQueryId: panel.savedQuery?.id ?? null,
    displayName: panel.displayName,
    dirty,
    isOpen: true,
    closedAt: null,
    createdAt: panel.createdAt,
    updatedAt,
  };
}


export function newResultSheet(
  sql: string,
  ordinal: number,
  rowLimit: number,
  sourceRef: SqlStatementSourceRef | null = null,
): ResultSheet {
  return {
    id: globalThis.crypto?.randomUUID?.() ?? `sheet-${Date.now()}-${Math.random()}`,
    title: `Result ${ordinal}`,
    baseSql: sql,
    sql,
    sourceRef,
    generatedTargetPanelId: null,
    result: emptyQueryResult(),
    error: null,
    warnings: [],
    running: true,
    cancelling: false,
    elapsedMs: 0,
    resultTab: "results",
    rowLimit,
    createdAt: Date.now(),
  };
}


export function activeSheet(panel: PanelState): ResultSheet | null {
  return panel.sheets.find((sheet) => sheet.id === panel.activeSheetId) ?? panel.sheets.at(-1) ?? null;
}


export function emptyQueryResult(): DbQueryResult {
  return {
    columns: [],
    rows: [],
    rowsAffected: 0,
    durationMs: 0,
    warnings: [],
  };
}


export function createSqlHistoryId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `sql-history-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}


export function uniqueResultColumnNames(result: DbQueryResult): string[] {
  const seen = new Map<string, number>();
  return result.columns.map((column, index) => {
    const base = column.name || `column_${index + 1}`;
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return count === 0 ? base : `${base}_${count + 1}`;
  });
}


export function resultToJsonText(result: DbQueryResult): string {
  const names = uniqueResultColumnNames(result);
  const rows = result.rows.map((row) =>
    Object.fromEntries(names.map((name, index) => [name, row[index] ?? null])),
  );
  return JSON.stringify(rows, null, 2);
}


/** Engines whose sessions support the manual-commit toolbar (DB-TX-001). */
export function supportsManualCommit(engine: string): boolean {
  return engine === "MySQL" || engine === "PostgreSQL";
}
