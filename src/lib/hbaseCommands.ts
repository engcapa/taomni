/**
 * Shared HBase shell command model.
 *
 * Single source of truth for: classifying a statement (read vs write, and
 * whether it is destructive), the command catalogue shown in the help palette,
 * per-transport capability gating, statement builders used by the object tree
 * and quick actions, and the adapter that turns an `HBaseShellResult` into the
 * `DbQueryResult` shape consumed by the shared `QueryResultGrid`.
 *
 * Keep the verb sets here aligned with the backend parser in
 * `src-tauri/src/hbase/mod.rs` (`parse_shell_command`).
 */
import type { DbQueryResult, HBaseShellResult } from "./ipc";

/** Mirrors `HBaseConnectInfo["connectionMode"]`. */
export type HBaseTransport = "rest" | "native" | "thrift";

export type HBaseCommandCategory = "meta" | "read" | "ddl" | "dml";

export interface HBaseCommandSpec {
  verb: string;
  category: HBaseCommandCategory;
  /** Canonical syntax with placeholders. */
  syntax: string;
  /** A ready-to-edit example. */
  example: string;
  /** One-line description. */
  description: string;
  /** Mutates cluster/data — always confirmed before execution. */
  isWrite: boolean;
  /** Irreversible / data-losing — confirmation is styled as danger. */
  destructive: boolean;
  /** Transports that can run this command. */
  transports: HBaseTransport[];
}

const ALL: HBaseTransport[] = ["rest", "native", "thrift"];
/** Admin ops the REST/Stargate transport cannot perform. */
const ADMIN_ONLY: HBaseTransport[] = ["native", "thrift"];

/**
 * The command catalogue. Order is the palette display order, grouped by
 * category. Verbs and transports must match the backend.
 */
export const HBASE_COMMANDS: HBaseCommandSpec[] = [
  // --- meta ---
  { verb: "help", category: "meta", syntax: "help", example: "help", description: "List supported shell commands.", isWrite: false, destructive: false, transports: ALL },
  { verb: "status", category: "meta", syntax: "status", example: "status", description: "Show cluster status.", isWrite: false, destructive: false, transports: ALL },
  { verb: "version", category: "meta", syntax: "version", example: "version", description: "Show cluster version.", isWrite: false, destructive: false, transports: ALL },
  // --- read ---
  { verb: "list", category: "read", syntax: "list", example: "list", description: "List tables.", isWrite: false, destructive: false, transports: ALL },
  { verb: "describe", category: "read", syntax: "describe 'table'", example: "describe 'table_name'", description: "Show a table's column families and attributes.", isWrite: false, destructive: false, transports: ALL },
  { verb: "scan", category: "read", syntax: "scan 'table', {LIMIT => 10, STARTROW => 'r1', COLUMNS => ['cf:q']}", example: "scan 'table_name', {LIMIT => 10}", description: "Scan rows from a table.", isWrite: false, destructive: false, transports: ALL },
  { verb: "get", category: "read", syntax: "get 'table', 'row', {COLUMN => 'cf:q'}", example: "get 'table_name', 'row_id'", description: "Get a single row.", isWrite: false, destructive: false, transports: ALL },
  { verb: "count", category: "read", syntax: "count 'table'", example: "count 'table_name'", description: "Count the rows in a table.", isWrite: false, destructive: false, transports: ALL },
  { verb: "exists", category: "read", syntax: "exists 'table'", example: "exists 'table_name'", description: "Check whether a table exists.", isWrite: false, destructive: false, transports: ALL },
  // --- ddl ---
  { verb: "create", category: "ddl", syntax: "create 'table', 'cf1', {NAME => 'cf2', VERSIONS => 3}", example: "create 'table_name', 'cf1'", description: "Create a table with one or more column families.", isWrite: true, destructive: false, transports: ALL },
  { verb: "alter", category: "ddl", syntax: "alter 'table', {NAME => 'cf', VERSIONS => 5}", example: "alter 'table_name', {NAME => 'cf1', VERSIONS => 5}", description: "Add or modify a column family.", isWrite: true, destructive: false, transports: ADMIN_ONLY },
  { verb: "enable", category: "ddl", syntax: "enable 'table'", example: "enable 'table_name'", description: "Enable a table.", isWrite: true, destructive: false, transports: ADMIN_ONLY },
  { verb: "disable", category: "ddl", syntax: "disable 'table'", example: "disable 'table_name'", description: "Disable a table (required before drop/alter).", isWrite: true, destructive: true, transports: ADMIN_ONLY },
  { verb: "drop", category: "ddl", syntax: "drop 'table'", example: "drop 'table_name'", description: "Drop a table. Cannot be undone.", isWrite: true, destructive: true, transports: ALL },
  // --- dml ---
  { verb: "put", category: "dml", syntax: "put 'table', 'row', 'cf:q', 'value'", example: "put 'table_name', 'row_id', 'cf:q', 'value'", description: "Write a single cell.", isWrite: true, destructive: false, transports: ALL },
  { verb: "delete", category: "dml", syntax: "delete 'table', 'row', 'cf:q'", example: "delete 'table_name', 'row_id', 'cf:q'", description: "Delete a single cell. Cannot be undone.", isWrite: true, destructive: true, transports: ALL },
  { verb: "deleteall", category: "dml", syntax: "deleteall 'table', 'row'", example: "deleteall 'table_name', 'row_id'", description: "Delete an entire row. Cannot be undone.", isWrite: true, destructive: true, transports: ALL },
];

