import type {
  Completion,
  CompletionContext,
  CompletionResult,
  CompletionSource,
} from "@codemirror/autocomplete";
import type { SQLNamespace } from "@codemirror/lang-sql";
import { syntaxTree } from "@codemirror/language";
import {
  DB_METADATA_COMPLETION_LIMIT,
  type DbMetadataCache,
  splitSqlQualifiedName,
} from "./dbMetadataCache";
import type { DbColumnDescription, DbTable } from "./ipc";
import { sqlIdentifierCompletionApply } from "./sqlEditorDialect";

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

const WORD_PREFIX_PATTERN = String.raw`[\p{L}_][\p{L}\p{N}\p{M}_$]*`;
const IDENT_PATTERN = String.raw`(?:"(?:[^"]|"")*"|` + "`(?:[^`]|``)*`" + String.raw`|\[[^\]]+\]|${WORD_PREFIX_PATTERN})`;
const QUALIFIED_PATTERN = `${IDENT_PATTERN}(?:\\s*\\.\\s*${IDENT_PATTERN}){0,2}`;
const QUOTED_PREFIX_PATTERN = String.raw`(?:"(?:[^"]|"")*|` + "`(?:[^`]|``)*" + String.raw`|\[(?:[^\]]|\]\])*)`;
const COMPLETION_PREFIX_PATTERN = `(?:${WORD_PREFIX_PATTERN}|${QUOTED_PREFIX_PATTERN})`;
const DOT_CONTEXT_RE = new RegExp(`(${QUALIFIED_PATTERN})\\.(${COMPLETION_PREFIX_PATTERN})?$`, "u");
const RELATION_CONTEXT_RE = new RegExp(`\\b(?:from|join|update|into)\\s+(${COMPLETION_PREFIX_PATTERN})?$`, "iu");
const BARE_IDENTIFIER_VALID_FOR = /^[\p{L}_][\p{L}\p{N}\p{M}_$]*$/u;
const QUOTED_IDENTIFIER_VALID_FOR = /^(?:"(?:[^"]|"")*|`(?:[^`]|``)*|\[(?:[^\]]|\]\])*)$/u;
const COMPLETION_BLOCKED_NODES = new Set(["String", "LineComment", "BlockComment"]);
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

function currentStatement(context: CompletionContext, doc: string): string {
  let node = syntaxTree(context.state).resolveInner(context.pos, -1);
  while (true) {
    if (node.name === "Statement") return context.state.sliceDoc(node.from, node.to);
    if (!node.parent) break;
    node = node.parent;
  }
  const pos = context.pos;
  const before = doc.slice(0, pos);
  const after = doc.slice(pos);
  const start = before.lastIndexOf(";");
  const end = after.indexOf(";");
  return `${start >= 0 ? before.slice(start + 1) : before}${end >= 0 ? after.slice(0, end) : after}`;
}

function completionIsBlocked(context: CompletionContext): boolean {
  let node = syntaxTree(context.state).resolveInner(context.pos, -1);
  while (true) {
    if (COMPLETION_BLOCKED_NODES.has(node.name)) return true;
    if (node.type.isTop) break;
    if (!node.parent) break;
    node = node.parent;
  }
  return false;
}

interface CompletionPrefix {
  from: number;
  text: string;
  quoted: boolean;
}

function completionPrefix(raw: string | undefined, pos: number): CompletionPrefix {
  const value = raw ?? "";
  const quote = value[0];
  if (quote === '"') {
    return { from: pos - value.length, text: value.slice(1).replace(/""/g, '"'), quoted: true };
  }
  if (quote === "`") {
    return { from: pos - value.length, text: value.slice(1).replace(/``/g, "`"), quoted: true };
  }
  if (quote === "[") {
    return { from: pos - value.length, text: value.slice(1).replace(/\]\]/g, "]"), quoted: true };
  }
  return { from: pos - value.length, text: value, quoted: false };
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
    "giu",
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

function identifierOption(
  name: string,
  type: string,
  engine: string,
  forceQuote = false,
): Completion {
  return {
    label: name,
    type,
    apply: sqlIdentifierCompletionApply(engine, name, forceQuote),
  };
}

function schemaOptions(names: string[], engine: string, forceQuote = false): Completion[] {
  return names.map((name) => identifierOption(name, "namespace", engine, forceQuote));
}

