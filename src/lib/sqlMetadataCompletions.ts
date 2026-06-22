import type {
  Completion,
  CompletionContext,
  CompletionResult,
  CompletionSource,
} from "@codemirror/autocomplete";
import type { SQLNamespace } from "@codemirror/lang-sql";
import {
  DB_METADATA_COMPLETION_LIMIT,
  type DbMetadataCache,
  splitSqlQualifiedName,
} from "./dbMetadataCache";
import type { DbColumnDescription, DbTable } from "./ipc";

interface TableRef {
  catalog: string | null;
  schema: string | null;
  table: string;
}

export interface SqlMetadataCompletionOptions {
  cache: DbMetadataCache;
  engine: string;
  activeSchema?: string | null;
  catalog?: string | null;
  maxOptions?: number;
  onError?: (message: string) => void;
}

export interface SqlMetadataNamespaceOptions {
  cache: DbMetadataCache;
  engine: string;
  activeSchema?: string | null;
  catalog?: string | null;
}

const IDENT_PATTERN = String.raw`(?:"(?:[^"]|"")*"|` + "`(?:[^`]|``)*`" + String.raw`|\[[^\]]+\]|[A-Za-z_][\w$]*)`;
const QUALIFIED_PATTERN = `${IDENT_PATTERN}(?:\\s*\\.\\s*${IDENT_PATTERN}){0,2}`;
const WORD_PREFIX_PATTERN = String.raw`[A-Za-z_][\w$]*`;
const DOT_CONTEXT_RE = new RegExp(`(${QUALIFIED_PATTERN})\\.(${WORD_PREFIX_PATTERN})?$`);
const RESERVED_AFTER_RELATION = new Set([
  "on",
  "using",
  "where",
  "join",
  "inner",
  "left",
  "right",
  "full",
  "cross",
  "group",
  "order",
  "having",
  "limit",
  "union",
  "as",
]);

function truthy(value?: string | null): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed ? trimmed : null;
}

function equalsName(a: string | null | undefined, b: string | null | undefined): boolean {
  return (a ?? "").toLowerCase() === (b ?? "").toLowerCase();
}

function unquoteIdent(value: string): string {
  const parts = splitSqlQualifiedName(value);
  return parts[0] ?? value.trim();
}

function currentStatement(doc: string, pos: number): string {
  const before = doc.slice(0, pos);
  const after = doc.slice(pos);
  const start = before.lastIndexOf(";");
  const end = after.indexOf(";");
  return `${start >= 0 ? before.slice(start + 1) : before}${end >= 0 ? after.slice(0, end) : after}`;
}

function stripCommentsAndStrings(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--.*$/gm, " ")
    .replace(/'(?:''|[^'])*'/g, " ");
}

function tableRefFromParts(
  parts: string[],
  engine: string,
  activeSchema?: string | null,
  catalog?: string | null,
): TableRef | null {
  if (parts.length === 0) return null;
  if (engine === "Presto") {
    if (parts.length >= 3) {
      return { catalog: parts[0], schema: parts[1], table: parts[2] };
    }
    if (parts.length === 2) {
      return { catalog: truthy(catalog), schema: parts[0], table: parts[1] };
    }
    return { catalog: truthy(catalog), schema: truthy(activeSchema), table: parts[0] };
  }
  if (parts.length >= 2) {
    return { catalog: null, schema: parts[parts.length - 2], table: parts[parts.length - 1] };
  }
  return { catalog: null, schema: truthy(activeSchema), table: parts[0] };
}