const SPEC_BY_VERB = new Map(HBASE_COMMANDS.map((c) => [c.verb, c]));

/** Write verbs, including ones not in the palette (defensive for typed input). */
const WRITE_VERBS = new Set([
  "create", "drop", "put", "delete", "deleteall", "alter", "enable", "disable", "truncate",
]);
/** Irreversible / data-losing verbs. */
const DESTRUCTIVE_VERBS = new Set(["drop", "delete", "deleteall", "disable", "truncate"]);

/** Extract the leading command verb (lowercased) from a statement. */
export function commandVerb(statement: string): string {
  const trimmed = statement.trim();
  const match = trimmed.match(/^[^\s]+/);
  return match ? match[0].toLowerCase() : "";
}

export interface StatementClassification {
  verb: string;
  isWrite: boolean;
  destructive: boolean;
}

export function classifyStatement(statement: string): StatementClassification {
  const verb = commandVerb(statement);
  return {
    verb,
    isWrite: WRITE_VERBS.has(verb),
    destructive: DESTRUCTIVE_VERBS.has(verb),
  };
}

export function isWriteCommand(statement: string): boolean {
  return WRITE_VERBS.has(commandVerb(statement));
}

export function isDestructiveCommand(statement: string): boolean {
  return DESTRUCTIVE_VERBS.has(commandVerb(statement));
}

/** Whether a verb can run on the given transport. Unknown verbs are allowed. */
export function commandSupported(verb: string, transport: HBaseTransport): boolean {
  const spec = SPEC_BY_VERB.get(verb.toLowerCase());
  return spec ? spec.transports.includes(transport) : true;
}

/** Quote a value as an HBase shell single-quoted literal. */
export function shellQuote(value: string): string {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

// --- statement builders ---------------------------------------------------

export interface ScanOptions {
  limit?: number;
  startRow?: string;
  stopRow?: string;
  columns?: string[];
}

export function scanStatement(table: string, opts: ScanOptions = {}): string {
  const parts: string[] = [];
  if (opts.limit != null) parts.push(`LIMIT => ${opts.limit}`);
  if (opts.startRow) parts.push(`STARTROW => ${shellQuote(opts.startRow)}`);
  if (opts.stopRow) parts.push(`STOPROW => ${shellQuote(opts.stopRow)}`);
  if (opts.columns && opts.columns.length > 0) {
    parts.push(`COLUMNS => [${opts.columns.map(shellQuote).join(", ")}]`);
  }
  const optionMap = parts.length > 0 ? `, {${parts.join(", ")}}` : "";
  return `scan ${shellQuote(table)}${optionMap}`;
}

export function getStatement(table: string, row: string, column?: string): string {
  if (column) return `get ${shellQuote(table)}, ${shellQuote(row)}, ${shellQuote(column)}`;
  return `get ${shellQuote(table)}, ${shellQuote(row)}`;
}

export function putStatement(table: string, row: string, column: string, value: string): string {
  return `put ${shellQuote(table)}, ${shellQuote(row)}, ${shellQuote(column)}, ${shellQuote(value)}`;
}

export function deleteStatement(table: string, row: string, column: string): string {
  return `delete ${shellQuote(table)}, ${shellQuote(row)}, ${shellQuote(column)}`;
}

export function deleteAllStatement(table: string, row: string): string {
  return `deleteall ${shellQuote(table)}, ${shellQuote(row)}`;
}

export function describeStatement(table: string): string {
  return `describe ${shellQuote(table)}`;
}

export function countStatement(table: string): string {
  return `count ${shellQuote(table)}`;
}

export function existsStatement(table: string): string {
  return `exists ${shellQuote(table)}`;
}

export function dropStatement(table: string): string {
  return `drop ${shellQuote(table)}`;
}

export function enableStatement(table: string): string {
  return `enable ${shellQuote(table)}`;
}

export function disableStatement(table: string): string {
  return `disable ${shellQuote(table)}`;
}

/** A `create` template for a new table with one column family. */
export function createTemplate(table = "new_table", family = "cf1"): string {
  return `create ${shellQuote(table)}, ${shellQuote(family)}`;
}

/** An `alter` template adding/modifying a column family on an existing table. */
export function alterTemplate(table: string, family = "cf1"): string {
  return `alter ${shellQuote(table)}, {NAME => ${shellQuote(family)}, VERSIONS => 1}`;
}

// --- result adapter --------------------------------------------------------

/**
 * Convert an `HBaseShellResult` into the `DbQueryResult` shape consumed by the
 * shared `QueryResultGrid`. HBase columns are untyped strings, so every column
 * is reported as `text`.
 */
export function hbaseResultToGrid(result: HBaseShellResult): DbQueryResult {
  return {
    columns: result.columns.map((name) => ({ name, type: "text" })),
    rows: result.rows.map((row) => row.map((cell) => cell ?? null)),
    rowsAffected: 0,
    durationMs: result.durationMs,
    warnings: result.warnings ?? [],
  };
}