function tableOptions(tables: DbTable[], engine: string, forceQuote = false): Completion[] {
  return tables.map((table) => ({
    ...identifierOption(table.name, table.kind === "view" ? "view" : "table", engine, forceQuote),
    detail: table.kind === "materialized_view" ? "materialized view" : table.kind,
  }));
}

function columnOptions(
  columns: DbColumnDescription[],
  engine: string,
  forceQuote = false,
): Completion[] {
  return columns.map((column) => ({
    ...identifierOption(column.name, "property", engine, forceQuote),
    detail: column.type,
  }));
}

async function isPrestoCatalog(name: string, options: SqlMetadataCompletionOptions): Promise<boolean> {
  if (options.engine !== "Presto") return false;
  const defaultCatalog = truthy(options.catalog) ?? options.cache.getDefaultCatalog();
  if (defaultCatalog && equalsName(defaultCatalog, name)) return true;
  const catalogs = await options.cache.listCatalogs();
  return catalogs.some((catalog) => equalsName(catalog, name));
}

async function listColumnsFor(
  ref: TableRef,
  options: SqlMetadataCompletionOptions,
  forceQuote: boolean,
): Promise<Completion[]> {
  const columns = await options.cache.describeTable(ref.schema, ref.table, ref.catalog);
  return columnOptions(columns, options.engine, forceQuote);
}

async function listTablesFor(
  schema: string | null,
  catalog: string | null,
  prefix: string,
  maxOptions: number,
  forceQuote: boolean,
  options: SqlMetadataCompletionOptions,
): Promise<Completion[]> {
  return tableOptions(
    await options.cache.searchTables(schema, prefix, catalog, maxOptions),
    options.engine,
    forceQuote,
  );
}

async function activeSchemaHasTable(
  table: string,
  options: SqlMetadataCompletionOptions,
): Promise<TableRef | null> {
  const schema = truthy(options.activeSchema);
  if (!schema) return null;
  const catalog = options.engine === "Presto" ? truthy(options.catalog) ?? options.cache.getDefaultCatalog() : null;
  const tables = await options.cache.searchTables(schema, table, catalog, 2);
  const candidate = tables.find((entry) => equalsName(entry.name, table));
  return candidate ? { catalog, schema, table: candidate.name } : null;
}

async function completionsForParts(
  parts: string[],
  aliases: Map<string, TableRef>,
  prefix: string,
  maxOptions: number,
  forceQuote: boolean,
  options: SqlMetadataCompletionOptions,
): Promise<Completion[]> {
  const [first, second, third] = parts;
  if (!first) return [];

  if (parts.length === 1) {
    const alias = aliases.get(first.toLowerCase());
    if (alias) return listColumnsFor(alias, options, forceQuote);

    if (options.engine === "Presto" && (await isPrestoCatalog(first, options))) {
      return schemaOptions(await options.cache.listSchemas(first), options.engine, forceQuote);
    }

    const activeRef = await activeSchemaHasTable(first, options).catch(() => null);
    if (activeRef) return listColumnsFor(activeRef, options, forceQuote);

    const catalog = options.engine === "Presto" ? truthy(options.catalog) ?? options.cache.getDefaultCatalog() : null;
    return listTablesFor(first, catalog, prefix, maxOptions, forceQuote, options);
  }

  if (options.engine === "Presto") {
    if (parts.length === 2) {
      if (await isPrestoCatalog(first, options)) {
        return listTablesFor(second, first, prefix, maxOptions, forceQuote, options);
      }
      return listColumnsFor(
        { catalog: truthy(options.catalog) ?? options.cache.getDefaultCatalog(), schema: first, table: second },
        options,
        forceQuote,
      );
    }
    return listColumnsFor({ catalog: first, schema: second, table: third }, options, forceQuote);
  }

  return listColumnsFor({ catalog: null, schema: first, table: second }, options, forceQuote);
}