function aliasMapFor(
  sql: string,
  engine: string,
  activeSchema?: string | null,
  catalog?: string | null,
): Map<string, TableRef> {
  const aliases = new Map<string, TableRef>();
  const cleaned = stripCommentsAndStrings(sql);
  const relationRe = new RegExp(
    String.raw`\b(?:from|join)\s+(${QUALIFIED_PATTERN})(?:\s+(?:as\s+)?(${IDENT_PATTERN}))?`,
    "gi",
  );
  let match: RegExpExecArray | null;
  while ((match = relationRe.exec(cleaned))) {
    const parts = splitSqlQualifiedName(match[1]);
    const ref = tableRefFromParts(parts, engine, activeSchema, catalog);
    if (!ref) continue;
    const alias = match[2] ? unquoteIdent(match[2]) : null;
    if (!alias || RESERVED_AFTER_RELATION.has(alias.toLowerCase())) continue;
    if (equalsName(alias, ref.table)) continue;
    aliases.set(alias.toLowerCase(), ref);
  }
  return aliases;
}

function filterOptions(options: Completion[], prefix: string, maxOptions: number): Completion[] {
  const lower = prefix.toLowerCase();
  return options
    .filter((option) => option.label.toLowerCase().startsWith(lower))
    .slice(0, maxOptions);
}

function schemaOptions(names: string[]): Completion[] {
  return names.map((name) => ({ label: name, type: "namespace" }));
}

function tableOptions(tables: DbTable[]): Completion[] {
  return tables.map((table) => ({
    label: table.name,
    type: table.kind === "view" ? "view" : "table",
    detail: table.kind === "materialized_view" ? "materialized view" : table.kind,
  }));
}

function columnOptions(columns: DbColumnDescription[]): Completion[] {
  return columns.map((column) => ({ label: column.name, type: "property", detail: column.type }));
}

async function isPrestoCatalog(name: string, options: SqlMetadataCompletionOptions): Promise<boolean> {
  if (options.engine !== "Presto") return false;
  const defaultCatalog = truthy(options.catalog) ?? options.cache.getDefaultCatalog();
  if (defaultCatalog && equalsName(defaultCatalog, name)) return true;
  const catalogs = await options.cache.listCatalogs();
  return catalogs.some((catalog) => equalsName(catalog, name));
}

async function listColumnsFor(ref: TableRef, options: SqlMetadataCompletionOptions): Promise<Completion[]> {
  const columns = await options.cache.describeTable(ref.schema, ref.table, ref.catalog);
  return columnOptions(columns);
}

async function listTablesFor(
  schema: string | null,
  catalog: string | null,
  options: SqlMetadataCompletionOptions,
): Promise<Completion[]> {
  return tableOptions(await options.cache.listTables(schema, catalog));
}

async function activeSchemaHasTable(
  table: string,
  options: SqlMetadataCompletionOptions,
): Promise<TableRef | null> {
  const schema = truthy(options.activeSchema);
  if (!schema) return null;
  const catalog = options.engine === "Presto" ? truthy(options.catalog) ?? options.cache.getDefaultCatalog() : null;
  const tables = await options.cache.listTables(schema, catalog);
  return tables.some((candidate) => equalsName(candidate.name, table))
    ? { catalog, schema, table }
    : null;
}

async function completionsForParts(
  parts: string[],
  aliases: Map<string, TableRef>,
  options: SqlMetadataCompletionOptions,
): Promise<Completion[]> {
  const [first, second, third] = parts;
  if (!first) return [];

  if (parts.length === 1) {
    const alias = aliases.get(first.toLowerCase());
    if (alias) return listColumnsFor(alias, options);

    if (options.engine === "Presto" && (await isPrestoCatalog(first, options))) {
      return schemaOptions(await options.cache.listSchemas(first));
    }

    const activeRef = await activeSchemaHasTable(first, options).catch(() => null);
    if (activeRef) return listColumnsFor(activeRef, options);

    const catalog = options.engine === "Presto" ? truthy(options.catalog) ?? options.cache.getDefaultCatalog() : null;
    return listTablesFor(first, catalog, options);
  }

  if (options.engine === "Presto") {
    if (parts.length === 2) {
      if (await isPrestoCatalog(first, options)) {
        return listTablesFor(second, first, options);
      }
      return listColumnsFor(
        { catalog: truthy(options.catalog) ?? options.cache.getDefaultCatalog(), schema: first, table: second },
        options,
      );
    }
    return listColumnsFor({ catalog: first, schema: second, table: third }, options);
  }

  return listColumnsFor({ catalog: null, schema: first, table: second }, options);
}

