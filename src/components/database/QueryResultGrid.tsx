import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from "react";
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Ban,
  BarChart3,
  Check,
  ChevronDown,
  Columns2,
  Copy,
  Download,
  Edit3,
  ExternalLink,
  FileText,
  FileSpreadsheet,
  Filter,
  FolderOpen,
  List,
  Loader2,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Search,
  Sigma,
  Table2,
  Trash2,
  X,
} from "lucide-react";
import type { DbColumn, DbQueryResult } from "../../lib/ipc";
import {
  readFileBytes,
  selectFilePath,
  selectSaveFilePath,
  temporaryFilePath,
  writeStreamAbort,
  writeStreamAppend,
  writeStreamClose,
  writeStreamOpen,
} from "../../lib/ipc";
import { writeText } from "../../lib/clipboard";
import { isTauriRuntime } from "../../lib/runtime";
import { sftpOpenPath } from "../../lib/sftp";
import { getActiveQueryTab, listQueryTabs } from "../../lib/queryRegistry";
import {
  asSqlEngine,
  quoteIdent as dialectQuoteIdent,
  sqlLiteral as dialectSqlLiteral,
  type SqlEngine,
} from "../../lib/sqlDialect";
import { useContextMenu, type MenuItem } from "../ContextMenu";
import { alertAppDialog, confirmAppDialog } from "../../lib/appDialogs";

const ROW_HEIGHT = 26;
const OVERSCAN = 12;

export type QueryRefreshMode = "normal" | "currentLimit" | "clearView";
export type QueryGeneratedSqlSyncMode = "sync" | "replaceSource";

export interface QueryGridRowChange {
  status: "inserted" | "updated" | "deleted";
  originalIndex: number | null;
  values: (string | null)[];
  original: (string | null)[] | null;
}

export interface QueryGridCommitPayload {
  columns: DbColumn[];
  changes: QueryGridRowChange[];
  counts: {
    inserted: number;
    updated: number;
    deleted: number;
  };
}

interface QueryResultGridProps {
  result: DbQueryResult;
  sourceSql?: string;
  baseSql?: string;
  sqlEngine?: string;
  running?: boolean;
  cancelling?: boolean;
  onRefresh?: (mode: QueryRefreshMode) => void;
  onCancel?: () => void;
  onCommitChanges?: (payload: QueryGridCommitPayload) => Promise<void>;
  onGeneratedSqlSync?: (sql: string, mode: QueryGeneratedSqlSyncMode) => void;
  onGeneratedSqlQuery?: (sql: string) => void | Promise<void>;
  onStatus?: (message: string) => void;
}

type SortDir = "asc" | "desc" | null;
type ViewMode = "table" | "list" | "chart";
type RowStatus = "clean" | "inserted" | "updated" | "deleted";
type ExportTarget = "all" | "selection";
type ColumnFilterMode = "fuzzy" | "exact";
type OutputFormat = "csv" | "html" | "txt" | "sql" | "xml" | "excel" | "json";
type TextFunction = "none" | "upper" | "lower" | "trim";
type QuoteMode = "double" | "single" | "none";
type Encoding = "utf-8" | "utf-8-bom" | "utf-16le";
type IncludeOriginalSql = "none" | "top" | "comment";
type RowDelimiter = "\n" | "\r\n" | "\r";
type SqlDelimiterMode = "none" | "double" | "backtick" | "bracket";
type OutputDestinationKind = "file" | "sqlCommander" | "clipboard";
type SqlCommanderPosition = "caret" | "first" | "last" | "replaceAll";

interface GridRow {
  id: string;
  originalIndex: number | null;
  values: (string | null)[];
  original: (string | null)[] | null;
  status: RowStatus;
}

interface ColumnFilterConfig {
  text: string;
  mode: ColumnFilterMode;
  selectedValues: (string | null)[];
}

interface ActiveColumnFilter {
  columnIndex: number;
  text: string;
  mode: ColumnFilterMode;
  selectedValues: (string | null)[];
}

interface DistinctColumnValue {
  key: string;
  value: string | null;
  label: string;
  count: number;
}

interface DistinctColumnSummary {
  values: DistinctColumnValue[];
  total: number;
  truncated: boolean;
}

interface GeneratedResultSqlOptions {
  sourceSql?: string;
  currentSql?: string;
  sqlEngine?: string;
  columns: DbColumn[];
  visibleColumnIndexes: number[];
  globalFilterText: string;
  columnFilters: ActiveColumnFilter[];
  sortCol: number | null;
  sortDir: SortDir;
}

interface OpenColumnFilter {
  columnIndex: number;
  left: number;
  top: number;
}

interface GridCellCoord {
  rowId: string;
  colIdx: number;
}

interface CellValueViewer {
  rowNumber: number;
  column: DbColumn;
  value: string | null;
}

interface GridBlockSelection {
  anchor: GridCellCoord;
  focus: GridCellCoord;
  dragging: boolean;
}

interface ExportOptions {
  outputFormat: OutputFormat;
  encoding: Encoding;
  dateFormat: string;
  timeFormat: string;
  timestampFormat: string;
  numberFormat: "unformatted" | "grouped";
  decimalFormat: "unformatted" | "grouped";
  groupSeparator: string;
  decimalSeparator: string;
  booleanTrueText: string;
  booleanFalseText: string;
  binaryMode: "dont" | "text" | "length";
  clobMode: "text" | "dont";
  nullValueText: string;
  quoteTextValue: QuoteMode;
  duplicateEmbedded: boolean;
  quoteAllValues: boolean;
  textFunction: TextFunction;
  maxRows: number;
  columnDelimiter: string;
  rowDelimiter: RowDelimiter;
  includeColumnNames: boolean;
  useLabels: boolean;
  removeNewlines: boolean;
  includeOriginalSql: IncludeOriginalSql;
  rowCommentIdentifier: string;
  htmlTitle: string;
  htmlDescription: string;
  htmlFooter: string;
  htmlPerTableHeader: string;
  htmlConvertCharacters: boolean;
  txtSpacesBetweenColumns: number;
  sqlUseQualifier: boolean;
  sqlQualifier: string;
  sqlTableName: string;
  sqlDelimiterMode: SqlDelimiterMode;
  sqlStatementSeparator: string;
  sqlIncludeBasicDdl: boolean;
  sqlAddBefore: string;
  sqlAddAfter: string;
  sqlGenerateMultiRow: boolean;
  sqlRowsPerMultiRow: number;
  sqlMultiRowType: "multi-insert-sql92";
  sqlGenerateMerge: boolean;
  sqlMergeType: "single-merge-sql92";
  sqlMergeMatchColumns: string;
  xmlStyle: "dbvis" | "flat";
  xmlDescription: string;
  excelFileFormat: "xlsx" | "xls";
  excelTitle: string;
  excelDescription: string;
  excelSheetName: string;
  excelExportNumberAsText: boolean;
  excelExportDateTimeAsText: boolean;
  excelAutoResizeColumns: boolean;
  jsonStyle: "array" | "object";
}

interface ExportColumnConfig {
  id: string;
  export: boolean;
  name: string;
  label: string;
  type: string;
  isText: boolean;
  textFunction: TextFunction;
  valueTemplate: string;
}

interface ExportDestination {
  kind: OutputDestinationKind;
  filePath: string;
  sqlCommanderTabId: "active" | "new" | string;
  sqlCommanderPosition: SqlCommanderPosition;
}

const DEFAULT_EXPORT_OPTIONS: ExportOptions = {
  outputFormat: "csv",
  encoding: "utf-8",
  dateFormat: "yyyy-MM-dd",
  timeFormat: "HH:mm:ss",
  timestampFormat: "yyyy-MM-dd HH:mm:ss",
  numberFormat: "unformatted",
  decimalFormat: "unformatted",
  groupSeparator: ",",
  decimalSeparator: ".",
  booleanTrueText: "true",
  booleanFalseText: "false",
  binaryMode: "dont",
  clobMode: "text",
  nullValueText: "(null)",
  quoteTextValue: "double",
  duplicateEmbedded: true,
  quoteAllValues: false,
  textFunction: "none",
  maxRows: 0,
  columnDelimiter: ",",
  rowDelimiter: "\n",
  includeColumnNames: true,
  useLabels: true,
  removeNewlines: false,
  includeOriginalSql: "none",
  rowCommentIdentifier: "--",
  htmlTitle: "Query Results",
  htmlDescription: "",
  htmlFooter: "Generated by DbVisualizer",
  htmlPerTableHeader: "<div>Exported ${dbvis-timestamp}</div>",
  htmlConvertCharacters: true,
  txtSpacesBetweenColumns: 1,
  sqlUseQualifier: false,
  sqlQualifier: "test",
  sqlTableName: "employee",
  sqlDelimiterMode: "none",
  sqlStatementSeparator: ";",
  sqlIncludeBasicDdl: false,
  sqlAddBefore: "",
  sqlAddAfter: "",
  sqlGenerateMultiRow: false,
  sqlRowsPerMultiRow: 500,
  sqlMultiRowType: "multi-insert-sql92",
  sqlGenerateMerge: false,
  sqlMergeType: "single-merge-sql92",
  sqlMergeMatchColumns: "id",
  xmlStyle: "dbvis",
  xmlDescription: "",
  excelFileFormat: "xlsx",
  excelTitle: "Query Results",
  excelDescription: "",
  excelSheetName: "Results",
  excelExportNumberAsText: false,
  excelExportDateTimeAsText: false,
  excelAutoResizeColumns: true,
  jsonStyle: "array",
};

const DEFAULT_COLUMN_FILTER: ColumnFilterConfig = { text: "", mode: "fuzzy", selectedValues: [] };
const DISTINCT_FILTER_VALUE_LIMIT = 100;

const EXPORT_DEFAULTS_KEY = "taomni.db.exportGrid.defaults.v1";
const EXPORT_HISTORY_KEY = "taomni.db.exportGrid.fileHistory.v1";

function defaultExportColumns(columns: DbColumn[]): ExportColumnConfig[] {
  return columns.map((column, index) => ({
    id: `col-${index}-${column.name}`,
    export: true,
    name: column.name,
    label: column.name,
    type: column.type,
    isText: /(char|text|clob|string|uuid|json|xml)/i.test(column.type),
    textFunction: "none",
    valueTemplate: "${value}$",
  }));
}

function readStoredExportOptions(): ExportOptions {
  try {
    const raw = localStorage.getItem(EXPORT_DEFAULTS_KEY);
    if (!raw) return DEFAULT_EXPORT_OPTIONS;
    return { ...DEFAULT_EXPORT_OPTIONS, ...(JSON.parse(raw) as Partial<ExportOptions>) };
  } catch {
    return DEFAULT_EXPORT_OPTIONS;
  }
}

function readExportFileHistory(): string[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(EXPORT_HISTORY_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : [];
  } catch {
    return [];
  }
}

function writeExportFileHistory(paths: string[]): void {
  try {
    localStorage.setItem(EXPORT_HISTORY_KEY, JSON.stringify(paths.slice(0, 12)));
  } catch {
    /* ignore */
  }
}

function makeRows(result: DbQueryResult): GridRow[] {
  return result.rows.map((values, index) => ({
    id: `row-${index}-${result.rows.length}`,
    originalIndex: index,
    values: [...values],
    original: [...values],
    status: "clean",
  }));
}

function nextRowId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

/** Detect a numeric column value for right-alignment + numeric sort. */
function isNumeric(value: string | null): boolean {
  if (value === null || value === "") return false;
  return !Number.isNaN(Number(value));
}

function filterValueKey(value: string | null): string {
  return value === null ? "__taomni_null__" : `value:${value}`;
}

function filterValueLabel(value: string | null): string {
  if (value === null) return "NULL";
  if (value === "") return "(empty)";
  return value;
}

function isColumnFilterActive(config: ColumnFilterConfig): boolean {
  return config.text.trim().length > 0 || config.selectedValues.length > 0;
}

function distinctValuesForColumn(rows: GridRow[], columnIndex: number): DistinctColumnSummary {
  const counts = new Map<string, { value: string | null; count: number }>();
  for (const row of rows) {
    if (row.status === "deleted") continue;
    const value = row.values[columnIndex] ?? null;
    const key = filterValueKey(value);
    const current = counts.get(key);
    if (current) current.count += 1;
    else counts.set(key, { value, count: 1 });
  }
  const entries = Array.from(counts.entries())
    .map(([key, item]) => ({ key, value: item.value, label: filterValueLabel(item.value), count: item.count }))
    .sort((a, b) => {
      if (a.value === null && b.value === null) return 0;
      if (a.value === null) return 1;
      if (b.value === null) return -1;
      if (isNumeric(a.value) && isNumeric(b.value)) return Number(a.value) - Number(b.value);
      return a.value.localeCompare(b.value, undefined, { numeric: true, sensitivity: "base" });
    });
  return {
    values: entries.slice(0, DISTINCT_FILTER_VALUE_LIMIT),
    total: entries.length,
    truncated: entries.length > DISTINCT_FILTER_VALUE_LIMIT,
  };
}

function stripSqlTerminator(sql: string): string {
  return sql.trim().replace(/;+\s*$/, "");
}

function sqlWithTerminator(sql: string): string {
  return `${stripSqlTerminator(sql)};`;
}

function indentSql(sql: string): string {
  return sql.split(/\r?\n/).map((line) => `  ${line}`).join("\n");
}

function sqlTextExpression(engine: SqlEngine, expression: string): string {
  switch (engine) {
    case "MySQL":
    case "StarRocks":
      return `CAST(${expression} AS CHAR)`;
    case "PostgreSQL":
    case "PanWeiDB":
      return `${expression}::text`;
    case "Oracle":
      return `CAST(${expression} AS VARCHAR2(4000))`;
    case "SQLServer":
      return `CAST(${expression} AS NVARCHAR(MAX))`;
    case "ClickHouse":
      return `toString(${expression})`;
    case "Presto":
      return `CAST(${expression} AS VARCHAR)`;
  }
}

function escapeLikePattern(value: string): string {
  return value.replace(/[!%_]/g, (char) => `!${char}`);
}

function sqlLikeCondition(expression: string, value: string): string {
  return `${expression} LIKE ${dialectSqlLiteral(`%${escapeLikePattern(value)}%`)} ESCAPE '!'`;
}

function uniqueFilterValues(values: (string | null)[]): (string | null)[] {
  const seen = new Set<string>();
  const unique: (string | null)[] = [];
  for (const value of values) {
    const key = filterValueKey(value);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(value);
  }
  return unique;
}

function selectedValuesCondition(columnSql: string, values: (string | null)[]): string | null {
  const unique = uniqueFilterValues(values);
  const nonNull = unique.filter((value): value is string => value !== null);
  const clauses: string[] = [];
  if (nonNull.length === 1) {
    clauses.push(`${columnSql} = ${dialectSqlLiteral(nonNull[0])}`);
  } else if (nonNull.length > 1) {
    clauses.push(`${columnSql} IN (${nonNull.map((value) => dialectSqlLiteral(value)).join(", ")})`);
  }
  if (unique.some((value) => value === null)) clauses.push(`${columnSql} IS NULL`);
  if (clauses.length === 0) return null;
  return clauses.length === 1 ? clauses[0] : `(${clauses.join(" OR ")})`;
}

function isIdentChar(char: string | undefined): boolean {
  return !!char && /[A-Za-z0-9_$]/.test(char);
}

function keywordMatchAt(sql: string, index: number, pattern: RegExp): number {
  if (isIdentChar(sql[index - 1])) return 0;
  const match = sql.slice(index).match(pattern);
  if (!match) return 0;
  const end = index + match[0].length;
  return isIdentChar(sql[end]) ? 0 : match[0].length;
}