export function createSqlMetadataCompletionSource(
  options: SqlMetadataCompletionOptions,
): CompletionSource {
  return async (context: CompletionContext): Promise<CompletionResult | null> => {
    if (completionIsBlocked(context)) return null;
    const doc = context.state.doc.toString();
    const before = doc.slice(0, context.pos);
    const match = before.match(DOT_CONTEXT_RE);
    const maxOptions = options.maxOptions ?? DB_METADATA_COMPLETION_LIMIT;
    if (!match) {
      const relationMatch = before.match(RELATION_CONTEXT_RE);
      const activeSchema = truthy(options.activeSchema);
      if (!relationMatch || !activeSchema) return null;
      const prefix = completionPrefix(relationMatch[1], context.pos);
      context.addEventListener("abort", () => undefined, { onDocChange: true });
      const catalog = options.engine === "Presto"
        ? truthy(options.catalog) ?? options.cache.getDefaultCatalog()
        : null;
      try {
        const completions = tableOptions(
          await options.cache.searchTables(activeSchema, prefix.text, catalog, maxOptions),
          options.engine,
          prefix.quoted,
        );
        if (context.aborted) return null;
        const filtered = filterOptions(completions, prefix.text, maxOptions);
        return filtered.length === 0
          ? null
          : {
              from: prefix.from,
              options: filtered,
              validFor: prefix.quoted ? QUOTED_IDENTIFIER_VALID_FOR : BARE_IDENTIFIER_VALID_FOR,
            };
      } catch (error) {
        if (!context.aborted) options.onError?.(String(error));
        return null;
      }
    }

    const qualifier = match[1];
    const prefix = completionPrefix(match[2], context.pos);
    const parts = splitSqlQualifiedName(qualifier);
    if (parts.length === 0 || parts.length > 3) return null;
    context.addEventListener("abort", () => undefined, { onDocChange: true });

    try {
      const aliases = aliasMapFor(
        currentStatement(context, doc),
        options.engine,
        options.activeSchema,
        options.catalog,
      );
      const completions = await completionsForParts(
        parts,
        aliases,
        prefix.text,
        maxOptions,
        prefix.quoted,
        options,
      );
      if (context.aborted) return null;
      const filtered = filterOptions(
        completions,
        prefix.text,
        maxOptions,
      );
      return filtered.length === 0
        ? null
        : {
            from: prefix.from,
            options: filtered,
            validFor: prefix.quoted ? QUOTED_IDENTIFIER_VALID_FOR : BARE_IDENTIFIER_VALID_FOR,
          };
    } catch (error) {
      if (!context.aborted) options.onError?.(String(error));
      return null;
    }
  };
}

function columnsNamespace(
  columns: DbColumnDescription[] | null,
  engine: string,
): SQLNamespace {
  return columnOptions(columns ?? [], engine);
}

function tableNamespace(
  table: DbTable,
  cache: DbMetadataCache,
  schema: string | null,
  catalog: string | null,
  engine: string,
): SQLNamespace {
  return {
    self: {
      ...identifierOption(table.name, table.kind === "view" ? "view" : "table", engine),
      detail: table.kind === "materialized_view" ? "materialized view" : table.kind,
    },
    children: columnsNamespace(cache.peekColumns(schema, table.name, catalog), engine),
  };
}

function schemaNamespace(
  schema: string,
  cache: DbMetadataCache,
  catalog: string | null,
  engine: string,
): SQLNamespace {
  const children: Record<string, SQLNamespace> = {};
  for (const table of cache.peekTables(schema, catalog) ?? []) {
    children[table.name] = tableNamespace(table, cache, schema, catalog, engine);
  }
  return { self: identifierOption(schema, "namespace", engine), children };
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
        catalogChildren[schema] = schemaNamespace(schema, options.cache, catalog, options.engine);
      }
      root[catalog] = {
        self: identifierOption(catalog, "namespace", options.engine),
        children: catalogChildren,
      };
    }
  } else {
    const schemas = new Set<string>(options.cache.peekSchemas(null) ?? []);
    if (options.activeSchema) schemas.add(options.activeSchema);
    for (const schema of schemas) {
      root[schema] = schemaNamespace(schema, options.cache, null, options.engine);
    }
  }

  const activeSchema = truthy(options.activeSchema);
  if (activeSchema) {
    for (const table of options.cache.peekTables(activeSchema, defaultCatalog) ?? []) {
      if (!root[table.name]) {
        root[table.name] = tableNamespace(
          table,
          options.cache,
          activeSchema,
          defaultCatalog,
          options.engine,
        );
      }
    }
  }

  return Object.keys(root).length > 0 ? root : undefined;
}