export function createSqlMetadataCompletionSource(
  options: SqlMetadataCompletionOptions,
): CompletionSource {
  return async (context: CompletionContext): Promise<CompletionResult | null> => {
    const doc = context.state.doc.toString();
    const before = doc.slice(0, context.pos);
    const match = before.match(DOT_CONTEXT_RE);
    if (!match) return null;

    const qualifier = match[1];
    const prefix = match[2] ?? "";
    const parts = splitSqlQualifiedName(qualifier);
    if (parts.length === 0 || parts.length > 3) return null;

    try {
      const aliases = aliasMapFor(
        currentStatement(doc, context.pos),
        options.engine,
        options.activeSchema,
        options.catalog,
      );
      const completions = await completionsForParts(parts, aliases, options);
      const filtered = filterOptions(
        completions,
        prefix,
        options.maxOptions ?? DB_METADATA_COMPLETION_LIMIT,
      );
      return filtered.length === 0
        ? null
        : {
            from: context.pos - prefix.length,
            options: filtered,
            validFor: /^[A-Za-z_][\w$]*$/,
          };
    } catch (error) {
      options.onError?.(String(error));
      return null;
    }
  };
}

function columnsNamespace(columns: DbColumnDescription[] | null): SQLNamespace {
  return (columns ?? []).map((column) => ({ label: column.name, type: "property", detail: column.type }));
}

function tableNamespace(
  table: DbTable,
  cache: DbMetadataCache,
  schema: string | null,
  catalog: string | null,
): SQLNamespace {
  return {
    self: {
      label: table.name,
      type: table.kind === "view" ? "view" : "table",
      detail: table.kind === "materialized_view" ? "materialized view" : table.kind,
    },
    children: columnsNamespace(cache.peekColumns(schema, table.name, catalog)),
  };
}

function schemaNamespace(
  schema: string,
  cache: DbMetadataCache,
  catalog: string | null,
): SQLNamespace {
  const children: Record<string, SQLNamespace> = {};
  for (const table of cache.peekTables(schema, catalog) ?? []) {
    children[table.name] = tableNamespace(table, cache, schema, catalog);
  }
  return { self: { label: schema, type: "namespace" }, children };
}

export function sqlNamespaceFromMetadata(
  options: SqlMetadataNamespaceOptions,
): SQLNamespace | undefined {
  const root: Record<string, SQLNamespace> = {};
  const defaultCatalog = options.engine === "Presto"
    ? truthy(options.catalog) ?? options.cache.getDefaultCatalog()
    : null;

  if (options.engine === "Presto") {
    const catalogs = new Set<string>(options.cache.peekCatalogs() ?? []);
    if (defaultCatalog) catalogs.add(defaultCatalog);
    for (const catalog of catalogs) {
      const schemas = options.cache.peekSchemas(catalog) ?? [];
      const catalogChildren: Record<string, SQLNamespace> = {};
      for (const schema of schemas) {
        catalogChildren[schema] = schemaNamespace(schema, options.cache, catalog);
      }
      root[catalog] = { self: { label: catalog, type: "namespace" }, children: catalogChildren };
    }
  } else {
    const schemas = new Set<string>(options.cache.peekSchemas(null) ?? []);
    if (options.activeSchema) schemas.add(options.activeSchema);
    for (const schema of schemas) {
      root[schema] = schemaNamespace(schema, options.cache, null);
    }
  }

  const activeSchema = truthy(options.activeSchema);
  if (activeSchema) {
    for (const table of options.cache.peekTables(activeSchema, defaultCatalog) ?? []) {
      if (!root[table.name]) {
        root[table.name] = tableNamespace(table, options.cache, activeSchema, defaultCatalog);
      }
    }
  }

  return Object.keys(root).length > 0 ? root : undefined;
}