function topLevelSqlClauses(sql: string): Record<string, number> {
  const clauses: Record<string, number> = {};
  let depth = 0;
  let singleQuoted = false;
  let doubleQuoted = false;
  let backtickQuoted = false;
  let bracketQuoted = false;
  let lineComment = false;
  let blockComment = false;

  for (let i = 0; i < sql.length; i += 1) {
    const ch = sql[i];
    const next = sql[i + 1];

    if (lineComment) {
      if (ch === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (ch === "*" && next === "/") {
        blockComment = false;
        i += 1;
      }
      continue;
    }
    if (singleQuoted) {
      if (ch === "'" && next === "'") i += 1;
      else if (ch === "'") singleQuoted = false;
      continue;
    }
    if (doubleQuoted) {
      if (ch === "\"" && next === "\"") i += 1;
      else if (ch === "\"") doubleQuoted = false;
      continue;
    }
    if (backtickQuoted) {
      if (ch === "`" && next === "`") i += 1;
      else if (ch === "`") backtickQuoted = false;
      continue;
    }
    if (bracketQuoted) {
      if (ch === "]" && next === "]") i += 1;
      else if (ch === "]") bracketQuoted = false;
      continue;
    }

    if (ch === "-" && next === "-") {
      lineComment = true;
      i += 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      blockComment = true;
      i += 1;
      continue;
    }
    if (ch === "'") {
      singleQuoted = true;
      continue;
    }
    if (ch === "\"") {
      doubleQuoted = true;
      continue;
    }
    if (ch === "`") {
      backtickQuoted = true;
      continue;
    }
    if (ch === "[") {
      bracketQuoted = true;
      continue;
    }
    if (ch === "(") {
      depth += 1;
      continue;
    }
    if (ch === ")") {
      depth = Math.max(0, depth - 1);
      continue;
    }

    if (depth !== 0) continue;
    const checks: Array<[string, RegExp]> = [
      ["select", /^select\b/i],
      ["from", /^from\b/i],
      ["where", /^where\b/i],
      ["groupBy", /^group\s+by\b/i],
      ["having", /^having\b/i],
      ["orderBy", /^order\s+by\b/i],
      ["limit", /^limit\b/i],
      ["offset", /^offset\b/i],
      ["fetch", /^fetch\b/i],
      ["for", /^for\b/i],
      ["union", /^union\b/i],
      ["intersect", /^intersect\b/i],
      ["except", /^except\b/i],
    ];
    for (const [name, pattern] of checks) {
      if (clauses[name] !== undefined) continue;
      if (keywordMatchAt(sql, i, pattern) > 0) clauses[name] = i;
    }
  }
  return clauses;
}

function firstClauseAfter(clauses: Record<string, number>, names: string[], after = -1): number | null {
  const indexes = names
    .map((name) => clauses[name])
    .filter((index): index is number => index !== undefined && index > after);
  return indexes.length > 0 ? Math.min(...indexes) : null;
}

function selectListContainsTopLevelStar(sql: string, clauses: Record<string, number>): boolean {
  const selectStart = clauses.select;
  const fromStart = clauses.from;
  if (selectStart === undefined || fromStart === undefined || fromStart <= selectStart) return false;
  const list = sql.slice(selectStart + "select".length, fromStart);
  let depth = 0;
  let singleQuoted = false;
  let doubleQuoted = false;
  let backtickQuoted = false;
  let bracketQuoted = false;
  for (let i = 0; i < list.length; i += 1) {
    const ch = list[i];
    const next = list[i + 1];
    if (singleQuoted) {
      if (ch === "'" && next === "'") i += 1;
      else if (ch === "'") singleQuoted = false;
      continue;
    }
    if (doubleQuoted) {
      if (ch === "\"" && next === "\"") i += 1;
      else if (ch === "\"") doubleQuoted = false;
      continue;
    }
    if (backtickQuoted) {
      if (ch === "`" && next === "`") i += 1;
      else if (ch === "`") backtickQuoted = false;
      continue;
    }
    if (bracketQuoted) {
      if (ch === "]" && next === "]") i += 1;
      else if (ch === "]") bracketQuoted = false;
      continue;
    }
    if (ch === "'") singleQuoted = true;
    else if (ch === "\"") doubleQuoted = true;
    else if (ch === "`") backtickQuoted = true;
    else if (ch === "[") bracketQuoted = true;
    else if (ch === "(") depth += 1;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    else if (depth === 0 && ch === "*") return true;
  }
  return false;
}

function withoutTopLevelOrderBy(sql: string, clauses: Record<string, number>): string {
  const orderStart = clauses.orderBy;
  if (orderStart === undefined) return sql;
  const orderEnd = firstClauseAfter(clauses, ["limit", "offset", "fetch", "for"], orderStart) ?? sql.length;
  const before = sql.slice(0, orderStart).trimEnd();
  const after = sql.slice(orderEnd).trimStart();
  return after ? `${before}\n${after}` : before;
}

function tryBuildInlineResultSql(baseSql: string, whereClauses: string[], orderBy: string): string | null {
  let sql = stripSqlTerminator(baseSql);
  if (!/^\s*select\b/i.test(sql) || /^\s*with\b/i.test(sql)) return null;
  let clauses = topLevelSqlClauses(sql);
  if (
    clauses.select === undefined ||
    clauses.from === undefined ||
    clauses.union !== undefined ||
    clauses.intersect !== undefined ||
    clauses.except !== undefined ||
    clauses.groupBy !== undefined ||
    clauses.having !== undefined ||
    !selectListContainsTopLevelStar(sql, clauses)
  ) {
    return null;
  }

  if (orderBy) {
    sql = withoutTopLevelOrderBy(sql, clauses);
    clauses = topLevelSqlClauses(sql);
  }

  if (whereClauses.length > 0) {
    const tailStart = firstClauseAfter(clauses, ["orderBy", "limit", "offset", "fetch", "for"]);
    const whereSql = whereClauses.join("\n  AND ");
    if (clauses.where !== undefined) {
      const insertAt = tailStart ?? sql.length;
      sql = `${sql.slice(0, insertAt).trimEnd()}\n  AND ${whereSql}${insertAt < sql.length ? `\n${sql.slice(insertAt).trimStart()}` : ""}`;
    } else {
      const insertAt = tailStart ?? sql.length;
      sql = `${sql.slice(0, insertAt).trimEnd()}\nWHERE ${whereSql}${insertAt < sql.length ? `\n${sql.slice(insertAt).trimStart()}` : ""}`;
    }
    clauses = topLevelSqlClauses(sql);
  }

  if (orderBy) {
    const insertAt = firstClauseAfter(clauses, ["limit", "offset", "fetch", "for"]) ?? sql.length;
    sql = `${sql.slice(0, insertAt).trimEnd()}\n${orderBy}${insertAt < sql.length ? `\n${sql.slice(insertAt).trimStart()}` : ""}`;
  }

  return sqlWithTerminator(sql);
}

function buildGeneratedResultSql({
  sourceSql,
  currentSql,
  sqlEngine,
  columns,
  visibleColumnIndexes,
  globalFilterText,
  columnFilters,
  sortCol,
  sortDir,
}: GeneratedResultSqlOptions): string | null {
  const baseSql = stripSqlTerminator(sourceSql ?? "");
  if (!baseSql || !sqlEngine) return null;
  const currentBaseSql = stripSqlTerminator(currentSql ?? sourceSql ?? "");
  const engine = asSqlEngine(sqlEngine);
  const whereClauses: string[] = [];
  const columnSql = (columnIndex: number) =>
    dialectQuoteIdent(engine, columns[columnIndex]?.name || `column_${columnIndex + 1}`);
  const globalNeedle = globalFilterText.trim();
  if (globalNeedle && visibleColumnIndexes.length > 0) {
    whereClauses.push(
      `(${visibleColumnIndexes
        .map((columnIndex) => sqlLikeCondition(sqlTextExpression(engine, columnSql(columnIndex)), globalNeedle))
        .join(" OR ")})`,
    );
  }
  for (const filter of columnFilters) {
    const column = columnSql(filter.columnIndex);
    const selectedCondition = selectedValuesCondition(column, filter.selectedValues);
    if (selectedCondition) {
      whereClauses.push(selectedCondition);
    } else if (filter.text) {
      whereClauses.push(
        filter.mode === "exact"
          ? `${column} = ${dialectSqlLiteral(filter.text)}`
          : sqlLikeCondition(sqlTextExpression(engine, column), filter.text),
      );
    }
  }
  const orderBy = sortCol !== null && sortDir ? `ORDER BY ${columnSql(sortCol)} ${sortDir.toUpperCase()}` : "";
  if (whereClauses.length === 0 && !orderBy) {
    return currentBaseSql && currentBaseSql !== baseSql ? sqlWithTerminator(baseSql) : null;
  }
  const inlineSql = tryBuildInlineResultSql(baseSql, whereClauses, orderBy);
  if (inlineSql) return inlineSql;
  const alias = engine === "Oracle" ? ") taomni_result" : ") AS taomni_result";
  const lines = ["SELECT *", "FROM (", indentSql(baseSql), alias];
  if (whereClauses.length > 0) lines.push(`WHERE ${whereClauses.join("\n  AND ")}`);
  if (orderBy) lines.push(orderBy);
  return `${lines.join("\n")};`;
}

function compactSqlForDisplay(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}

function csvEscape(value: string | null): string {
  if (value === null) return "";
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function sameValues(a: (string | null)[] | null, b: (string | null)[]): boolean {
  if (!a || a.length !== b.length) return false;
  return a.every((value, index) => value === b[index]);
}

function statusAfterValueChange(row: GridRow, values: (string | null)[]): RowStatus {
  if (row.status === "inserted" || row.status === "deleted") return row.status;
  return sameValues(row.original, values) ? "clean" : "updated";
}

function formatDatePart(value: number): string {
  return String(value).padStart(2, "0");
}

function formatDateWithPattern(value: string, pattern: string, kind: "date" | "time" | "timestamp"): string {
  if (!pattern.trim()) return value;
  const source =
    kind === "time"
      ? `1970-01-01T${value}`
      : value.includes("T")
        ? value
        : value.includes(" ")
          ? value.replace(" ", "T")
          : value;
  const date = new Date(source);
  if (Number.isNaN(date.getTime())) return value;
  return pattern
    .replace(/yyyy/g, String(date.getFullYear()))
    .replace(/MM/g, formatDatePart(date.getMonth() + 1))
    .replace(/dd/g, formatDatePart(date.getDate()))
    .replace(/HH/g, formatDatePart(date.getHours()))
    .replace(/mm/g, formatDatePart(date.getMinutes()))
    .replace(/ss/g, formatDatePart(date.getSeconds()));
}

function formatNumberText(value: string, groupSeparator: string, decimalSeparator: string): string {
  if (!/^-?\d+([.,]\d+)?$/.test(value.trim())) return value;
  const sign = value.startsWith("-") ? "-" : "";
  const unsigned = sign ? value.slice(1) : value;
  const [integer, fraction] = unsigned.split(/[.,]/);
  const grouped = integer.replace(/\B(?=(\d{3})+(?!\d))/g, groupSeparator);
  return `${sign}${grouped}${fraction !== undefined ? `${decimalSeparator}${fraction}` : ""}`;
}

function applyTextFunction(value: string, fn: TextFunction): string {
  switch (fn) {
    case "upper":
      return value.toUpperCase();
    case "lower":
      return value.toLowerCase();
    case "trim":
      return value.trim();
    default:
      return value;
  }
}

function formatValue(value: string | null, column: DbColumn, options: ExportOptions): string {
  if (value === null) return options.nullValueText;
  const type = column.type.toLowerCase();
  if (/(blob|binary|bytea|varbinary)/.test(type)) {
    if (options.binaryMode === "dont") return "";
    if (options.binaryMode === "length") return `${value.length} bytes`;
  }
  if (/clob/.test(type) && options.clobMode === "dont") return "";
  if (/bool/.test(type)) {
    if (/^(true|t|1)$/i.test(value)) return options.booleanTrueText;
    if (/^(false|f|0)$/i.test(value)) return options.booleanFalseText;
  }
  if (/(timestamp|datetime)/.test(type)) {
    return applyTextFunction(formatDateWithPattern(value, options.timestampFormat, "timestamp"), options.textFunction);
  }
  if (/\bdate\b/.test(type)) {
    return applyTextFunction(formatDateWithPattern(value, options.dateFormat, "date"), options.textFunction);
  }
  if (/\btime\b/.test(type)) {
    return applyTextFunction(formatDateWithPattern(value, options.timeFormat, "time"), options.textFunction);
  }
  if (/(decimal|numeric)/.test(type) && options.decimalFormat === "grouped") {
    return formatNumberText(value, options.groupSeparator, options.decimalSeparator);
  }
  if (/(int|float|double|real|number)/.test(type) && options.numberFormat === "grouped") {
    return formatNumberText(value, options.groupSeparator, options.decimalSeparator);
  }
  return applyTextFunction(value, options.textFunction);
}

function delimitedField(value: string, options: ExportOptions): string {
  const quoteChar = options.quoteTextValue === "double" ? '"' : options.quoteTextValue === "single" ? "'" : "";
  if (!quoteChar) return value;
  const needsQuote =
    options.quoteAllValues ||
    value.includes(options.columnDelimiter) ||
    value.includes("\n") ||
    value.includes("\r") ||
    value.includes(quoteChar);
  if (!needsQuote) return value;
  const escaped = options.duplicateEmbedded
    ? value.split(quoteChar).join(`${quoteChar}${quoteChar}`)
    : value.split(quoteChar).join(`\\${quoteChar}`);
  return `${quoteChar}${escaped}${quoteChar}`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeXml(value: string): string {
  return escapeHtml(value).replace(/'/g, "&apos;");
}

function uniqueColumnNames(columns: DbColumn[]): string[] {
  const seen = new Map<string, number>();
  return columns.map((column) => {
    const base = column.name || "column";
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return count === 0 ? base : `${base}_${count + 1}`;
  });
}

function columnOutputName(column: ExportColumnConfig, options: ExportOptions): string {
  return options.useLabels ? column.label || column.name : column.name;
}

function cleanExportText(value: string, options: ExportOptions): string {
  return options.removeNewlines ? value.replace(/[\r\n]+/g, " ") : value;
}

function renderTemplate(template: string, value: string): string {
  return template.replace(/\$\{value\}\$?/g, () => value);
}

function quoteSqlIdentifier(name: string, mode: SqlDelimiterMode): string {
  switch (mode) {
    case "double":
      return `"${name.replace(/"/g, '""')}"`;
    case "backtick":
      return `\`${name.replace(/`/g, "``")}\``;
    case "bracket":
      return `[${name.replace(/]/g, "]]")}]`;
    default:
      return name;
  }
}

function sqlExportTableName(options: ExportOptions): string {
  const table = quoteSqlIdentifier(options.sqlTableName || "result_export", options.sqlDelimiterMode);
  if (!options.sqlUseQualifier || !options.sqlQualifier.trim()) return table;
  return `${quoteSqlIdentifier(options.sqlQualifier.trim(), options.sqlDelimiterMode)}.${table}`;
}

function originalSqlBlock(sourceSql: string | undefined, options: ExportOptions, commentPrefix = "--"): string[] {
  if (!sourceSql?.trim() || options.includeOriginalSql === "none") return [];
  const lines = sourceSql.trim().split(/\r?\n/).map((line) => `${commentPrefix} ${line}`);
  return options.includeOriginalSql === "top" ? lines : [`${commentPrefix} Original SQL:`, ...lines];
}

function serializeResult(
  columns: DbColumn[],
  rows: GridRow[],
  exportColumns: ExportColumnConfig[],
  options: ExportOptions,
  sourceSql?: string,
): { text: string; extension: string; mime: string } {
  const limitedRows = options.maxRows > 0 ? rows.slice(0, options.maxRows) : rows;
  const enabledColumns = exportColumns.filter((column) => column.export);
  const columnByName = new Map(columns.map((column, index) => [column.name, { column, index }]));
  const rowValues = limitedRows.map((row) =>
    enabledColumns.map((exportColumn) => {
      let originalIndex = parseInt(exportColumn.id.split('-')[1], 10);
      if (Number.isNaN(originalIndex) || exportColumn.id.startsWith("export-col")) {
        const match = columnByName.get(exportColumn.name);
        originalIndex = match ? match.index : -1;
      }
      const sourceColumn = columns[originalIndex] ?? { name: exportColumn.name, type: exportColumn.type };
      const raw = originalIndex >= 0 && originalIndex < columns.length ? row.values[originalIndex] : null;
      const columnOptions = exportColumn.textFunction === "none" ? options : { ...options, textFunction: exportColumn.textFunction };
      const formatted = formatValue(raw, sourceColumn, columnOptions);
      return cleanExportText(renderTemplate(exportColumn.valueTemplate || "${value}$", formatted), options);
    }),
  );

  switch (options.outputFormat) {
    case "html": {
      const html = (value: string) => (options.htmlConvertCharacters ? escapeHtml(value) : value);
      const title = html(options.htmlTitle || "Query Results");
      const description = options.htmlDescription ? `<div>${html(options.htmlDescription)}</div>\n` : "";
      const footer = options.htmlFooter ? `\n<footer>${html(options.htmlFooter)}</footer>` : "";
      const headerTemplate = options.htmlPerTableHeader.replace("${dbvis-timestamp}", new Date().toISOString());
      const sqlBlock = originalSqlBlock(sourceSql, options, "<!--").map((line) => `${line} -->`).join("\n");
      const header = `<tr>${enabledColumns.map((column) => `<th>${html(columnOutputName(column, options))}</th>`).join("")}</tr>`;
      const body = rowValues
        .map((row) => `<tr>${row.map((value) => `<td>${html(value)}</td>`).join("")}</tr>`)
        .join("\n");
      const text = `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>\n${sqlBlock}\n<h1>${title}</h1>\n${description}${headerTemplate}\n<table border="1">\n${header}\n${body}\n</table>${footer}\n</body></html>`;
      return {
        text,
        extension: "html",
        mime: "text/html",
      };
    }
    case "excel": {
      const title = escapeHtml(options.excelTitle || "Query Results");
      const description = options.excelDescription ? `<div>${escapeHtml(options.excelDescription)}</div>\n` : "";
      const sqlBlock = originalSqlBlock(sourceSql, options, "<!--").map((line) => `${line} -->`).join("\n");
      const numberAsText = options.excelExportNumberAsText || options.excelExportDateTimeAsText;
      const header = options.includeColumnNames
        ? `<tr>${enabledColumns.map((column) => `<th>${escapeHtml(columnOutputName(column, options))}</th>`).join("")}</tr>`
        : "";
      const body = rowValues
        .map((row) =>
          `<tr>${row
            .map((value) => `<td${numberAsText ? ' style="mso-number-format:\\@"' : ""}>${escapeHtml(value)}</td>`)
            .join("")}</tr>`,
        )
        .join("\n");
      const text = `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>\n${sqlBlock}\n<h1>${title}</h1>\n${description}<table border="1">\n${header}\n${body}\n</table></body></html>`;
      return {
        text,
        extension: options.excelFileFormat,
        mime:
          options.excelFileFormat === "xlsx"
            ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            : "application/vnd.ms-excel",
      };
    }
    case "csv": {
      const lines: string[] = [];
      lines.push(...originalSqlBlock(sourceSql, options, options.rowCommentIdentifier || "#"));
      if (options.includeColumnNames) {
        lines.push(enabledColumns.map((column) => delimitedField(columnOutputName(column, options), options)).join(options.columnDelimiter));
      }
      for (const row of rowValues) {
        lines.push(row.map((value) => delimitedField(value, options)).join(options.columnDelimiter));
      }
      return {
        text: lines.join(options.rowDelimiter),
        extension: "csv",
        mime: "text/csv",
      };
    }
    case "txt": {
      const separator = " ".repeat(Math.max(1, options.txtSpacesBetweenColumns));
      const lines: string[] = [];
      lines.push(...originalSqlBlock(sourceSql, options, options.rowCommentIdentifier || "#"));
      if (options.includeColumnNames) {
        lines.push(enabledColumns.map((column) => columnOutputName(column, options)).join(separator));
      }
      for (const row of rowValues) {
        lines.push(row.join(separator));
      }
      return {
        text: lines.join(options.rowDelimiter),
        extension: "txt",
        mime: "text/plain",
      };
    }
    case "json": {
      const names = uniqueColumnNames(enabledColumns.map((column) => ({ name: columnOutputName(column, options), type: column.type })));
      const rowsPayload = rowValues.map((row) =>
        Object.fromEntries(row.map((value, index) => [names[index], value])),
      );
      const payload = options.jsonStyle === "object" ? { rows: rowsPayload } : rowsPayload;
      return { text: JSON.stringify(payload, null, 2), extension: "json", mime: "application/json" };
    }
    case "xml": {
      const description = options.xmlDescription ? `  <description>${escapeXml(options.xmlDescription)}</description>\n` : "";
      const sql = sourceSql?.trim() && options.includeOriginalSql !== "none" ? `  <sql>${escapeXml(sourceSql.trim())}</sql>\n` : "";
      const body = rowValues
        .map((row) => {
          const cells = row
            .map((value, index) => {
              const name = escapeXml(columnOutputName(enabledColumns[index], options));
              return options.xmlStyle === "flat"
                ? `    <${name}>${escapeXml(value)}</${name}>`
                : `    <column name="${name}">${escapeXml(value)}</column>`;
            })
            .join("\n");
          return `  <row>\n${cells}\n  </row>`;
        })
        .join("\n");
      return { text: `<result style="${options.xmlStyle}">\n${description}${sql}${body}\n</result>`, extension: "xml", mime: "application/xml" };
    }
    case "sql": {
      const tableName = sqlExportTableName(options);
      const quotedColumns = enabledColumns.map((column) => quoteSqlIdentifier(columnOutputName(column, options), options.sqlDelimiterMode)).join(", ");
      const lines: string[] = [];
      lines.push(...originalSqlBlock(sourceSql, options, options.rowCommentIdentifier || "--"));
      if (options.sqlIncludeBasicDdl) {
        const ddlColumns = enabledColumns
          .map((column) => `  ${quoteSqlIdentifier(columnOutputName(column, options), options.sqlDelimiterMode)} ${column.type || "TEXT"}`)
          .join(",\n");
        lines.push(`CREATE TABLE ${tableName} (\n${ddlColumns}\n)${options.sqlStatementSeparator}`);
      }
      if (options.sqlGenerateMerge) {
        const matchColumns = options.sqlMergeMatchColumns
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean);
        for (const row of rowValues) {
          const values = row.map((value) => `'${value.replace(/'/g, "''")}'`).join(", ");
          const match = matchColumns.length > 0 ? matchColumns.join(", ") : enabledColumns[0]?.name ?? "id";
          lines.push(`${options.sqlAddBefore}MERGE INTO ${tableName} USING (VALUES (${values})) AS src (${quotedColumns}) ON (${match}) WHEN MATCHED THEN UPDATE SET ${quotedColumns} = ${quotedColumns} WHEN NOT MATCHED THEN INSERT (${quotedColumns}) VALUES (${quotedColumns})${options.sqlStatementSeparator}${options.sqlAddAfter}`);
        }
      } else if (options.sqlGenerateMultiRow) {
        for (let index = 0; index < rowValues.length; index += Math.max(1, options.sqlRowsPerMultiRow)) {
          const chunk = rowValues.slice(index, index + Math.max(1, options.sqlRowsPerMultiRow));
          const tuples = chunk
            .map((row) => `(${row.map((value) => `'${value.replace(/'/g, "''")}'`).join(", ")})`)
            .join(",\n");
          lines.push(`${options.sqlAddBefore}INSERT INTO ${tableName} (${quotedColumns}) VALUES\n${tuples}${options.sqlStatementSeparator}${options.sqlAddAfter}`);
        }
      } else {
        for (const row of rowValues) {
          const values = row.map((value) => `'${value.replace(/'/g, "''")}'`).join(", ");
          lines.push(`${options.sqlAddBefore}INSERT INTO ${tableName} (${quotedColumns}) VALUES (${values})${options.sqlStatementSeparator}${options.sqlAddAfter}`);
        }
      }
      return { text: lines.filter(Boolean).join("\n"), extension: "sql", mime: "application/sql" };
    }
  }
}

function encodeOutput(text: string, encoding: Encoding): Uint8Array {
  if (encoding === "utf-8-bom") {
    const bytes = new TextEncoder().encode(text);
    const output = new Uint8Array(bytes.length + 3);
    output.set([0xef, 0xbb, 0xbf], 0);
    output.set(bytes, 3);
    return output;
  }
  if (encoding === "utf-16le") {
    const output = new Uint8Array(text.length * 2 + 2);
    output[0] = 0xff;
    output[1] = 0xfe;
    for (let index = 0; index < text.length; index += 1) {
      const code = text.charCodeAt(index);
      output[index * 2 + 2] = code & 0xff;
      output[index * 2 + 3] = code >> 8;
    }
    return output;
  }
  return new TextEncoder().encode(text);
}

async function writeBytesToPath(path: string, bytes: Uint8Array): Promise<void> {
  let handleId: string | null = null;
  try {
    handleId = await writeStreamOpen(path);
    await writeStreamAppend(handleId, bytes);
    await writeStreamClose(handleId);
  } catch (err) {
    if (handleId) await writeStreamAbort(handleId).catch(() => undefined);
    throw err;
  }
}

function browserDownload(bytes: Uint8Array, filename: string, mime: string): void {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  const blob = new Blob([buffer], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function browserOpen(bytes: Uint8Array, mime: string): void {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  const blob = new Blob([buffer], { type: mime });
  const url = URL.createObjectURL(blob);
  const opened = window.open(url, "_blank", "noopener,noreferrer");
  if (!opened) {
    browserDownload(bytes, "query-results.html", mime);
  }
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

function nowDateText(): string {
  const d = new Date();
  return `${d.getFullYear()}-${formatDatePart(d.getMonth() + 1)}-${formatDatePart(d.getDate())}`;
}

function nowTimeText(): string {
  const d = new Date();
  return `${formatDatePart(d.getHours())}:${formatDatePart(d.getMinutes())}:${formatDatePart(d.getSeconds())}`;
}

function nowTimestampText(): string {
  return `${nowDateText()} ${nowTimeText()}`;
}

function isGridBlockSelectionMouseEvent(event: Pick<MouseEvent<HTMLElement>, "button" | "altKey" | "ctrlKey" | "shiftKey">): boolean {
  return event.button === 0 && (event.altKey || (event.ctrlKey && event.shiftKey));
}

/** A virtualised result grid with a compact database-client toolbar. */
export function QueryResultGrid({
  result,
  sourceSql,
  baseSql,
  sqlEngine,
  running = false,
  cancelling = false,
  onRefresh,
  onCancel,
  onCommitChanges,
  onGeneratedSqlSync,
  onGeneratedSqlQuery,
  onStatus,
}: QueryResultGridProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const columnFilterPopoverRef = useRef<HTMLDivElement>(null);
  const [rows, setRows] = useState<GridRow[]>(() => makeRows(result));
  const [scrollTop, setScrollTop] = useState(0);
  const [scrollLeft, setScrollLeft] = useState(0);
  const [viewportH, setViewportH] = useState(400);
  const [sortCol, setSortCol] = useState<number | null>(null);
  const [sortDir, setSortDir] = useState<SortDir>(null);
  const [autoFit, setAutoFit] = useState(true);
  const [columnWidths, setColumnWidths] = useState<Record<number, number>>({});
  const [visibleColumns, setVisibleColumns] = useState<Set<number>>(
    () => new Set(result.columns.map((_, index) => index)),
  );
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [cellBlockSelection, setCellBlockSelection] = useState<GridBlockSelection | null>(null);
  const [lastSelectedId, setLastSelectedId] = useState<string | null>(null);
  const [activeCell, setActiveCell] = useState<{ rowId: string; colIdx: number } | null>(null);
  const [editingCell, setEditingCell] = useState<{ rowId: string; colIdx: number } | null>(null);
  const [editValue, setEditValue] = useState("");
  const [filterText, setFilterText] = useState("");
  const [filterOpen, setFilterOpen] = useState(false);
  const [columnFilters, setColumnFilters] = useState<Record<number, ColumnFilterConfig>>({});
  const [openColumnFilter, setOpenColumnFilter] = useState<OpenColumnFilter | null>(null);
  const [draftColumnFilter, setDraftColumnFilter] = useState<ColumnFilterConfig>(DEFAULT_COLUMN_FILTER);
  const [searchText, setSearchText] = useState("");
  const [showStats, setShowStats] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>("table");
  const [exportTarget, setExportTarget] = useState<ExportTarget>("all");
  const [exportOptions, setExportOptions] = useState<ExportOptions>(() => readStoredExportOptions());
  const [exportColumns, setExportColumns] = useState<ExportColumnConfig[]>(() => defaultExportColumns(result.columns));
  const [submittingChanges, setSubmittingChanges] = useState(false);
  const [exportDialogOpen, setExportDialogOpen] = useState(false);
  const [cellValueViewer, setCellValueViewer] = useState<CellValueViewer | null>(null);
  const [localNotice, setLocalNotice] = useState("");
  const { show: openCellMenu, showAt: openMenuAt, render: menu } = useContextMenu();

  useEffect(() => {
    setRows(makeRows(result));
    setSelectedIds(new Set());
    setCellBlockSelection(null);
    setLastSelectedId(null);
    setActiveCell(null);
    setEditingCell(null);
    setCellValueViewer(null);
  }, [result]);

  useEffect(() => {
    setVisibleColumns(new Set(result.columns.map((_, index) => index)));
    setColumnWidths({});
    setColumnFilters({});
    setOpenColumnFilter(null);
    setDraftColumnFilter(DEFAULT_COLUMN_FILTER);
    setCellBlockSelection(null);
    setExportColumns(defaultExportColumns(result.columns));
  }, [result.columns]);

  useEffect(() => {
    if (!openColumnFilter) return;
    const closeOnOutsideClick = (event: globalThis.MouseEvent) => {
      if (columnFilterPopoverRef.current?.contains(event.target as Node)) return;
      setOpenColumnFilter(null);
    };
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") setOpenColumnFilter(null);
    };
    document.addEventListener("mousedown", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [openColumnFilter]);

  useEffect(() => {
    if (!cellBlockSelection?.dragging) return;
    const finishDrag = () => {
      setCellBlockSelection((current) => current ? { ...current, dragging: false } : current);
    };
    document.addEventListener("mouseup", finishDrag);
    return () => document.removeEventListener("mouseup", finishDrag);
  }, [cellBlockSelection?.dragging]);

  const visibleColumnIndexes = useMemo(
    () => result.columns.map((_, index) => index).filter((index) => visibleColumns.has(index)),
    [result.columns, visibleColumns],
  );

  const onScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    setScrollTop(e.currentTarget.scrollTop);
    setScrollLeft(e.currentTarget.scrollLeft);
    setViewportH(e.currentTarget.clientHeight);
  }, []);

  const activeColumnFilters = useMemo(
    () =>
      Object.entries(columnFilters)
        .map(([rawIndex, config]) => ({
          columnIndex: Number(rawIndex),
          text: config.text.trim(),
          mode: config.mode,
          selectedValues: config.selectedValues,
        }))
        .filter(
          (filter) =>
            Number.isInteger(filter.columnIndex) &&
            filter.columnIndex >= 0 &&
            filter.columnIndex < result.columns.length &&
            (filter.text.length > 0 || filter.selectedValues.length > 0),
        ),
    [columnFilters, result.columns.length],
  );

  const activeColumnFilterCount = activeColumnFilters.length;
  const generatedSql = useMemo(
    () =>
      buildGeneratedResultSql({
        sourceSql: baseSql ?? sourceSql,
        currentSql: sourceSql,
        sqlEngine,
        columns: result.columns,
        visibleColumnIndexes,
        globalFilterText: filterText,
        columnFilters: activeColumnFilters,
        sortCol,
        sortDir,
      }),
    [activeColumnFilters, baseSql, filterText, result.columns, sortCol, sortDir, sourceSql, sqlEngine, visibleColumnIndexes],
  );

  const rowMatchesFilter = useCallback(
    (row: GridRow) => {
      const needle = filterText.trim().toLowerCase();
      if (needle && !visibleColumnIndexes.some((index) => (row.values[index] ?? "").toLowerCase().includes(needle))) {
        return false;
      }
      return activeColumnFilters.every((filter) => {
        const rawValue = row.values[filter.columnIndex] ?? null;
        if (filter.selectedValues.length > 0) {
          const selected = new Set(filter.selectedValues.map(filterValueKey));
          return selected.has(filterValueKey(rawValue));
        }
        if (!filter.text) return true;
        const value = (rawValue ?? "").toLowerCase();
        const columnNeedle = filter.text.toLowerCase();
        return filter.mode === "exact" ? value === columnNeedle : value.includes(columnNeedle);
      });
    },
    [activeColumnFilters, filterText, visibleColumnIndexes],
  );

  const order = useMemo(() => {
    const indexes = rows.map((_, index) => index).filter((index) => rowMatchesFilter(rows[index]));
    if (sortCol === null || sortDir === null) return indexes;
    const numeric = indexes.every((index) => isNumeric(rows[index].values[sortCol]));
    indexes.sort((a, b) => {
      const va = rows[a].values[sortCol];
      const vb = rows[b].values[sortCol];
      if (va === null && vb === null) return 0;
      if (va === null) return 1;
      if (vb === null) return -1;
      const cmp = numeric ? Number(va) - Number(vb) : va.localeCompare(vb);
      return sortDir === "asc" ? cmp : -cmp;
    });
    return indexes;
  }, [rowMatchesFilter, rows, sortCol, sortDir]);

  const orderedRows = useMemo(() => order.map((index) => rows[index]), [order, rows]);
  const selectedRows = useMemo(
    () => orderedRows.filter((row) => selectedIds.has(row.id) && row.status !== "deleted"),
    [orderedRows, selectedIds],
  );
  const cellBlockRange = useMemo(() => {
    if (!cellBlockSelection) return null;
    const anchorRow = orderedRows.findIndex((row) => row.id === cellBlockSelection.anchor.rowId);
    const focusRow = orderedRows.findIndex((row) => row.id === cellBlockSelection.focus.rowId);
    const anchorCol = visibleColumnIndexes.indexOf(cellBlockSelection.anchor.colIdx);
    const focusCol = visibleColumnIndexes.indexOf(cellBlockSelection.focus.colIdx);
    if (anchorRow < 0 || focusRow < 0 || anchorCol < 0 || focusCol < 0) return null;

    const [rowStart, rowEnd] = anchorRow <= focusRow ? [anchorRow, focusRow] : [focusRow, anchorRow];
    const [colStart, colEnd] = anchorCol <= focusCol ? [anchorCol, focusCol] : [focusCol, anchorCol];
    const rowsInRange = orderedRows
      .slice(rowStart, rowEnd + 1)
      .filter((row) => row.status !== "deleted");
    const colIdxs = visibleColumnIndexes.slice(colStart, colEnd + 1);
    return {
      rows: rowsInRange,
      rowIds: new Set(rowsInRange.map((row) => row.id)),
      colIdxs,
      colIdxSet: new Set(colIdxs),
    };
  }, [cellBlockSelection, orderedRows, visibleColumnIndexes]);
  const selectionRows = cellBlockRange?.rows ?? selectedRows;
  const selectionRowCount = selectionRows.length;
  const nonDeletedOrderedRows = useMemo(
    () => orderedRows.filter((row) => row.status !== "deleted"),
    [orderedRows],
  );
  const changeCounts = useMemo(
    () => ({
      inserted: rows.filter((row) => row.status === "inserted").length,
      updated: rows.filter((row) => row.status === "updated").length,
      deleted: rows.filter((row) => row.status === "deleted").length,
    }),
    [rows],
  );
  const pendingChangeCount = changeCounts.inserted + changeCounts.updated + changeCounts.deleted;

  const searchMatchCount = useMemo(() => {
    const needle = searchText.trim().toLowerCase();
    if (!needle) return 0;
    let count = 0;
    for (const row of orderedRows) {
      for (const index of visibleColumnIndexes) {
        if ((row.values[index] ?? "").toLowerCase().includes(needle)) count += 1;
      }
    }
    return count;
  }, [orderedRows, searchText, visibleColumnIndexes]);

  const toggleSort = (col: number) => {
    if (sortCol !== col) {
      setSortCol(col);
      setSortDir("asc");
    } else if (sortDir === "asc") {
      setSortDir("desc");
    } else {
      setSortCol(null);
      setSortDir(null);
    }
  };

  const setStatus = (message: string) => {
    setLocalNotice(message);
    onStatus?.(message);
  };

  const openDropdown = (event: MouseEvent<HTMLButtonElement>, items: MenuItem[]) => {
    const rect = event.currentTarget.getBoundingClientRect();
    openMenuAt(rect.left, rect.bottom + 4, items);
  };

  const applyColumnFilter = (columnIndex: number, config: ColumnFilterConfig) => {
    setColumnFilters((current) => {
      const next = { ...current };
      if (isColumnFilterActive(config)) next[columnIndex] = config;
      else delete next[columnIndex];
      return next;
    });
  };

  const updateDraftColumnFilter = (patch: Partial<ColumnFilterConfig>) => {
    setDraftColumnFilter((current) => ({ ...current, ...patch }));
  };

  const toggleDraftColumnFilterValue = (value: string | null) => {
    setDraftColumnFilter((current) => {
      const key = filterValueKey(value);
      const selected = current.selectedValues.some((item) => filterValueKey(item) === key)
        ? current.selectedValues.filter((item) => filterValueKey(item) !== key)
        : [...current.selectedValues, value];
      return { ...current, selectedValues: selected };
    });
  };

  const clearAllFilters = () => {
    setFilterText("");
    setColumnFilters({});
    setOpenColumnFilter(null);
  };

  const openColumnFilterPanel = (event: MouseEvent<HTMLButtonElement>, columnIndex: number) => {
    event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();
    const width = 280;
    const left = Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8));
    const top = Math.max(8, Math.min(rect.bottom + 4, window.innerHeight - 360));
    const current = columnFilters[columnIndex] ?? DEFAULT_COLUMN_FILTER;
    setDraftColumnFilter({
      text: current.text,
      mode: current.mode,
      selectedValues: [...current.selectedValues],
    });
    setOpenColumnFilter({ columnIndex, left, top });
  };

  const columnStyle = (columnIndex: number): CSSProperties => {
    const width = columnWidths[columnIndex];
    if (width) {
      return { flex: `0 0 ${width}px`, minWidth: 56, maxWidth: width };
    }
    return autoFit ? { flex: "1 1 140px", minWidth: 88 } : { flex: "0 0 160px", minWidth: 88 };
  };

  const startColumnResize = (event: MouseEvent<HTMLElement>, columnIndex: number) => {
    event.preventDefault();
    event.stopPropagation();
    const parent = event.currentTarget.parentElement;
    const startX = event.clientX;
    const startWidth = Math.max(56, parent?.getBoundingClientRect().width ?? columnWidths[columnIndex] ?? 160);
    const onMove = (moveEvent: globalThis.MouseEvent) => {
      const next = Math.max(56, Math.round(startWidth + moveEvent.clientX - startX));
      setColumnWidths((current) => ({ ...current, [columnIndex]: next }));
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  };

  const startCellBlockSelection = (event: MouseEvent<HTMLElement>, rowId: string, colIdx: number) => {
    if (!isGridBlockSelectionMouseEvent(event)) return;
    event.preventDefault();
    event.stopPropagation();
    const cell = { rowId, colIdx };
    setSelectedIds(new Set());
    setLastSelectedId(null);
    setActiveCell(cell);
    setCellBlockSelection({ anchor: cell, focus: cell, dragging: true });
    containerRef.current?.focus();
  };

  const extendCellBlockSelection = (rowId: string, colIdx: number) => {
    setCellBlockSelection((current) => {
      if (!current?.dragging) return current;
      return { ...current, focus: { rowId, colIdx } };
    });
  };

  const extendCellBlockSelectionByKeyboard = (key: string) => {
    const origin = cellBlockSelection?.anchor ?? activeCell;
    const focus = cellBlockSelection?.focus ?? activeCell;
    if (!origin || !focus || orderedRows.length === 0 || visibleColumnIndexes.length === 0) return false;

    const currentRowPos = orderedRows.findIndex((row) => row.id === focus.rowId);
    const currentColPos = visibleColumnIndexes.indexOf(focus.colIdx);
    if (currentRowPos < 0 || currentColPos < 0) return false;

    let nextRowPos = currentRowPos;
    let nextColPos = currentColPos;
    if (key === "ArrowUp") nextRowPos -= 1;
    if (key === "ArrowDown") nextRowPos += 1;
    if (key === "ArrowLeft") nextColPos -= 1;
    if (key === "ArrowRight") nextColPos += 1;
    nextRowPos = Math.max(0, Math.min(orderedRows.length - 1, nextRowPos));
    nextColPos = Math.max(0, Math.min(visibleColumnIndexes.length - 1, nextColPos));

    const next = {
      rowId: orderedRows[nextRowPos].id,
      colIdx: visibleColumnIndexes[nextColPos],
    };
    setSelectedIds(new Set());
    setLastSelectedId(null);
    setActiveCell(next);
    setCellBlockSelection({ anchor: origin, focus: next, dragging: false });
    return true;
  };

  const selectRow = (rowId: string, event: MouseEvent<HTMLElement>) => {
    setCellBlockSelection(null);
    const orderedIds = orderedRows.map((row) => row.id);
    setSelectedIds((current) => {
      if (event.shiftKey && lastSelectedId && orderedIds.includes(lastSelectedId)) {
        const from = orderedIds.indexOf(lastSelectedId);
        const to = orderedIds.indexOf(rowId);
        const [start, end] = from < to ? [from, to] : [to, from];
        const next = new Set(current);
        orderedIds.slice(start, end + 1).forEach((id) => next.add(id));
        return next;
      }
      if (event.ctrlKey || event.metaKey) {
        const next = new Set(current);
        if (next.has(rowId)) next.delete(rowId);
        else next.add(rowId);
        return next;
      }
      return new Set([rowId]);
    });
    setLastSelectedId(rowId);
  };

  const updateCell = (rowId: string, colIdx: number, value: string | null) => {
    setRows((current) =>
      current.map((row) => {
        if (row.id !== rowId || row.status === "deleted") return row;
        const values = [...row.values];
        values[colIdx] = value;
        return { ...row, values, status: statusAfterValueChange(row, values) };
      }),
    );
  };

  const beginEdit = (rowId: string, colIdx: number, currentValue: string | null) => {
    setActiveCell({ rowId, colIdx });
    setEditingCell({ rowId, colIdx });
    setEditValue(currentValue ?? "");
  };

  const commitEdit = () => {
    if (!editingCell) return;
    updateCell(editingCell.rowId, editingCell.colIdx, editValue);
    setEditingCell(null);
  };

  const cancelEdit = () => {
    setEditingCell(null);
    setEditValue("");
  };

  const targetCellPositions = useCallback(() => {
    if (activeCell) {
      const targetIds = selectedIds.size > 0 ? selectedIds : new Set([activeCell.rowId]);
      return rows
        .filter((row) => targetIds.has(row.id) && row.status !== "deleted")
        .map((row) => ({ rowId: row.id, colIdx: activeCell.colIdx }));
    }
    if (selectedIds.size > 0) {
      return rows
        .filter((row) => selectedIds.has(row.id) && row.status !== "deleted")
        .flatMap((row) => visibleColumnIndexes.map((colIdx) => ({ rowId: row.id, colIdx })));
    }
    return [];
  }, [activeCell, rows, selectedIds, visibleColumnIndexes]);

  const applyValueToTargets = (valueFactory: () => string | null) => {
    const targets = targetCellPositions();
    if (targets.length === 0) {
      setStatus("Select a row or cell before applying an edit value.");
      return;
    }
    setRows((current) =>
      current.map((row) => {
        const rowTargets = targets.filter((target) => target.rowId === row.id);
        if (rowTargets.length === 0 || row.status === "deleted") return row;
        const values = [...row.values];
        for (const target of rowTargets) {
          values[target.colIdx] = valueFactory();
        }
        return { ...row, values, status: statusAfterValueChange(row, values) };
      }),
    );
    setStatus(`Edited ${targets.length} cell(s).`);
  };

  const addRow = () => {
    const row: GridRow = {
      id: nextRowId("inserted"),
      originalIndex: null,
      values: result.columns.map(() => null),
      original: null,
      status: "inserted",
    };
    setRows((current) => [...current, row]);
    setSelectedIds(new Set([row.id]));
    setCellBlockSelection(null);
    setActiveCell(result.columns.length > 0 ? { rowId: row.id, colIdx: 0 } : null);
    setStatus("Added a new grid row.");
  };

  const duplicateRows = () => {
    const sources =
      selectedRows.length > 0
        ? selectedRows
        : activeCell
          ? rows.filter((row) => row.id === activeCell.rowId && row.status !== "deleted")
          : [];
    if (sources.length === 0) {
      setStatus("Select at least one row to duplicate.");
      return;
    }
    const copies = sources.map<GridRow>((row) => ({
      id: nextRowId("copy"),
      originalIndex: null,
      values: [...row.values],
      original: null,
      status: "inserted",
    }));
    setRows((current) => [...current, ...copies]);
    setSelectedIds(new Set(copies.map((row) => row.id)));
    setStatus(`Duplicated ${copies.length} row(s).`);
  };

  const deleteRows = () => {
    const targetIds = selectedIds.size > 0 ? selectedIds : activeCell ? new Set([activeCell.rowId]) : new Set<string>();
    if (targetIds.size === 0) {
      setStatus("Select at least one row to delete.");
      return;
    }
    setRows((current) =>
      current
        .filter((row) => !(targetIds.has(row.id) && row.status === "inserted"))
        .map((row) => (targetIds.has(row.id) ? { ...row, status: "deleted" } : row)),
    );
    setSelectedIds(new Set());
    setActiveCell(null);
    setStatus(`Marked ${targetIds.size} row(s) for deletion.`);
  };

  const undoChanges = () => {
    setRows(makeRows(result));
    setSelectedIds(new Set());
    setActiveCell(null);
    setEditingCell(null);
    setStatus("Reverted unsubmitted grid changes.");
  };

  const submitChanges = async () => {
    const changes: QueryGridRowChange[] = rows
      .filter((row) => row.status !== "clean")
      .map((row) => ({
        status: row.status as QueryGridRowChange["status"],
        originalIndex: row.originalIndex,
        values: [...row.values],
        original: row.original ? [...row.original] : null,
      }));
    if (changes.length === 0) return;
    const ok = await confirmAppDialog({
      title: "Apply grid changes",
      message: `Apply grid changes to the database?\n\nAdded: ${changeCounts.inserted}\nModified: ${changeCounts.updated}\nDeleted: ${changeCounts.deleted}`,
      confirmLabel: "Apply",
      danger: changeCounts.deleted > 0,
    });
    if (!ok) {
      setStatus("Grid change submit canceled.");
      return;
    }
    if (!onCommitChanges) {
      setStatus("This result sheet cannot be written back because no editable table metadata is available.");
      return;
    }
    setSubmittingChanges(true);
    try {
      await onCommitChanges({ columns: result.columns, changes, counts: changeCounts });
      const keptRows = rows.filter((row) => row.status !== "deleted");
      setRows(
        keptRows.map((row, index) => ({
          id: `row-${index}-${keptRows.length}`,
          originalIndex: index,
          values: [...row.values],
          original: [...row.values],
          status: "clean",
        })),
      );
      setSelectedIds(new Set());
      setCellBlockSelection(null);
      setActiveCell(null);
      setStatus(`Submitted ${changes.length} grid change(s).`);
    } catch (err) {
      setStatus(`Submit failed: ${String(err)}`);
    } finally {
      setSubmittingChanges(false);
    }
  };

  const openCellValueViewer = (row: GridRow, colIdx: number): boolean => {
    const column = result.columns[colIdx];
    if (!column || row.status === "deleted") return false;
    const visibleRowIndex = orderedRows.findIndex((candidate) => candidate.id === row.id);
    const fallbackRowIndex = Math.max(0, visibleRowIndex >= 0 ? visibleRowIndex : rows.findIndex((candidate) => candidate.id === row.id));
    setCellValueViewer({
      rowNumber: (row.originalIndex ?? fallbackRowIndex) + 1,
      column,
      value: row.values[colIdx] ?? null,
    });
    return true;
  };

  const openActiveCellValueViewer = (): boolean => {
    if (!activeCell) return false;
    const row = rows.find((candidate) => candidate.id === activeCell.rowId);
    if (!row) return false;
    return openCellValueViewer(row, activeCell.colIdx);
  };

  const copyCellViewerValue = async (viewer: CellValueViewer) => {
    try {
      await writeText(viewer.value ?? "");
      setStatus("Copied full cell value.");
    } catch (err) {
      setStatus(`Copy failed: ${String(err)}`);
    }
  };

  const rowsForTarget = (target: ExportTarget): GridRow[] => {
    if (target === "selection" && selectionRows.length > 0) return selectionRows;
    return nonDeletedOrderedRows;
  };

  const columnsForTarget = (target: ExportTarget, columns: ExportColumnConfig[]): ExportColumnConfig[] => {
    if (target !== "selection" || !cellBlockRange) return columns;
    return columns.filter((_, index) => cellBlockRange.colIdxSet.has(index));
  };

  const exportWithOptions = async (
    target: ExportTarget,
    options: ExportOptions,
    columns: ExportColumnConfig[],
    destination?: ExportDestination,
    openAfter = false,
  ) => {
    const rowsToExport = rowsForTarget(target);
    const columnsToExport = columnsForTarget(target, columns);
    if (rowsToExport.length === 0 || columnsToExport.filter((column) => column.export).length === 0) {
      setStatus("No result rows are available for export.");
      return;
    }
    try {
      const serialized = serializeResult(result.columns, rowsToExport, columnsToExport, options, sourceSql);
      const bytes = encodeOutput(serialized.text, options.encoding);
      const filename = `query-results-${Date.now()}.${serialized.extension}`;
      if (openAfter && !isTauriRuntime()) {
        browserOpen(bytes, serialized.mime);
        return;
      }
      if (openAfter && isTauriRuntime()) {
        const path = await temporaryFilePath(filename);
        await writeBytesToPath(path, bytes);
        await sftpOpenPath(path);
        setStatus(`Opened ${rowsToExport.length} row(s) with the system default application.`);
        return;
      }
      if (destination?.kind === "clipboard") {
        await writeText(serialized.text);
        setStatus(`Copied ${rowsToExport.length} exported row(s) to clipboard.`);
        return;
      }
      if (destination?.kind === "sqlCommander") {
        const targetTab =
          destination.sqlCommanderTabId === "active"
            ? getActiveQueryTab()
            : listQueryTabs().find((entry) => entry.tabId === destination.sqlCommanderTabId) ?? getActiveQueryTab();
        if (!targetTab) throw new Error("No SQL Commander editor is available.");
        targetTab.insertQuery(serialized.text, {
          destination: destination.sqlCommanderTabId === "new" ? "new" : "current",
          position: destination.sqlCommanderPosition,
        });
        setStatus(`Sent ${rowsToExport.length} exported row(s) to SQL Commander.`);
        return;
      }
      if (isTauriRuntime()) {
        const requestedPath = destination?.kind === "file" ? destination.filePath.trim() : "";
        const path = requestedPath || (await selectSaveFilePath(filename));
        if (!path) return;
        await writeBytesToPath(path, bytes);
        const nextHistory = [path, ...readExportFileHistory().filter((entry) => entry !== path)];
        writeExportFileHistory(nextHistory);
        setStatus(`Exported ${rowsToExport.length} row(s) to ${path}`);
        return;
      }
      browserDownload(bytes, filename, serialized.mime);
      setStatus(`Exported ${rowsToExport.length} row(s).`);
    } catch (err) {
      const message = `${openAfter ? "Open" : "Export"} failed: ${String(err)}`;
      if (openAfter) {
        await alertAppDialog({
          title: "Open failed",
          message,
        });
      }
      setStatus(message);
    }
  };

  const openSpreadsheet = (target: ExportTarget) => {
    const options: ExportOptions = {
      ...exportOptions,
      outputFormat: "excel",
      includeColumnNames: true,
      maxRows: 0,
    };
    void exportWithOptions(target, options, exportColumns, undefined, true);
  };

  const openBrowser = (target: ExportTarget) => {
    const options: ExportOptions = {
      ...exportOptions,
      outputFormat: "html",
      includeColumnNames: true,
      maxRows: 0,
    };
    void exportWithOptions(target, options, exportColumns, undefined, true);
  };

  const copyRows = async (target: ExportTarget) => {
    const rowsToCopy = rowsForTarget(target);
    if (rowsToCopy.length === 0) return;
    const options = { ...DEFAULT_EXPORT_OPTIONS, outputFormat: "csv" as const, columnDelimiter: "\t" };
    const columnsToCopy = columnsForTarget(target, exportColumns).filter((_, index) => visibleColumns.has(index));
    const serialized = serializeResult(result.columns, rowsToCopy, columnsToCopy, options, sourceSql);
    try {
      await writeText(serialized.text);
      setStatus(`Copied ${rowsToCopy.length} row(s).`);
    } catch (err) {
      setStatus(`Copy failed: ${String(err)}`);
    }
  };

  const copyGeneratedSql = async () => {
    if (!generatedSql) return;
    try {
      await writeText(generatedSql);
      setStatus("Copied generated SQL.");
    } catch (err) {
      setStatus(`Copy generated SQL failed: ${String(err)}`);
    }
  };

  const generatedSqlForFilters = (filters: Record<number, ColumnFilterConfig>): string | null => {
    const activeFilters = Object.entries(filters)
      .map(([rawIndex, config]) => ({
        columnIndex: Number(rawIndex),
        text: config.text.trim(),
        mode: config.mode,
        selectedValues: config.selectedValues,
      }))
      .filter(
        (filter) =>
          Number.isInteger(filter.columnIndex) &&
          filter.columnIndex >= 0 &&
          filter.columnIndex < result.columns.length &&
          (filter.text.length > 0 || filter.selectedValues.length > 0),
      );
    return buildGeneratedResultSql({
      sourceSql: baseSql ?? sourceSql,
      currentSql: sourceSql,
      sqlEngine,
      columns: result.columns,
      visibleColumnIndexes,
      globalFilterText: filterText,
      columnFilters: activeFilters,
      sortCol,
      sortDir,
    });
  };

  const queryGeneratedSql = (sql = generatedSql) => {
    if (!sql) {
      setStatus("No local filter or sort changes to query.");
      return;
    }
    if (onGeneratedSqlQuery) {
      void Promise.resolve(onGeneratedSqlQuery(sql)).catch((err) => {
        setStatus(`Query generated SQL failed: ${String(err)}`);
      });
      return;
    }
    syncGeneratedSql("sync", sql);
  };

  const syncGeneratedSql = (mode: QueryGeneratedSqlSyncMode, sql = generatedSql) => {
    if (!sql) return;
    if (onGeneratedSqlSync) {
      onGeneratedSqlSync(sql, mode);
      return;
    }
    const targetTab = getActiveQueryTab() ?? listQueryTabs().find((entry) => entry.engine === sqlEngine);
    if (!targetTab) {
      setStatus("No SQL Commander editor is available.");
      return;
    }
    targetTab.insertQuery(sql, { destination: "current", position: "last" });
    setStatus("Inserted generated SQL in SQL Commander.");
  };

  const handleGridKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (editingCell) return;
    if (
      event.altKey && event.shiftKey && !event.ctrlKey && !event.metaKey &&
      (event.key === "ArrowUp" || event.key === "ArrowDown" || event.key === "ArrowLeft" || event.key === "ArrowRight")
    ) {
      if (extendCellBlockSelectionByKeyboard(event.key)) {
        event.preventDefault();
      }
      return;
    }
    if (event.key === "Escape" && cellBlockSelection) {
      event.preventDefault();
      setCellBlockSelection(null);
      return;
    }
    if (event.ctrlKey && !event.shiftKey && !event.altKey && !event.metaKey && event.key === "Enter") {
      if (openActiveCellValueViewer()) {
        event.preventDefault();
      }
      return;
    }
    if ((event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "c") {
      if (selectionRowCount > 0 || activeCell) {
        event.preventDefault();
        if (selectionRowCount > 0) {
          void copyRows("selection");
        } else if (activeCell) {
          const row = rows.find((candidate) => candidate.id === activeCell.rowId);
          void writeText(row?.values[activeCell.colIdx] ?? "");
          setStatus("Copied cell.");
        }
      }
    }
  };

  const cellMenu = (row: GridRow, colIdx: number): MenuItem[] => [
    ...(cellBlockRange?.rowIds.has(row.id) && cellBlockRange.colIdxSet.has(colIdx)
      ? [
          {
            label: "Copy block selection",
            icon: <Copy className="w-3.5 h-3.5" />,
            onClick: () => void copyRows("selection"),
          },
          { separator: true, label: "block-selection-separator" },
        ]
      : []),
    {
      label: "View full value",
      icon: <FileText className="w-3.5 h-3.5" />,
      shortcut: "Ctrl+Enter",
      onClick: () => void openCellValueViewer(row, colIdx),
      disabled: row.status === "deleted",
    },
    { separator: true, label: "view-value-separator" },
    {
      label: "Copy cell",
      icon: <Copy className="w-3.5 h-3.5" />,
      onClick: () => void writeText(row.values[colIdx] ?? ""),
    },
    {
      label: "Copy row",
      onClick: () => void writeText(row.values.map((cell) => cell ?? "").join("\t")),
    },
    {
      label: "Copy row as CSV",
      onClick: () => void writeText(row.values.map(csvEscape).join(",")),
    },
    { separator: true, label: "edit-separator" },
    {
      label: "Edit cell",
      icon: <Edit3 className="w-3.5 h-3.5" />,
      onClick: () => beginEdit(row.id, colIdx, row.values[colIdx]),
      disabled: row.status === "deleted",
    },
  ];

  const columnMenu = (): MenuItem[] => [
    {
      label: "Show all columns",
      onClick: () => setVisibleColumns(new Set(result.columns.map((_, index) => index))),
    },
    {
      label: "Hide all columns",
      onClick: () => setVisibleColumns(new Set()),
    },
    { separator: true, label: "column-separator" },
    ...result.columns.map<MenuItem>((column, index) => ({
      label: column.name,
      checked: visibleColumns.has(index),
      onClick: () =>
        setVisibleColumns((current) => {
          const next = new Set(current);
          if (next.has(index)) next.delete(index);
          else next.add(index);
          return next;
        }),
    })),
  ];

  const total = orderedRows.length;
  const startRow = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const endRow = Math.min(total, Math.ceil((scrollTop + viewportH) / ROW_HEIGHT) + OVERSCAN);
  const visible = order.slice(startRow, endRow);
  const searchNeedle = searchText.trim().toLowerCase();
  const openFilterColumnIndex = openColumnFilter?.columnIndex ?? null;
  const openFilterColumn = openFilterColumnIndex !== null ? result.columns[openFilterColumnIndex] : null;
  const openFilterConfig = openFilterColumnIndex !== null
    ? draftColumnFilter
    : DEFAULT_COLUMN_FILTER;
  const openFilterDistinctValues = useMemo(
    () => {
      if (openFilterColumnIndex === null) return { values: [], total: 0, truncated: false };
      const summary = distinctValuesForColumn(rows, openFilterColumnIndex);
      const needle = draftColumnFilter.text.trim().toLowerCase();
      if (!needle) return summary;
      return {
        ...summary,
        values: summary.values.filter((item) => item.label.toLowerCase().includes(needle)),
      };
    },
    [draftColumnFilter.text, openFilterColumnIndex, rows],
  );
  const openFilterSelectedKeys = new Set(openFilterConfig.selectedValues.map(filterValueKey));
  const filterModeButtonStyle = (active: boolean): CSSProperties | undefined =>
    active
      ? {
          background: "var(--taomni-selected)",
          borderColor: "var(--taomni-selected-border)",
          color: "var(--taomni-accent)",
        }
      : undefined;
  const applyLocalColumnFilter = () => {
    if (openFilterColumnIndex === null) return;
    applyColumnFilter(openFilterColumnIndex, draftColumnFilter);
    setOpenColumnFilter(null);
  };
  const queryColumnFilter = () => {
    if (openFilterColumnIndex === null) return;
    const nextFilters = { ...columnFilters };
    if (isColumnFilterActive(draftColumnFilter)) nextFilters[openFilterColumnIndex] = draftColumnFilter;
    else delete nextFilters[openFilterColumnIndex];
    setColumnFilters(nextFilters);
    setOpenColumnFilter(null);
    queryGeneratedSql(generatedSqlForFilters(nextFilters));
  };

  const stats = useMemo(() => {
    return visibleColumnIndexes.map((columnIndex) => {
      const column = result.columns[columnIndex];
      const values = nonDeletedOrderedRows.map((row) => row.values[columnIndex]);
      const nonNull = values.filter((value): value is string => value !== null && value !== "");
      const numeric = nonNull.map(Number).filter((value) => Number.isFinite(value));
      return {
        column,
        count: values.length,
        nulls: values.length - nonNull.length,
        distinct: new Set(nonNull).size,
        min: numeric.length > 0 ? Math.min(...numeric) : nonNull.slice().sort()[0] ?? "",
        max: numeric.length > 0 ? Math.max(...numeric) : nonNull.slice().sort().at(-1) ?? "",
        avg: numeric.length > 0 ? numeric.reduce((sum, value) => sum + value, 0) / numeric.length : null,
      };
    });
  }, [nonDeletedOrderedRows, result.columns, visibleColumnIndexes]);

  const chartData = useMemo(() => {
    const numericColumn = visibleColumnIndexes.find((index) =>
      nonDeletedOrderedRows.some((row) => isNumeric(row.values[index])),
    );
    if (numericColumn === undefined) return null;
    const labelColumn = visibleColumnIndexes.find((index) => index !== numericColumn) ?? numericColumn;
    const points = nonDeletedOrderedRows.slice(0, 50).map((row, index) => ({
      label: row.values[labelColumn] ?? `Row ${index + 1}`,
      value: Number(row.values[numericColumn]) || 0,
    }));
    const max = Math.max(1, ...points.map((point) => Math.abs(point.value)));
    return { column: result.columns[numericColumn], points, max };
  }, [nonDeletedOrderedRows, result.columns, visibleColumnIndexes]);

  if (result.columns.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-[12px] text-[var(--taomni-text-muted)]">
        {result.rowsAffected > 0
          ? `${result.rowsAffected} row(s) affected`
          : "Statement executed. No result set."}
      </div>
    );
  }

  return (
    <div
      className="flex-1 min-h-0 flex flex-col"
      data-testid="query-result-grid"
      style={{ fontSize: "var(--taomni-db-font-size, 12px)" }}
    >
      <div
        className="min-h-8 shrink-0 flex flex-wrap items-center gap-1 px-1 py-1"
        style={{ background: "var(--taomni-quick-bg)", borderBottom: "1px solid var(--taomni-divider)" }}
      >
        <ToolButton
          title="Refresh result"
          disabled={running || !onRefresh}
          onClick={() => onRefresh?.("normal")}
          icon={running ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
        />
        <ToolButton
          title="Refresh mode"
          disabled={running || !onRefresh}
          onClick={(event) =>
            openDropdown(event, [
              { label: "Refresh", onClick: () => onRefresh?.("normal") },
              { label: "Refresh with current row limit", onClick: () => onRefresh?.("currentLimit") },
              { label: "Clear view and refresh", onClick: () => onRefresh?.("clearView") },
            ])
          }
          icon={<ChevronDown className="w-3.5 h-3.5" />}
        />
        <ToolButton
          title="Stop query"
          disabled={!running || cancelling || !onCancel}
          onClick={() => onCancel?.()}
          icon={cancelling ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Ban className="w-3.5 h-3.5" />}
        />
        <Divider />
        <ToolButton
          title="Export"
          onClick={(event) =>
            openDropdown(event, [
              {
                label: "Export...",
                icon: <Download className="w-3.5 h-3.5" />,
                onClick: () => {
                  setExportTarget("all");
                  setExportDialogOpen(true);
                },
              },
              {
                label: "Export Selection...",
                icon: <Download className="w-3.5 h-3.5" />,
                disabled: selectionRowCount === 0,
                onClick: () => {
                  setExportTarget("selection");
                  setExportDialogOpen(true);
                },
              },
            ])
          }
          icon={<Download className="w-3.5 h-3.5" />}
          suffix={<ChevronDown className="w-3 h-3" />}
        />
        <ToolButton
          title="Open externally"
          onClick={(event) =>
            openDropdown(event, [
              {
                label: "Open as Spreadsheet...",
                shortcut: "Ctrl+Alt+X",
                icon: <FileSpreadsheet className="w-3.5 h-3.5" />,
                onClick: () => openSpreadsheet("all"),
              },
              {
                label: "Open Selection as Spreadsheet...",
                icon: <FileSpreadsheet className="w-3.5 h-3.5" />,
                disabled: selectionRowCount === 0,
                onClick: () => openSpreadsheet("selection"),
              },
              { separator: true, label: "open-separator" },
              {
                label: "Open in Web Browser...",
                icon: <ExternalLink className="w-3.5 h-3.5" />,
                onClick: () => openBrowser("all"),
              },
              {
                label: "Open Selection in Web Browser...",
                icon: <ExternalLink className="w-3.5 h-3.5" />,
                disabled: selectionRowCount === 0,
                onClick: () => openBrowser("selection"),
              },
            ])
          }
          icon={<ExternalLink className="w-3.5 h-3.5" />}
          suffix={<ChevronDown className="w-3 h-3" />}
        />
        <Divider />
        <ToolButton
          title="Show or hide columns"
          onClick={(event) => openDropdown(event, columnMenu())}
          icon={<Columns2 className="w-3.5 h-3.5" />}
        />
        <ToolButton
          title={autoFit ? "Use fixed column width" : "Auto-fit column width"}
          onClick={() => setAutoFit((value) => !value)}
          active={autoFit}
          icon={<Columns2 className="w-3.5 h-3.5" />}
        />
        <ToolButton
          title="Aggregate statistics"
          onClick={() => setShowStats((value) => !value)}
          active={showStats}
          icon={<Sigma className="w-3.5 h-3.5" />}
        />
        <ToolButton
          title="Filter rows"
          onClick={() => setFilterOpen((value) => !value)}
          active={filterOpen || !!filterText.trim() || activeColumnFilterCount > 0}
          icon={<Filter className="w-3.5 h-3.5" />}
        />
        <ToolButton
          title="Copy result"
          onClick={(event) =>
            openDropdown(event, [
              { label: "Copy Results", icon: <Copy className="w-3.5 h-3.5" />, onClick: () => void copyRows("all") },
              {
                label: "Copy Selection",
                icon: <Copy className="w-3.5 h-3.5" />,
                disabled: selectionRowCount === 0,
                onClick: () => void copyRows("selection"),
              },
            ])
          }
          icon={<Copy className="w-3.5 h-3.5" />}
        />
        <Divider />
        <ToolButton title="Add row" onClick={addRow} icon={<Plus className="w-3.5 h-3.5" />} />
        <ToolButton title="Duplicate row" onClick={duplicateRows} icon={<Copy className="w-3.5 h-3.5" />} />
        <ToolButton title="Delete row" onClick={deleteRows} icon={<Trash2 className="w-3.5 h-3.5" />} />
        <ToolButton
          title="Set value"
          onClick={(event) =>
            openDropdown(event, [
              { label: "Set to Current Date (yyyy-MM-dd)", onClick: () => applyValueToTargets(nowDateText) },
              { label: "Set to Current Time (HH:mm:ss)", onClick: () => applyValueToTargets(nowTimeText) },
              { label: "Set to Current Timestamp (yyyy-MM-dd HH:mm:ss)", onClick: () => applyValueToTargets(nowTimestampText) },
              { label: "Set to UUID (36 chars)", onClick: () => applyValueToTargets(() => crypto.randomUUID?.() ?? nextRowId("uuid")) },
              { label: "Set to Empty String", onClick: () => applyValueToTargets(() => "") },
              { label: 'Set to NULL "(null)"', onClick: () => applyValueToTargets(() => null) },
            ])
          }
          icon={<Edit3 className="w-3.5 h-3.5" />}
          suffix={<ChevronDown className="w-3 h-3" />}
        />
        <ToolButton
          title="Submit grid edits"
          disabled={pendingChangeCount === 0 || submittingChanges}
          onClick={() => void submitChanges()}
          icon={submittingChanges ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
        />
        <ToolButton
          title="Undo unsubmitted edits"
          disabled={pendingChangeCount === 0}
          onClick={undoChanges}
          icon={<RotateCcw className="w-3.5 h-3.5" />}
        />
        <Divider />
        {filterOpen && (
          <label className="h-6 inline-flex items-center gap-1 px-1 text-[11px] text-[var(--taomni-text-muted)]">
            <Filter className="w-3.5 h-3.5" />
            <input
              value={filterText}
              onChange={(event) => setFilterText(event.target.value)}
              className="taomni-input h-6 w-[150px] text-[11px]"
              placeholder="Filter rows"
              aria-label="Filter rows"
            />
          </label>
        )}
        {(filterText.trim() || activeColumnFilterCount > 0) && (
          <button
            type="button"
            className="h-6 px-1.5 inline-flex items-center gap-1 rounded text-[11px] hover:bg-[var(--taomni-hover)]"
            title="Clear filters"
            onClick={clearAllFilters}
          >
            <Ban className="w-3.5 h-3.5" />
            {activeColumnFilterCount > 0 ? `${activeColumnFilterCount} col` : "Clear"}
          </button>
        )}
        <label className="ml-auto h-6 inline-flex items-center gap-1 px-1 text-[11px] text-[var(--taomni-text-muted)]">
          <Search className="w-3.5 h-3.5" />
          <input
            value={searchText}
            onChange={(event) => setSearchText(event.target.value)}
            className="taomni-input h-6 w-[150px] text-[11px]"
            placeholder="Search"
            aria-label="Search result set"
          />
          {searchText && <span className="min-w-6 text-right">{searchMatchCount}</span>}
        </label>
        <div
          className="h-6 inline-flex items-center rounded"
          style={{ border: "1px solid var(--taomni-divider)", overflow: "hidden" }}
        >
          <ToolButton title="Table view" active={viewMode === "table"} onClick={() => setViewMode("table")} icon={<Table2 className="w-3.5 h-3.5" />} />
          <ToolButton title="List view" active={viewMode === "list"} onClick={() => setViewMode("list")} icon={<List className="w-3.5 h-3.5" />} />
          <ToolButton title="Chart view" active={viewMode === "chart"} onClick={() => setViewMode("chart")} icon={<BarChart3 className="w-3.5 h-3.5" />} />
        </div>
        {(pendingChangeCount > 0 || localNotice) && (
          <span className="max-w-[320px] truncate px-1 text-[10px] text-[var(--taomni-text-muted)]" title={localNotice}>
            {pendingChangeCount > 0
              ? `${changeCounts.inserted} add / ${changeCounts.updated} edit / ${changeCounts.deleted} delete`
              : localNotice}
          </span>
        )}
      </div>

      {generatedSql && (
        <div
          data-testid="query-result-generated-sql-bar"
          className="min-h-7 shrink-0 flex items-center gap-1.5 px-2 py-1 text-[11px]"
          style={{ background: "var(--taomni-bg)", borderBottom: "1px solid var(--taomni-divider)" }}
        >
          <FileText className="w-3.5 h-3.5 shrink-0 text-[var(--taomni-accent)]" />
          <span className="shrink-0 font-semibold text-[var(--taomni-text-muted)]">SQL</span>
          <code
            data-testid="query-result-generated-sql"
            className="min-w-0 flex-1 truncate rounded px-1.5 py-0.5 font-mono text-[10px]"
            style={{ background: "var(--taomni-quick-bg)", border: "1px solid var(--taomni-divider)" }}
            title={generatedSql}
          >
            {compactSqlForDisplay(generatedSql)}
          </code>
          <button
            type="button"
            data-testid="query-result-generated-sql-query"
            className="taomni-btn h-6 px-2 inline-flex items-center gap-1 text-[11px]"
            data-primary="true"
            title="Apply local filters and sort as a database query"
            aria-label="Query generated SQL"
            disabled={running || cancelling}
            onClick={() => queryGeneratedSql()}
          >
            <Check className="w-3.5 h-3.5" />
            Query
          </button>
          <button
            type="button"
            data-testid="query-result-generated-sql-copy"
            className="taomni-btn h-6 px-2 inline-flex items-center gap-1 text-[11px]"
            title="Copy generated SQL"
            aria-label="Copy generated SQL"
            onClick={() => void copyGeneratedSql()}
          >
            <Copy className="w-3.5 h-3.5" />
            Copy
          </button>
          <button
            type="button"
            data-testid="query-result-generated-sql-sync"
            className="taomni-btn h-6 px-2 inline-flex items-center gap-1 text-[11px]"
            title="Sync generated SQL to a query editor"
            aria-label="Sync generated SQL"
            onClick={() => syncGeneratedSql("sync")}
          >
            <RefreshCw className="w-3.5 h-3.5" />
            Sync
          </button>
        </div>
      )}

      {showStats && (
        <div
          className="max-h-[132px] shrink-0 overflow-auto taomni-scroll-y text-[11px]"
          style={{ borderBottom: "1px solid var(--taomni-divider)", background: "var(--taomni-bg)" }}
        >
          <div className="min-w-full inline-grid grid-cols-[minmax(120px,1fr)_repeat(6,minmax(70px,auto))]">
            <StatsCell header>Column</StatsCell>
            <StatsCell header>Rows</StatsCell>
            <StatsCell header>Null</StatsCell>
            <StatsCell header>Distinct</StatsCell>
            <StatsCell header>Min</StatsCell>
            <StatsCell header>Max</StatsCell>
            <StatsCell header>Avg</StatsCell>
            {stats.map((stat, index) => (
              <FragmentStats key={`${stat.column.name}-${index}`} stat={stat} />
            ))}
          </div>
        </div>
      )}

      {viewMode === "table" && (
        <>
          <div
            className="shrink-0 overflow-hidden select-none"
            style={{ background: "var(--taomni-quick-bg)", borderBottom: "1px solid var(--taomni-divider)" }}
          >
            <div
              data-testid="query-result-grid-header-scroll"
              className="flex text-[11px] font-semibold"
              style={{
                fontSize: "var(--taomni-db-font-size-sm, 11px)",
                transform: `translateX(${-scrollLeft}px)`,
                willChange: "transform",
              }}
            >
              <div
                className="w-12 px-1 py-1 text-[var(--taomni-text-muted)] shrink-0 flex items-center justify-between"
                style={{ borderRight: "1px solid var(--taomni-divider)" }}
              >
                <span>#</span>
                <span className="text-[10px]">{selectionRowCount || ""}</span>
              </div>
              {visibleColumnIndexes.map((columnIndex) => {
                const col = result.columns[columnIndex];
                const columnFilter = columnFilters[columnIndex] ?? DEFAULT_COLUMN_FILTER;
                const columnFiltered = isColumnFilterActive(columnFilter);
                return (
                  <div
                    key={columnIndex}
                    className="group relative px-2 py-1 text-left flex items-center gap-1 hover:bg-[var(--taomni-hover)]"
                    style={{ ...columnStyle(columnIndex), borderRight: "1px solid var(--taomni-divider)" }}
                    title={`${col.name} (${col.type})`}
                  >
                    <button
                      type="button"
                      className="min-w-0 flex flex-1 items-center gap-1 bg-transparent p-0 text-left"
                      onClick={() => toggleSort(columnIndex)}
                    >
                      <span className="truncate flex-1">{col.name}</span>
                      {sortCol === columnIndex && sortDir === "asc" && <ArrowUp className="w-3 h-3" />}
                      {sortCol === columnIndex && sortDir === "desc" && <ArrowDown className="w-3 h-3" />}
                    </button>
                    <button
                      type="button"
                      className={`mr-1 h-5 w-5 shrink-0 inline-flex items-center justify-center rounded transition-all hover:bg-[var(--taomni-hover)] ${
                        columnFiltered
                          ? "opacity-100 text-[var(--taomni-accent)] shadow-sm"
                          : "opacity-0 translate-y-0.5 text-[var(--taomni-text-muted)] group-hover:translate-y-0 group-hover:opacity-100 group-focus-within:translate-y-0 group-focus-within:opacity-100"
                      }`}
                      style={columnFiltered ? { background: "var(--taomni-selected)" } : undefined}
                      title={`Filter ${col.name}`}
                      aria-label={`Filter column ${col.name}`}
                      onClick={(event) => openColumnFilterPanel(event, columnIndex)}
                    >
                      <Filter className="w-3 h-3" />
                    </button>
                    <span
                      className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize hover:bg-[var(--taomni-accent)]"
                      onMouseDown={(event) => startColumnResize(event, columnIndex)}
                      title="Resize column"
                    />
                  </div>
                );
              })}
            </div>
          </div>

          <div
            ref={containerRef}
            data-testid="query-result-grid-scroll"
            className="flex-1 min-h-0 overflow-auto taomni-scroll-y"
            tabIndex={0}
            onScroll={onScroll}
            onKeyDown={handleGridKeyDown}
          >
            <div style={{ height: total * ROW_HEIGHT, position: "relative" }}>
              {visible.map((rowIndex, i) => {
                const row = rows[rowIndex];
                const top = (startRow + i) * ROW_HEIGHT;
                const selected = selectedIds.has(row.id);
                return (
                  <div
                    key={row.id}
                    className="flex absolute left-0 right-0"
                    style={{
                      top,
                      height: ROW_HEIGHT,
                      borderBottom: "1px solid var(--taomni-divider)",
                      background: selected
                        ? "var(--taomni-selected)"
                        : row.status === "deleted"
                          ? "rgba(217, 83, 79, 0.12)"
                          : row.status === "inserted"
                            ? "rgba(98, 211, 111, 0.10)"
                            : row.status === "updated"
                              ? "rgba(230, 168, 23, 0.10)"
                              : undefined,
                      opacity: row.status === "deleted" ? 0.65 : undefined,
                    }}
                  >
                    <button
                      type="button"
                      className="w-12 px-1 text-right text-[var(--taomni-text-muted)] shrink-0 flex items-center justify-end hover:bg-[var(--taomni-hover)]"
                      style={{ borderRight: "1px solid var(--taomni-divider)" }}
                      onClick={(event) => selectRow(row.id, event)}
                      title={row.status === "clean" ? `Row ${(row.originalIndex ?? rowIndex) + 1}` : row.status}
                    >
                      <span className="mr-1 text-[10px]">
                        {row.status === "inserted" ? "+" : row.status === "updated" ? "~" : row.status === "deleted" ? "-" : ""}
                      </span>
                      {(row.originalIndex ?? rowIndex) + 1}
                    </button>
                    {visibleColumnIndexes.map((columnIndex) => {
                      const cell = row.values[columnIndex];
                      const active = activeCell?.rowId === row.id && activeCell.colIdx === columnIndex;
                      const editing = editingCell?.rowId === row.id && editingCell.colIdx === columnIndex;
                      const searchHit = !!searchNeedle && (cell ?? "").toLowerCase().includes(searchNeedle);
                      const blockSelected = !!cellBlockRange?.rowIds.has(row.id) && cellBlockRange.colIdxSet.has(columnIndex);
                      return (
                        <div
                          key={columnIndex}
                          className={`px-2 flex items-center truncate ${
                            isNumeric(cell) ? "justify-end font-mono" : ""
                          }`}
                          style={{
                            ...columnStyle(columnIndex),
                            borderRight: "1px solid var(--taomni-divider)",
                            outline: active ? "1px solid var(--taomni-accent)" : undefined,
                            background: blockSelected
                              ? "var(--taomni-editor-selection-bg)"
                              : searchHit
                                ? "rgba(230, 168, 23, 0.22)"
                                : undefined,
                          }}
                          title={cell ?? "NULL"}
                          onMouseDown={(event) => startCellBlockSelection(event, row.id, columnIndex)}
                          onMouseEnter={() => extendCellBlockSelection(row.id, columnIndex)}
                          onClick={(event) => {
                            if (event.altKey) return;
                            setCellBlockSelection(null);
                            setActiveCell({ rowId: row.id, colIdx: columnIndex });
                            selectRow(row.id, event);
                          }}
                          onDoubleClick={() => beginEdit(row.id, columnIndex, cell)}
                          onContextMenu={(event) => openCellMenu(event, cellMenu(row, columnIndex))}
                        >
                          {editing ? (
                            <input
                              autoFocus
                              className="taomni-input h-5 w-full text-[12px]"
                              value={editValue}
                              onChange={(event) => setEditValue(event.target.value)}
                              onBlur={commitEdit}
                              onKeyDown={(event) => {
                                if (event.key === "Enter") commitEdit();
                                if (event.key === "Escape") cancelEdit();
                              }}
                            />
                          ) : cell === null ? (
                            <span
                              className="text-[10px] px-1 rounded"
                              style={{ background: "var(--taomni-divider)", color: "var(--taomni-text-muted)" }}
                            >
                              NULL
                            </span>
                          ) : (
                            <span className={row.status === "deleted" ? "truncate line-through" : "truncate"}>{cell}</span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          </div>
        </>
      )}

      {viewMode === "list" && (
        <div
          className="flex-1 min-h-0 overflow-auto taomni-scroll-y p-2 text-[12px]"
          tabIndex={0}
          onKeyDown={handleGridKeyDown}
        >
          {nonDeletedOrderedRows.map((row, rowIndex) => (
            <div
              key={row.id}
              className="mb-2 rounded p-2"
              style={{ border: "1px solid var(--taomni-divider)", background: "var(--taomni-panel-bg)" }}
            >
              <div className="mb-1 text-[11px] text-[var(--taomni-text-muted)]">Row {(row.originalIndex ?? rowIndex) + 1}</div>
              <div className="grid grid-cols-[minmax(90px,180px)_1fr] gap-x-3 gap-y-1">
                {visibleColumnIndexes.map((columnIndex) => (
                  <div key={columnIndex} className="contents">
                    <div className="truncate text-[var(--taomni-text-muted)]">{result.columns[columnIndex].name}</div>
                    <div
                      className="min-w-0 truncate rounded px-1 -mx-1 hover:bg-[var(--taomni-hover)]"
                      title={row.values[columnIndex] ?? "NULL"}
                      onClick={(event) => {
                        setCellBlockSelection(null);
                        setActiveCell({ rowId: row.id, colIdx: columnIndex });
                        selectRow(row.id, event);
                      }}
                      onDoubleClick={() => openCellValueViewer(row, columnIndex)}
                      onContextMenu={(event) => openCellMenu(event, cellMenu(row, columnIndex))}
                    >
                      {row.values[columnIndex] ?? <span className="text-[var(--taomni-text-muted)]">NULL</span>}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {viewMode === "chart" && (
        <div className="flex-1 min-h-0 overflow-auto taomni-scroll-y p-3 text-[12px]">
          {!chartData ? (
            <div className="h-full flex items-center justify-center text-[var(--taomni-text-muted)]">
              No numeric column is available for chart view.
            </div>
          ) : (
            <div className="min-w-[420px]">
              <div className="mb-2 text-[11px] text-[var(--taomni-text-muted)]">
                {chartData.column.name} (first {chartData.points.length} rows)
              </div>
              <div className="space-y-1">
                {chartData.points.map((point, index) => (
                  <div key={`${point.label}-${index}`} className="grid grid-cols-[160px_1fr_72px] items-center gap-2">
                    <div className="truncate text-[var(--taomni-text-muted)]" title={point.label}>{point.label}</div>
                    <div className="h-4" style={{ background: "var(--taomni-divider)" }}>
                      <div
                        className="h-4"
                        style={{
                          width: `${Math.max(2, (Math.abs(point.value) / chartData.max) * 100)}%`,
                          background: point.value < 0 ? "#d9534f" : "var(--taomni-accent)",
                        }}
                      />
                    </div>
                    <div className="text-right font-mono">{point.value}</div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {exportDialogOpen && (
        <ExportDialog
          options={exportOptions}
          columns={exportColumns}
          target={exportTarget}
          rowCount={rowsForTarget(exportTarget).length}
          totalRows={nonDeletedOrderedRows.length}
          onOptionsChange={setExportOptions}
          onColumnsChange={setExportColumns}
          onClose={() => setExportDialogOpen(false)}
          onExport={(options, columns, destination) => {
            setExportOptions(options);
            setExportColumns(columns);
            setExportDialogOpen(false);
            void exportWithOptions(exportTarget, options, columns, destination);
          }}
        />
      )}
      {cellValueViewer && (
        <CellValueDialog
          viewer={cellValueViewer}
          onCopy={() => void copyCellViewerValue(cellValueViewer)}
          onClose={() => setCellValueViewer(null)}
        />
      )}
      {openColumnFilter && openFilterColumn && (
        <div
          ref={columnFilterPopoverRef}
          className="fixed z-[10000] w-[280px] rounded shadow-xl p-2 text-[12px]"
          style={{
            left: openColumnFilter.left,
            top: openColumnFilter.top,
            background: "var(--taomni-panel-bg)",
            border: "1px solid var(--taomni-divider)",
            color: "var(--taomni-text)",
          }}
          onMouseDown={(event) => event.stopPropagation()}
        >
          <div className="mb-2 flex items-center gap-2">
            <Filter className="w-3.5 h-3.5 text-[var(--taomni-accent)]" />
            <div className="min-w-0 flex-1 truncate font-semibold" title={openFilterColumn.name}>
              {openFilterColumn.name}
            </div>
            <button
              type="button"
              className="h-6 w-6 inline-flex items-center justify-center rounded hover:bg-[var(--taomni-hover)]"
              title="Clear column filter"
              aria-label={`Clear filter for ${openFilterColumn.name}`}
              onClick={() => setDraftColumnFilter(DEFAULT_COLUMN_FILTER)}
            >
              <Ban className="w-3.5 h-3.5" />
            </button>
          </div>
          <input
            autoFocus
            value={openFilterConfig.text}
            onChange={(event) => updateDraftColumnFilter({ text: event.target.value })}
            onKeyDown={(event) => {
              if (event.key === "Enter") applyLocalColumnFilter();
              if (event.key === "Escape") setOpenColumnFilter(null);
            }}
            className="taomni-input h-7 w-full text-[12px]"
            placeholder="Filter this column"
            aria-label={`Filter ${openFilterColumn.name}`}
          />
          <div className="mt-2 grid grid-cols-2 gap-1">
            <button
              type="button"
              className="taomni-btn h-7"
              style={filterModeButtonStyle(openFilterConfig.mode === "fuzzy")}
              onClick={() => updateDraftColumnFilter({ mode: "fuzzy" })}
            >
              Fuzzy
            </button>
            <button
              type="button"
              className="taomni-btn h-7"
              style={filterModeButtonStyle(openFilterConfig.mode === "exact")}
              onClick={() => updateDraftColumnFilter({ mode: "exact" })}
            >
              Exact
            </button>
          </div>
          <div className="mt-3 flex items-center justify-between gap-2 text-[11px] text-[var(--taomni-text-muted)]">
            <span>Distinct values</span>
            <span className="shrink-0">
              {openFilterConfig.selectedValues.length > 0
                ? `${openFilterConfig.selectedValues.length} selected`
                : `${openFilterDistinctValues.total} distinct`}
            </span>
          </div>
          <div
            className="mt-1 max-h-[154px] overflow-auto rounded taomni-scroll-y"
            style={{ border: "1px solid var(--taomni-divider)", background: "var(--taomni-bg)" }}
          >
            {openFilterDistinctValues.values.length === 0 ? (
              <div className="px-2 py-3 text-center text-[11px] text-[var(--taomni-text-muted)]">
                No values
              </div>
            ) : (
              openFilterDistinctValues.values.map((item) => (
                <label
                  key={item.key}
                  className="flex h-7 items-center gap-2 px-2 text-[11px] hover:bg-[var(--taomni-hover)]"
                  title={item.value === null ? "NULL" : item.value}
                >
                  <input
                    type="checkbox"
                    className="h-3 w-3 shrink-0"
                    checked={openFilterSelectedKeys.has(item.key)}
                    onChange={() => toggleDraftColumnFilterValue(item.value)}
                    aria-label={`Select ${item.label} for ${openFilterColumn.name}`}
                  />
                  <span className="min-w-0 flex-1 truncate font-mono">{item.label}</span>
                  <span className="shrink-0 text-[var(--taomni-text-muted)]">{item.count}</span>
                </label>
              ))
            )}
          </div>
          {openFilterDistinctValues.truncated && (
            <div className="mt-1 text-[10px] text-[var(--taomni-text-muted)]">
              Showing first {DISTINCT_FILTER_VALUE_LIMIT} values
            </div>
          )}
          <div className="mt-2 flex items-center justify-end gap-1">
            <button type="button" className="taomni-btn h-7 px-2" onClick={() => setOpenColumnFilter(null)}>
              Close
            </button>
            <button type="button" className="taomni-btn h-7 px-2" onClick={() => setDraftColumnFilter(DEFAULT_COLUMN_FILTER)}>
              Clear
            </button>
            <button type="button" className="taomni-btn h-7 px-2" onClick={applyLocalColumnFilter}>
              Local
            </button>
            <button type="button" className="taomni-btn h-7 px-2" data-primary="true" onClick={queryColumnFilter} disabled={running || cancelling}>
              Query
            </button>
          </div>
        </div>
      )}
      {menu}
    </div>
  );
}

function CellValueDialog({
  viewer,
  onCopy,
  onClose,
}: {
  viewer: CellValueViewer;
  onCopy: () => void;
  onClose: () => void;
}) {
  const [wrap, setWrap] = useState(true);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const text = viewer.value ?? "NULL";
  const charCount = viewer.value?.length ?? 0;
  const lineCount = viewer.value == null ? 0 : viewer.value.split(/\r\n|\r|\n/).length;

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  return (
    <div
      className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/45"
      onMouseDown={onClose}
      onKeyDown={(event) => {
        if (event.key === "Escape") onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Full value for ${viewer.column.name}`}
        data-testid="query-cell-value-dialog"
        className="w-[760px] max-w-[92vw] max-h-[86vh] flex flex-col rounded shadow-xl"
        style={{ background: "var(--taomni-bg)", border: "1px solid var(--taomni-card-border)", color: "var(--taomni-text)" }}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="h-10 shrink-0 flex items-center gap-2 px-3" style={{ borderBottom: "1px solid var(--taomni-divider)" }}>
          <FileText className="w-4 h-4 text-[var(--taomni-accent)]" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-[12px] font-semibold" title={viewer.column.name}>
              {viewer.column.name}
            </div>
            <div className="truncate text-[10px] text-[var(--taomni-text-muted)]">
              Row {viewer.rowNumber} | {viewer.column.type} | {charCount} chars | {lineCount} lines
            </div>
          </div>
          <label className="h-6 inline-flex items-center gap-1 px-1 text-[11px] text-[var(--taomni-text-muted)]">
            <input
              data-testid="query-cell-value-wrap"
              type="checkbox"
              checked={wrap}
              onChange={(event) => setWrap(event.target.checked)}
            />
            Wrap
          </label>
          <button
            type="button"
            data-testid="query-cell-value-copy"
            className="h-6 px-2 inline-flex items-center gap-1 rounded text-[11px] hover:bg-[var(--taomni-hover)]"
            title="Copy full value"
            onClick={onCopy}
          >
            <Copy className="w-3.5 h-3.5" /> Copy
          </button>
          <button
            type="button"
            className="h-6 w-6 inline-flex items-center justify-center rounded hover:bg-[var(--taomni-hover)]"
            aria-label="Close full value"
            onClick={onClose}
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
        <textarea
          ref={textareaRef}
          data-testid="query-cell-value-text"
          className={`m-3 min-h-[280px] max-h-[calc(86vh-96px)] flex-1 resize-none rounded p-2 text-[12px] font-mono ${
            wrap ? "whitespace-pre-wrap" : "whitespace-pre"
          }`}
          style={{
            background: "var(--taomni-panel-bg)",
            border: "1px solid var(--taomni-divider)",
            color: viewer.value == null ? "var(--taomni-text-muted)" : "var(--taomni-text)",
            overflow: "auto",
          }}
          wrap={wrap ? "soft" : "off"}
          readOnly
          value={text}
        />
      </div>
    </div>
  );
}

function ToolButton({
  title,
  icon,
  suffix,
  disabled,
  active,
  onClick,
}: {
  title: string;
  icon: ReactNode;
  suffix?: ReactNode;
  disabled?: boolean;
  active?: boolean;
  onClick?: (event: MouseEvent<HTMLButtonElement>) => void;
}) {
  return (
    <button
      type="button"
      className={`h-6 ${suffix ? "px-1.5" : "w-6"} inline-flex items-center justify-center gap-0.5 rounded text-[11px] hover:bg-[var(--taomni-hover)] disabled:opacity-40`}
      style={active ? { background: "var(--taomni-selected)", color: "var(--taomni-accent)" } : undefined}
      title={title}
      aria-label={title}
      disabled={disabled}
      onClick={onClick}
    >
      {icon}
      {suffix}
    </button>
  );
}

function Divider() {
  return <span className="w-px h-4 mx-0.5" style={{ background: "var(--taomni-divider)" }} />;
}

function StatsCell({ children, header = false }: { children: ReactNode; header?: boolean }) {
  return (
    <div
      className={`px-2 py-1 truncate ${header ? "font-semibold text-[var(--taomni-text)]" : "text-[var(--taomni-text-muted)]"}`}
      style={{ borderRight: "1px solid var(--taomni-divider)", borderBottom: "1px solid var(--taomni-divider)" }}
      title={typeof children === "string" ? children : undefined}
    >
      {children}
    </div>
  );
}

function FragmentStats({
  stat,
}: {
  stat: {
    column: DbColumn;
    count: number;
    nulls: number;
    distinct: number;
    min: string | number;
    max: string | number;
    avg: number | null;
  };
}) {
  return (
    <>
      <StatsCell>{stat.column.name}</StatsCell>
      <StatsCell>{stat.count}</StatsCell>
      <StatsCell>{stat.nulls}</StatsCell>
      <StatsCell>{stat.distinct}</StatsCell>
      <StatsCell>{String(stat.min)}</StatsCell>
      <StatsCell>{String(stat.max)}</StatsCell>
      <StatsCell>{stat.avg === null ? "" : stat.avg.toFixed(3)}</StatsCell>
    </>
  );
}

function extensionForOptions(options: ExportOptions): string {
  if (options.outputFormat === "excel") return options.excelFileFormat;
  return options.outputFormat === "csv"
    ? "csv"
    : options.outputFormat === "html"
      ? "html"
      : options.outputFormat === "txt"
        ? "txt"
        : options.outputFormat === "sql"
          ? "sql"
          : options.outputFormat === "xml"
            ? "xml"
            : "json";
}

function ExportDialog({
  options,
  columns,
  target,
  rowCount,
  totalRows,
  onOptionsChange,
  onColumnsChange,
  onClose,
  onExport,
}: {
  options: ExportOptions;
  columns: ExportColumnConfig[];
  target: ExportTarget;
  rowCount: number;
  totalRows: number;
  onOptionsChange: (options: ExportOptions) => void;
  onColumnsChange: (columns: ExportColumnConfig[]) => void;
  onClose: () => void;
  onExport: (options: ExportOptions, columns: ExportColumnConfig[], destination: ExportDestination) => void;
}) {
  const [step, setStep] = useState(0);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [fileHistory, setFileHistory] = useState<string[]>(() => readExportFileHistory());
  const [destination, setDestination] = useState<ExportDestination>({
    kind: "file",
    filePath: "",
    sqlCommanderTabId: "active",
    sqlCommanderPosition: "caret",
  });
  const queryTabs = listQueryTabs();
  const input = "taomni-input h-7 text-[12px]";
  const label = "flex flex-col gap-1 text-[11px] text-[var(--taomni-text-muted)]";
  const sectionTitle = "mb-2 text-[12px] font-semibold";
  const update = <K extends keyof ExportOptions>(key: K, value: ExportOptions[K]) => {
    onOptionsChange({ ...options, [key]: value });
  };
  const updateColumn = (id: string, patch: Partial<ExportColumnConfig>) => {
    onColumnsChange(columns.map((column) => (column.id === id ? { ...column, ...patch } : column)));
  };
  const moveColumn = (id: string, direction: -1 | 1) => {
    const index = columns.findIndex((column) => column.id === id);
    const nextIndex = index + direction;
    if (index < 0 || nextIndex < 0 || nextIndex >= columns.length) return;
    const next = [...columns];
    const [item] = next.splice(index, 1);
    next.splice(nextIndex, 0, item);
    onColumnsChange(next);
  };
  const chooseFilePath = async () => {
    const path = await selectSaveFilePath(`query-results.${extensionForOptions(options)}`, destination.filePath || undefined);
    if (!path) return;
    setDestination((current) => ({ ...current, kind: "file", filePath: path }));
    const nextHistory = [path, ...fileHistory.filter((entry) => entry !== path)].slice(0, 12);
    setFileHistory(nextHistory);
    writeExportFileHistory(nextHistory);
  };
  const settingsPayload = () => JSON.stringify({ options, columns }, null, 2);
  const saveDefaultSettings = () => {
    localStorage.setItem(EXPORT_DEFAULTS_KEY, JSON.stringify(options));
    setSettingsOpen(false);
  };
  const useDefaultSettings = () => {
    onOptionsChange(readStoredExportOptions());
    setSettingsOpen(false);
  };
  const removeDefaultSettings = () => {
    localStorage.removeItem(EXPORT_DEFAULTS_KEY);
    onOptionsChange(DEFAULT_EXPORT_OPTIONS);
    setSettingsOpen(false);
  };
  const loadSettings = async () => {
    const path = await selectFilePath();
    if (!path) return;
    const text = new TextDecoder().decode(await readFileBytes(path));
    const parsed = JSON.parse(text) as { options?: Partial<ExportOptions>; columns?: ExportColumnConfig[] };
    onOptionsChange({ ...DEFAULT_EXPORT_OPTIONS, ...(parsed.options ?? {}) });
    if (Array.isArray(parsed.columns)) onColumnsChange(parsed.columns);
    setSettingsOpen(false);
  };
  const saveSettingsAs = async () => {
    const path = await selectSaveFilePath("export-grid-settings.json");
    if (!path) return;
    await writeBytesToPath(path, new TextEncoder().encode(settingsPayload()));
    setSettingsOpen(false);
  };
  const copySettings = async () => {
    await writeText(settingsPayload());
    setSettingsOpen(false);
  };
  const bool = (key: keyof ExportOptions, text: string) => (
    <label className="h-7 inline-flex items-center gap-2 text-[11px] text-[var(--taomni-text-muted)]">
      <input type="checkbox" checked={Boolean(options[key])} onChange={(event) => update(key as never, event.target.checked as never)} />
      {text}
    </label>
  );
  const formatOptionFields = () => {
    if (options.outputFormat === "csv") {
      return (
        <div className="grid grid-cols-4 gap-2">
          <label className={label}>Column Delimiter<select className={input} value={options.columnDelimiter} onChange={(event) => update("columnDelimiter", event.target.value)}><option value={"\t"}>TAB</option><option value=",">Comma (,)</option><option value=";">Semicolon (;)</option><option value="|">Pipe (|)</option></select></label>
          <label className={label}>Row Delimiter<select className={input} value={options.rowDelimiter} onChange={(event) => update("rowDelimiter", event.target.value as RowDelimiter)}><option value={"\n"}>UNIX LF</option><option value={"\r\n"}>Windows CRLF</option><option value={"\r"}>Mac CR</option></select></label>
          {bool("includeColumnNames", "Include Column Names")}
          {bool("useLabels", "Use any Label (Alias)")}
          {bool("removeNewlines", "Remove Newline Characters")}
          <label className={label}>Include Original SQL<select className={input} value={options.includeOriginalSql} onChange={(event) => update("includeOriginalSql", event.target.value as IncludeOriginalSql)}><option value="none">Don't Include</option><option value="comment">As Comment</option><option value="top">At Top</option></select></label>
          <label className={label}>Row Comment Identifier<input className={input} value={options.rowCommentIdentifier} onChange={(event) => update("rowCommentIdentifier", event.target.value)} /></label>
        </div>
      );
    }
    if (options.outputFormat === "html") {
      return (
        <div className="grid grid-cols-4 gap-2">
          <label className={label}>Title<input className={input} value={options.htmlTitle} onChange={(event) => update("htmlTitle", event.target.value)} /></label>
          <label className={`${label} col-span-2`}>Description<input className={input} value={options.htmlDescription} onChange={(event) => update("htmlDescription", event.target.value)} /></label>
          <label className={label}>Footer<input className={input} value={options.htmlFooter} onChange={(event) => update("htmlFooter", event.target.value)} /></label>
          <label className={`${label} col-span-2`}>Per Table Header<input className={input} value={options.htmlPerTableHeader} onChange={(event) => update("htmlPerTableHeader", event.target.value)} /></label>
          {bool("htmlConvertCharacters", "Convert HTML characters")}
          {bool("useLabels", "Use any Label (Alias)")}
          <label className={label}>Include Original SQL<select className={input} value={options.includeOriginalSql} onChange={(event) => update("includeOriginalSql", event.target.value as IncludeOriginalSql)}><option value="none">Don't Include</option><option value="comment">As Comment</option><option value="top">At Top</option></select></label>
        </div>
      );
    }
    if (options.outputFormat === "txt") {
      return (
        <div className="grid grid-cols-4 gap-2">
          <label className={label}>Spaces Between Columns<input className={input} type="number" min={1} value={options.txtSpacesBetweenColumns} onChange={(event) => update("txtSpacesBetweenColumns", Math.max(1, Number(event.target.value) || 1))} /></label>
          <label className={label}>Row Delimiter<select className={input} value={options.rowDelimiter} onChange={(event) => update("rowDelimiter", event.target.value as RowDelimiter)}><option value={"\n"}>UNIX LF</option><option value={"\r\n"}>Windows CRLF</option><option value={"\r"}>Mac CR</option></select></label>
          {bool("includeColumnNames", "Include Column Names")}
          {bool("useLabels", "Use any Label (Alias)")}
          {bool("removeNewlines", "Remove Newline Characters")}
          <label className={label}>Include Original SQL<select className={input} value={options.includeOriginalSql} onChange={(event) => update("includeOriginalSql", event.target.value as IncludeOriginalSql)}><option value="none">Don't Include</option><option value="comment">As Comment</option><option value="top">At Top</option></select></label>
        </div>
      );
    }
    if (options.outputFormat === "sql") {
      return (
        <div className="grid grid-cols-4 gap-2">
          {bool("sqlUseQualifier", "Use Qualifier")}
          <label className={label}>Qualifier<input className={input} value={options.sqlQualifier} onChange={(event) => update("sqlQualifier", event.target.value)} /></label>
          <label className={label}>Table Name<input className={input} value={options.sqlTableName} onChange={(event) => update("sqlTableName", event.target.value)} /></label>
          <label className={label}>Delimiters<select className={input} value={options.sqlDelimiterMode} onChange={(event) => update("sqlDelimiterMode", event.target.value as SqlDelimiterMode)}><option value="none">None</option><option value="double">Double Quote</option><option value="backtick">Backtick</option><option value="bracket">Bracket</option></select></label>
          <label className={label}>Statement Separator<input className={input} value={options.sqlStatementSeparator} onChange={(event) => update("sqlStatementSeparator", event.target.value)} /></label>
          {bool("sqlIncludeBasicDdl", "Include Basic DDL")}
          <label className={label}>Include Original SQL<select className={input} value={options.includeOriginalSql} onChange={(event) => update("includeOriginalSql", event.target.value as IncludeOriginalSql)}><option value="none">Don't Include</option><option value="comment">As Comment</option><option value="top">At Top</option></select></label>
          <label className={label}>Row Comment Identifier<input className={input} value={options.rowCommentIdentifier} onChange={(event) => update("rowCommentIdentifier", event.target.value)} /></label>
          <label className={label}>Add Before<input className={input} value={options.sqlAddBefore} onChange={(event) => update("sqlAddBefore", event.target.value)} /></label>
          <label className={label}>Add After<input className={input} value={options.sqlAddAfter} onChange={(event) => update("sqlAddAfter", event.target.value)} /></label>
          {bool("sqlGenerateMultiRow", "Generate Multi-Row INSERT statements")}
          <label className={label}>Rows per Multi-Row INSERT<input className={input} type="number" min={1} value={options.sqlRowsPerMultiRow} onChange={(event) => update("sqlRowsPerMultiRow", Math.max(1, Number(event.target.value) || 1))} /></label>
          <label className={label}>Type<select className={input} value={options.sqlMultiRowType} onChange={(event) => update("sqlMultiRowType", event.target.value as ExportOptions["sqlMultiRowType"])}><option value="multi-insert-sql92">multi-insert-sql92</option></select></label>
          {bool("sqlGenerateMerge", "Generate MERGE statements")}
          <label className={label}>Merge Type<select className={input} value={options.sqlMergeType} onChange={(event) => update("sqlMergeType", event.target.value as ExportOptions["sqlMergeType"])}><option value="single-merge-sql92">single-merge-sql92</option></select></label>
          <label className={`${label} col-span-2`}>The columns to use when matching rows<input className={input} value={options.sqlMergeMatchColumns} onChange={(event) => update("sqlMergeMatchColumns", event.target.value)} /></label>
        </div>
      );
    }
    if (options.outputFormat === "xml") {
      return (
        <div className="grid grid-cols-4 gap-2">
          <label className={label}>XML Style<select className={input} value={options.xmlStyle} onChange={(event) => update("xmlStyle", event.target.value as ExportOptions["xmlStyle"])}><option value="dbvis">DbVisualizer</option><option value="flat">Flat Elements</option></select></label>
          <label className={`${label} col-span-2`}>Description<input className={input} value={options.xmlDescription} onChange={(event) => update("xmlDescription", event.target.value)} /></label>
          <label className={label}>Include Original SQL<select className={input} value={options.includeOriginalSql} onChange={(event) => update("includeOriginalSql", event.target.value as IncludeOriginalSql)}><option value="none">Don't Include</option><option value="comment">As Comment</option><option value="top">At Top</option></select></label>
          {bool("useLabels", "Use any Label (Alias)")}
        </div>
      );
    }
    if (options.outputFormat === "excel") {
      return (
        <div className="grid grid-cols-4 gap-2">
          <label className={label}>File Format<select className={input} value={options.excelFileFormat} onChange={(event) => update("excelFileFormat", event.target.value as ExportOptions["excelFileFormat"])}><option value="xlsx">XLSX</option><option value="xls">XLS</option></select></label>
          <label className={label}>Title<input className={input} value={options.excelTitle} onChange={(event) => update("excelTitle", event.target.value)} /></label>
          <label className={label}>Description<input className={input} value={options.excelDescription} onChange={(event) => update("excelDescription", event.target.value)} /></label>
          <label className={label}>Sheet Name<input className={input} value={options.excelSheetName} onChange={(event) => update("excelSheetName", event.target.value)} /></label>
          {bool("includeColumnNames", "Include Column Names")}
          {bool("useLabels", "Use any Label (Alias)")}
          {bool("excelExportNumberAsText", "Export Number as Text")}
          {bool("excelExportDateTimeAsText", "Export Date/Time as Text")}
          {bool("excelAutoResizeColumns", "Auto Resize Columns")}
          <label className={label}>Include Original SQL<select className={input} value={options.includeOriginalSql} onChange={(event) => update("includeOriginalSql", event.target.value as IncludeOriginalSql)}><option value="none">None</option><option value="comment">As Comment</option><option value="top">At Top</option></select></label>
        </div>
      );
    }
    return (
      <div className="grid grid-cols-4 gap-2">
        <label className={label}>JSON Style<select className={input} value={options.jsonStyle} onChange={(event) => update("jsonStyle", event.target.value as ExportOptions["jsonStyle"])}><option value="array">Array</option><option value="object">Object with rows</option></select></label>
        {bool("useLabels", "Use any Label (Alias)")}
      </div>
    );
  };

  return (
    <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/45" onMouseDown={onClose}>
      <div
        className="w-[920px] max-w-[calc(100vw-24px)] h-[min(760px,calc(100vh-24px))] flex flex-col rounded shadow-xl"
        style={{ background: "var(--taomni-panel-bg)", border: "1px solid var(--taomni-divider)", color: "var(--taomni-text)" }}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="h-11 flex items-center gap-2 px-3" style={{ borderBottom: "1px solid var(--taomni-divider)", background: "var(--taomni-quick-bg)" }}>
          <Download className="w-4 h-4" />
          <div className="font-semibold text-[13px]">Export Grid</div>
          <div className="ml-3 flex items-center gap-1 text-[11px]">
            {["Format", "Columns", "Output"].map((name, index) => (
              <button key={name} type="button" className="h-6 px-2 rounded" style={{ background: step === index ? "var(--taomni-selected)" : "transparent", color: step === index ? "var(--taomni-accent)" : "var(--taomni-text-muted)" }} onClick={() => setStep(index)}>{index + 1}. {name}</button>
            ))}
          </div>
          <div className="ml-auto text-[11px] text-[var(--taomni-text-muted)]">{target === "selection" ? "Selection" : "All visible rows"}: {rowCount} / Total Rows in Grid: {totalRows}</div>
        </div>

        <div className="flex-1 min-h-0 overflow-auto taomni-scroll-y p-3">
          {step === 0 && (
            <div className="space-y-3">
              <section>
                <div className={sectionTitle}>Output Format</div>
                <div className="grid grid-cols-4 gap-2">
                  <label className={label}>Output Format<select className={input} value={options.outputFormat} onChange={(event) => update("outputFormat", event.target.value as OutputFormat)}><option value="csv">CSV</option><option value="html">HTML</option><option value="txt">TXT</option><option value="sql">SQL</option><option value="xml">XML</option><option value="excel">Excel</option><option value="json">JSON</option></select></label>
                  <label className={label}>Encoding<select className={input} value={options.encoding} onChange={(event) => update("encoding", event.target.value as Encoding)}><option value="utf-8">UTF-8</option><option value="utf-8-bom">UTF-8 BOM</option><option value="utf-16le">UTF-16 LE</option></select></label>
                  <label className={label}>Max Rows<input className={input} type="number" min={0} value={options.maxRows} onChange={(event) => update("maxRows", Math.max(0, Number(event.target.value) || 0))} /></label>
                </div>
              </section>
              <section>
                <div className={sectionTitle}>Data Format</div>
                <div className="grid grid-cols-4 gap-2">
                  <label className={label}>Date<input className={input} value={options.dateFormat} onChange={(event) => update("dateFormat", event.target.value)} /></label>
                  <label className={label}>Time<input className={input} value={options.timeFormat} onChange={(event) => update("timeFormat", event.target.value)} /></label>
                  <label className={label}>Timestamp<input className={input} value={options.timestampFormat} onChange={(event) => update("timestampFormat", event.target.value)} /></label>
                  <label className={label}>Text Function<select className={input} value={options.textFunction} onChange={(event) => update("textFunction", event.target.value as TextFunction)}><option value="none">None</option><option value="upper">Upper case</option><option value="lower">Lower case</option><option value="trim">Trim</option></select></label>
                  <label className={label}>Number<select className={input} value={options.numberFormat} onChange={(event) => update("numberFormat", event.target.value as ExportOptions["numberFormat"])}><option value="unformatted">Unformatted</option><option value="grouped">Custom separators</option></select></label>
                  <label className={label}>Decimal Number<select className={input} value={options.decimalFormat} onChange={(event) => update("decimalFormat", event.target.value as ExportOptions["decimalFormat"])}><option value="unformatted">Unformatted</option><option value="grouped">Custom separators</option></select></label>
                  <label className={label}>Grouping Separator<input className={input} value={options.groupSeparator} onChange={(event) => update("groupSeparator", event.target.value)} /></label>
                  <label className={label}>Decimal Separator<input className={input} value={options.decimalSeparator} onChange={(event) => update("decimalSeparator", event.target.value)} /></label>
                  <label className={label}>Boolean True<input className={input} value={options.booleanTrueText} onChange={(event) => update("booleanTrueText", event.target.value)} /></label>
                  <label className={label}>Boolean False<input className={input} value={options.booleanFalseText} onChange={(event) => update("booleanFalseText", event.target.value)} /></label>
                  <label className={label}>Binary/BLOB<select className={input} value={options.binaryMode} onChange={(event) => update("binaryMode", event.target.value as ExportOptions["binaryMode"])}><option value="dont">Don't Export</option><option value="text">Export Text</option><option value="length">Length Text</option></select></label>
                  <label className={label}>CLOB<select className={input} value={options.clobMode} onChange={(event) => update("clobMode", event.target.value as ExportOptions["clobMode"])}><option value="dont">Don't Export</option><option value="text">Export Text</option></select></label>
                  <label className={label}>Null Value Text<input className={input} value={options.nullValueText} onChange={(event) => update("nullValueText", event.target.value)} /></label>
                  <label className={label}>Quote Text Value<select className={input} value={options.quoteTextValue} onChange={(event) => update("quoteTextValue", event.target.value as QuoteMode)}><option value="single">Single</option><option value="double">Double</option><option value="none">None</option></select></label>
                  {bool("duplicateEmbedded", "Duplicate Embedded")}
                  {bool("quoteAllValues", "Quote All Values")}
                </div>
              </section>
              <section>
                <div className={sectionTitle}>Options</div>
                {formatOptionFields()}
              </section>
            </div>
          )}

          {step === 1 && (
            <div className="h-full min-h-[420px] grid grid-cols-[1fr_150px] gap-3">
              <div className="min-w-0 overflow-auto taomni-scroll-y" style={{ border: "1px solid var(--taomni-divider)" }}>
                <div className="min-w-[860px] grid grid-cols-[54px_160px_180px_120px_70px_130px_1fr] text-[11px]" style={{ borderBottom: "1px solid var(--taomni-divider)" }}>
                  {["Export", "Name", "Label (Alias)", "Type", "Is Text", "Text Function", "Value"].map((head) => <div key={head} className="px-2 py-1 font-semibold" style={{ borderRight: "1px solid var(--taomni-divider)" }}>{head}</div>)}
                  {columns.map((column) => (
                    <div key={column.id} className="contents">
                      <label className="px-2 py-1"><input type="checkbox" checked={column.export} onChange={(event) => updateColumn(column.id, { export: event.target.checked })} /></label>
                      <div className="px-2 py-1 truncate">{column.name}</div>
                      <div className="px-1 py-1"><input className="taomni-input h-6 w-full text-[11px]" value={column.label} onChange={(event) => updateColumn(column.id, { label: event.target.value })} /></div>
                      <div className="px-2 py-1 truncate">{column.type}</div>
                      <label className="px-2 py-1"><input type="checkbox" checked={column.isText} onChange={(event) => updateColumn(column.id, { isText: event.target.checked })} /></label>
                      <div className="px-1 py-1"><select className="taomni-input h-6 w-full text-[11px]" value={column.textFunction} onChange={(event) => updateColumn(column.id, { textFunction: event.target.value as TextFunction })}><option value="none">None</option><option value="upper">Upper case</option><option value="lower">Lower case</option><option value="trim">Trim</option></select></div>
                      <div className="px-1 py-1"><input className="taomni-input h-6 w-full text-[11px]" value={column.valueTemplate} onChange={(event) => updateColumn(column.id, { valueTemplate: event.target.value })} /></div>
                    </div>
                  ))}
                </div>
              </div>
              <div className="space-y-2">
                <button type="button" className="taomni-btn w-full" onClick={() => onColumnsChange([...columns, { id: nextRowId("export-col"), export: true, name: `custom_${columns.length + 1}`, label: `custom_${columns.length + 1}`, type: "String", isText: true, textFunction: "none", valueTemplate: "" }])}>+ Add Column</button>
                <button type="button" className="taomni-btn w-full" onClick={() => onColumnsChange(columns.map((column) => ({ ...column, export: true })))}>Select All</button>
                <button type="button" className="taomni-btn w-full" onClick={() => onColumnsChange(columns.map((column) => ({ ...column, export: false })))}>Select None</button>
                {columns.map((column) => (
                  <div key={column.id} className="flex gap-1">
                    <button type="button" className="taomni-btn flex-1 truncate" onClick={() => moveColumn(column.id, -1)}>Up</button>
                    <button type="button" className="taomni-btn flex-1 truncate" onClick={() => moveColumn(column.id, 1)}>Down</button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {step === 2 && (
            <div className="space-y-3 text-[12px]">
              <label className="flex items-center gap-2"><input type="radio" checked={destination.kind === "file"} onChange={() => setDestination((current) => ({ ...current, kind: "file" }))} />File</label>
              {destination.kind === "file" && (
                <div className="grid grid-cols-[1fr_130px] gap-2">
                  <input className={input} value={destination.filePath} onChange={(event) => setDestination((current) => ({ ...current, filePath: event.target.value }))} placeholder="Output file path" />
                  <button type="button" className="taomni-btn inline-flex items-center justify-center gap-1" onClick={() => void chooseFilePath()}><FolderOpen className="w-3.5 h-3.5" />Browse</button>
                  <select className={`${input} col-span-2`} value="" onChange={(event) => event.target.value && setDestination((current) => ({ ...current, filePath: event.target.value }))}>
                    <option value="">History</option>
                    {fileHistory.map((path) => <option key={path} value={path}>{path}</option>)}
                  </select>
                </div>
              )}
              <label className="flex items-center gap-2"><input type="radio" checked={destination.kind === "sqlCommander"} onChange={() => setDestination((current) => ({ ...current, kind: "sqlCommander" }))} />SQL Commander</label>
              {destination.kind === "sqlCommander" && (
                <div className="grid grid-cols-2 gap-2">
                  <label className={label}>Editor<select className={input} value={destination.sqlCommanderTabId} onChange={(event) => setDestination((current) => ({ ...current, sqlCommanderTabId: event.target.value }))}><option value="new">New Editor</option><option value="active">Active Editor</option>{queryTabs.map((tab) => <option key={tab.tabId} value={tab.tabId}>{tab.title}</option>)}</select></label>
                  <label className={label}>Insert Position<select className={input} value={destination.sqlCommanderPosition} onChange={(event) => setDestination((current) => ({ ...current, sqlCommanderPosition: event.target.value as SqlCommanderPosition }))}><option value="caret">At Caret</option><option value="first">First</option><option value="last">Last</option><option value="replaceAll">Replace All</option></select></label>
                </div>
              )}
              <label className="flex items-center gap-2"><input type="radio" checked={destination.kind === "clipboard"} onChange={() => setDestination((current) => ({ ...current, kind: "clipboard" }))} />Clipboard</label>
            </div>
          )}
        </div>

        <div className="relative h-11 flex items-center gap-2 px-3" style={{ borderTop: "1px solid var(--taomni-divider)", background: "var(--taomni-quick-bg)" }}>
          <button type="button" className="taomni-btn inline-flex items-center gap-1" onClick={() => setSettingsOpen((value) => !value)}><FileText className="w-3.5 h-3.5" />Settings</button>
          {settingsOpen && (
            <div className="absolute left-3 bottom-10 z-10 min-w-[230px] rounded shadow-lg p-1 text-[12px]" style={{ background: "var(--taomni-panel-bg)", border: "1px solid var(--taomni-divider)" }}>
              <button type="button" className="block w-full text-left px-2 py-1 hover:bg-[var(--taomni-hover)]" onClick={saveDefaultSettings}>Save As Default Settings</button>
              <button type="button" className="block w-full text-left px-2 py-1 hover:bg-[var(--taomni-hover)]" onClick={useDefaultSettings}>Use Default Settings</button>
              <button type="button" className="block w-full text-left px-2 py-1 hover:bg-[var(--taomni-hover)]" onClick={removeDefaultSettings}>Remove Default Settings</button>
              <div className="my-1 h-px" style={{ background: "var(--taomni-divider)" }} />
              <button type="button" className="block w-full text-left px-2 py-1 hover:bg-[var(--taomni-hover)]" onClick={() => void loadSettings()}>Load...</button>
              <button type="button" className="block w-full text-left px-2 py-1 hover:bg-[var(--taomni-hover)]" onClick={() => void saveSettingsAs()}>Save As...</button>
              <button type="button" className="block w-full text-left px-2 py-1 hover:bg-[var(--taomni-hover)]" onClick={() => void copySettings()}>Copy Settings to Clipboard</button>
            </div>
          )}
          <div className="flex-1" />
          <button type="button" className="taomni-btn inline-flex items-center gap-1" disabled={step === 0} onClick={() => setStep((value) => Math.max(0, value - 1))}><ArrowLeft className="w-3.5 h-3.5" />Back</button>
          {step < 2 ? (
            <button type="button" className="taomni-btn inline-flex items-center gap-1" data-primary="true" onClick={() => setStep((value) => Math.min(2, value + 1))}>Next<ArrowRight className="w-3.5 h-3.5" /></button>
          ) : (
            <button type="button" className="taomni-btn inline-flex items-center gap-1" data-primary="true" onClick={() => onExport(options, columns, destination)}><Check className="w-3.5 h-3.5" />Export</button>
          )}
          <button type="button" className="taomni-btn" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}
