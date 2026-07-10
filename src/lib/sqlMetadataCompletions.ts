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
import type { DbColumnDescription, DbForeignKey, DbTable } from "./ipc";
import { sqlIdentifierCompletionApply } from "./sqlEditorDialect";
import { sqlLocalRelations } from "./sqlLocalRelations";

interface TableRef {
  catalog: string | null;
  schema: string | null;
  table: string;
}

interface NamedTableRef {
  ref: TableRef;
  qualifier: string;
}

export interface SqlMetadataCompletionOptions {
  cache: DbMetadataCache;
  engine: string;
  activeSchema?: string | null;
  catalog?: string | null;
  maxOptions?: number;
  onError?: (message: string) => void;
  onLoadingChange?: (loading: boolean) => void;
  onResult?: (result: { count: number; limitReached: boolean }) => void;
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
const INSERT_COLUMNS_CONTEXT_RE = new RegExp(
  `\\binsert\\s+into\\s+(${QUALIFIED_PATTERN})\\s*\\(([^)]*)$`,
  "iu",
);
const JOIN_ON_CONTEXT_RE = new RegExp(
  `\\bjoin\\s+(${QUALIFIED_PATTERN})(?:\\s+(?:as\\s+)?(${IDENT_PATTERN}))?\\s+on\\s+(${WORD_PREFIX_PATTERN})?$`,
  "iu",
);
const COMPLETION_PREFIX_FULL_RE = new RegExp(`^(?:${COMPLETION_PREFIX_PATTERN})?$`, "u");
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

function currentStatementBefore(context: CompletionContext): string {
  let node = syntaxTree(context.state).resolveInner(context.pos, -1);
  while (true) {
    if (node.name === "Statement") return context.state.sliceDoc(node.from, context.pos);
    if (!node.parent) return context.state.sliceDoc(0, context.pos);
    node = node.parent;
  }
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

function lastUnquotedComma(value: string): number {
  let quote: '"' | "`" | "]" | null = null;
  let last = -1;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (quote) {
      const closes = (quote === '"' && char === '"')
        || (quote === "`" && char === "`")
        || (quote === "]" && char === "]");
      if (closes && value[index + 1] === char) {
        index += 1;
      } else if (closes) {
        quote = null;
      }
      continue;
    }
    if (char === '"' || char === "`") quote = char;
    else if (char === "[") quote = "]";
    else if (char === ",") last = index;
  }
  return last;
}

function identifierList(value: string): string[] {
  const result: string[] = [];
  let rest = value;
  while (rest.trim()) {
    const separator = lastUnquotedComma(rest);
    if (separator < 0) {
      const identifier = unquoteIdent(rest.trim());
      if (identifier) result.unshift(identifier);
      break;
    }
    const identifier = unquoteIdent(rest.slice(separator + 1).trim());
    if (identifier) result.unshift(identifier);
    rest = rest.slice(0, separator);
  }
  return result;
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
  for (const relation of relationRefsFor(sql, engine, activeSchema, catalog)) {
    if (!equalsName(relation.qualifier, relation.ref.table)) {
      aliases.set(relation.qualifier.toLowerCase(), relation.ref);
    }
  }
  return aliases;
}

function relationRefsFor(
  sql: string,
  engine: string,
  activeSchema?: string | null,
  catalog?: string | null,
): NamedTableRef[] {
  const relations: NamedTableRef[] = [];
  const cleaned = stripCommentsAndStrings(sql);
  const reservedAliasPattern = Array.from(RESERVED_AFTER_RELATION).join("|");
  const relationRe = new RegExp(
    String.raw`\b(?:from|join)\s+(${QUALIFIED_PATTERN})(?:\s+(?:as\s+)?((?!(?:${reservedAliasPattern})\b)${IDENT_PATTERN}))?`,
    "giu",
  );
  let match: RegExpExecArray | null;
  while ((match = relationRe.exec(cleaned))) {
    const parts = splitSqlQualifiedName(match[1]);
    const ref = tableRefFromParts(parts, engine, activeSchema, catalog);
    if (!ref) continue;
    const alias = match[2] ? unquoteIdent(match[2]) : null;
    const qualifier = alias && !RESERVED_AFTER_RELATION.has(alias.toLowerCase())
      ? alias
      : ref.table;
    relations.push({ ref, qualifier });
  }
  return relations;
}

function filterOptions(options: Completion[], prefix: string, maxOptions: number): Completion[] {
  const lower = prefix.toLowerCase();
  return options
    .filter((option) => option.label.toLowerCase().startsWith(lower))
    .map((option) => {
      const label = option.label;
      const lowerLabel = label.toLowerCase();
      const matchBoost = label === prefix
        ? 100
        : lowerLabel === lower
          ? 90
          : label.startsWith(prefix)
            ? 40
            : 30;
      const typeBoost = option.type === "table"
        ? 8
        : option.type === "view"
          ? 6
          : option.type === "property"
            ? 4
            : 2;
      return { ...option, boost: (option.boost ?? 0) + matchBoost + typeBoost };
    })
    .sort((a, b) => (b.boost ?? 0) - (a.boost ?? 0) || a.label.localeCompare(b.label))
    .slice(0, maxOptions);
}

function reportResult(
  completions: Completion[],
  maxOptions: number,
  options: SqlMetadataCompletionOptions,
): void {
  options.onResult?.({
    count: completions.length,
    limitReached: completions.length >= maxOptions,
  });
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

function identifierText(engine: string, name: string): string {
  return sqlIdentifierCompletionApply(engine, name) ?? name;
}

function allColumnsOption(
  engine: string,
  rawQualifier: string,
  qualifierFrom: number,
  columns: Completion[],
): Completion {
  return {
    label: "* — expand all columns",
    type: "text",
    detail: `${columns.length} columns`,
    boost: 10,
    apply: (view, _completion, _from, to) => {
      const expanded = columns
        .map((column) => `${rawQualifier}.${identifierText(engine, column.label)}`)
        .join(", ");
      view.dispatch({
        changes: { from: qualifierFrom, to, insert: expanded },
        selection: { anchor: qualifierFrom + expanded.length },
      });
    },
  };
}

function insertAllColumnsOption(engine: string, columns: DbColumnDescription[]): Completion {
  return {
    label: "All columns — insert column list",
    type: "text",
    detail: `${columns.length} columns`,
    boost: 70,
    apply: columns.map((column) => identifierText(engine, column.name)).join(", "),
  };
}

function singularTableName(name: string): string {
  const lower = name.toLocaleLowerCase();
  if (lower.endsWith("ies") && lower.length > 3) return `${lower.slice(0, -3)}y`;
  if (lower.endsWith("ses") && lower.length > 3) return lower.slice(0, -2);
  if (lower.endsWith("s") && lower.length > 1) return lower.slice(0, -1);
  return lower;
}

function joinPredicateOptions(
  engine: string,
  left: NamedTableRef,
  leftColumns: DbColumnDescription[],
  leftForeignKeys: DbForeignKey[],
  right: NamedTableRef,
  rightColumns: DbColumnDescription[],
  rightForeignKeys: DbForeignKey[],
): Completion[] {
  const suggestions = new Map<string, Completion>();
  const addPredicate = (predicate: string, boost: number, detail: string) => {
    const existing = suggestions.get(predicate);
    if (!existing || (existing.boost ?? 0) < boost) {
      suggestions.set(predicate, {
        label: predicate,
        apply: predicate,
        type: "text",
        detail,
        boost,
      });
    }
  };
  const add = (
    leftColumn: DbColumnDescription,
    rightColumn: DbColumnDescription,
    boost: number,
    detail: string,
  ) => {
    const predicate = `${identifierText(engine, left.qualifier)}.${identifierText(engine, leftColumn.name)} = ${identifierText(engine, right.qualifier)}.${identifierText(engine, rightColumn.name)}`;
    addPredicate(predicate, boost, detail);
  };

  const referencesTable = (foreignKey: DbForeignKey, target: TableRef) =>
    equalsName(foreignKey.referencedTable, target.table)
    && (!foreignKey.referencedSchema || !target.schema
      || equalsName(foreignKey.referencedSchema, target.schema));
  for (const foreignKey of leftForeignKeys.filter((candidate) => referencesTable(candidate, right.ref))) {
    const predicates = foreignKey.columns.flatMap((column, index) => {
      const referencedColumn = foreignKey.referencedColumns[index];
      return referencedColumn
        ? [`${identifierText(engine, left.qualifier)}.${identifierText(engine, column)} = ${identifierText(engine, right.qualifier)}.${identifierText(engine, referencedColumn)}`]
        : [];
    });
    if (predicates.length > 0) {
      addPredicate(predicates.join(" AND "), 220, `Foreign key ${foreignKey.name}`);
    }
  }
  for (const foreignKey of rightForeignKeys.filter((candidate) => referencesTable(candidate, left.ref))) {
    const predicates = foreignKey.columns.flatMap((column, index) => {
      const referencedColumn = foreignKey.referencedColumns[index];
      return referencedColumn
        ? [`${identifierText(engine, left.qualifier)}.${identifierText(engine, referencedColumn)} = ${identifierText(engine, right.qualifier)}.${identifierText(engine, column)}`]
        : [];
    });
    if (predicates.length > 0) {
      addPredicate(predicates.join(" AND "), 220, `Foreign key ${foreignKey.name}`);
    }
  }

  const leftTable = singularTableName(left.ref.table);
  const rightTable = singularTableName(right.ref.table);
  for (const rightPrimary of rightColumns.filter((column) => column.primaryKey)) {
    const expected = new Set([
      `${rightTable}_${rightPrimary.name.toLocaleLowerCase()}`,
      `${right.ref.table.toLocaleLowerCase()}_${rightPrimary.name.toLocaleLowerCase()}`,
    ]);
    for (const leftColumn of leftColumns) {
      if (expected.has(leftColumn.name.toLocaleLowerCase())) {
        add(leftColumn, rightPrimary, 130, "Primary-key join suggestion");
      }
    }
  }
  for (const leftPrimary of leftColumns.filter((column) => column.primaryKey)) {
    const expected = new Set([
      `${leftTable}_${leftPrimary.name.toLocaleLowerCase()}`,
      `${left.ref.table.toLocaleLowerCase()}_${leftPrimary.name.toLocaleLowerCase()}`,
    ]);
    for (const rightColumn of rightColumns) {
      if (expected.has(rightColumn.name.toLocaleLowerCase())) {
        add(leftPrimary, rightColumn, 130, "Primary-key join suggestion");
      }
    }
  }
  for (const leftColumn of leftColumns) {
    const rightColumn = rightColumns.find((column) => equalsName(column.name, leftColumn.name));
    if (!rightColumn || (leftColumn.primaryKey && rightColumn.primaryKey)) continue;
    add(leftColumn, rightColumn, 80, "Matching-column join suggestion");
  }
  return Array.from(suggestions.values())
    .sort((leftOption, rightOption) =>
      (rightOption.boost ?? 0) - (leftOption.boost ?? 0)
      || leftOption.label.localeCompare(rightOption.label));
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

async function insertColumnCompletions(
  context: CompletionContext,
  match: RegExpMatchArray,
  maxOptions: number,
  options: SqlMetadataCompletionOptions,
): Promise<CompletionResult | null> {
  const parts = splitSqlQualifiedName(match[1]);
  const ref = tableRefFromParts(parts, options.engine, options.activeSchema, options.catalog);
  if (!ref) return null;
  const content = match[2];
  const separator = lastUnquotedComma(content);
  const rawPrefix = content.slice(separator + 1).trimStart();
  if (!COMPLETION_PREFIX_FULL_RE.test(rawPrefix)) return null;
  const prefix = completionPrefix(rawPrefix, context.pos);
  const usedColumns = new Set(
    identifierList(separator >= 0 ? content.slice(0, separator + 1) : "")
      .map((column) => column.toLocaleLowerCase()),
  );

  context.addEventListener("abort", () => undefined, { onDocChange: true });
  options.onLoadingChange?.(true);
  try {
    const columns = await options.cache.describeTable(ref.schema, ref.table, ref.catalog);
    if (context.aborted) return null;
    const available = columns.filter((column) => !usedColumns.has(column.name.toLocaleLowerCase()));
    const completions = columnOptions(available, options.engine, prefix.quoted);
    if (!content.trim() && columns.length > 0) {
      completions.unshift(insertAllColumnsOption(options.engine, columns));
    }
    const filtered = filterOptions(completions, prefix.text, maxOptions);
    reportResult(filtered, maxOptions, options);
    return filtered.length > 0
      ? {
          from: prefix.from,
          options: filtered,
          validFor: prefix.quoted ? QUOTED_IDENTIFIER_VALID_FOR : BARE_IDENTIFIER_VALID_FOR,
        }
      : null;
  } catch (error) {
    if (!context.aborted) options.onError?.(String(error));
    return null;
  } finally {
    options.onLoadingChange?.(false);
  }
}

async function joinOnCompletions(
  context: CompletionContext,
  match: RegExpMatchArray,
  statementBefore: string,
  maxOptions: number,
  options: SqlMetadataCompletionOptions,
): Promise<CompletionResult | null> {
  const relations = relationRefsFor(
    statementBefore,
    options.engine,
    options.activeSchema,
    options.catalog,
  );
  const right = relations.at(-1);
  const left = relations.at(-2);
  if (!left || !right) return null;
  const prefix = match[3] ?? "";

  context.addEventListener("abort", () => undefined, { onDocChange: true });
  options.onLoadingChange?.(true);
  try {
    const [leftColumns, leftForeignKeys, rightColumns, rightForeignKeys] = await Promise.all([
      options.cache.describeTable(left.ref.schema, left.ref.table, left.ref.catalog),
      options.cache.listForeignKeys(left.ref.schema, left.ref.table, left.ref.catalog),
      options.cache.describeTable(right.ref.schema, right.ref.table, right.ref.catalog),
      options.cache.listForeignKeys(right.ref.schema, right.ref.table, right.ref.catalog),
    ]);
    if (context.aborted) return null;
    const filtered = filterOptions(
      joinPredicateOptions(
        options.engine,
        left,
        leftColumns,
        leftForeignKeys,
        right,
        rightColumns,
        rightForeignKeys,
      ),
      prefix,
      Math.min(maxOptions, 50),
    );
    reportResult(filtered, Math.min(maxOptions, 50), options);
    return filtered.length > 0
      ? {
          from: context.pos - prefix.length,
          options: filtered,
          validFor: BARE_IDENTIFIER_VALID_FOR,
        }
      : null;
  } catch (error) {
    if (!context.aborted) options.onError?.(String(error));
    return null;
  } finally {
    options.onLoadingChange?.(false);
  }
}

export function createSqlMetadataCompletionSource(
  options: SqlMetadataCompletionOptions,
): CompletionSource {
  return async (context: CompletionContext): Promise<CompletionResult | null> => {
    if (completionIsBlocked(context)) return null;
    const doc = context.state.doc.toString();
    const before = doc.slice(0, context.pos);
    const maxOptions = options.maxOptions ?? DB_METADATA_COMPLETION_LIMIT;
    const statementBefore = currentStatementBefore(context);
    const insertMatch = statementBefore.match(INSERT_COLUMNS_CONTEXT_RE);
    if (insertMatch) {
      return insertColumnCompletions(context, insertMatch, maxOptions, options);
    }
    const joinOnMatch = statementBefore.match(JOIN_ON_CONTEXT_RE);
    if (joinOnMatch) {
      return joinOnCompletions(context, joinOnMatch, statementBefore, maxOptions, options);
    }

    const match = before.match(DOT_CONTEXT_RE);
    if (!match) {
      const relationMatch = before.match(RELATION_CONTEXT_RE);
      const activeSchema = truthy(options.activeSchema);
      if (!relationMatch || !activeSchema) return null;
      const prefix = completionPrefix(relationMatch[1], context.pos);
      context.addEventListener("abort", () => undefined, { onDocChange: true });
      const catalog = options.engine === "Presto"
        ? truthy(options.catalog) ?? options.cache.getDefaultCatalog()
        : null;
      options.onLoadingChange?.(true);
      try {
        const completions = tableOptions(
          await options.cache.searchTables(activeSchema, prefix.text, catalog, maxOptions),
          options.engine,
          prefix.quoted,
        );
        if (context.aborted) return null;
        const filtered = filterOptions(completions, prefix.text, maxOptions);
        reportResult(filtered, maxOptions, options);
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
      } finally {
        options.onLoadingChange?.(false);
      }
    }

    const qualifier = match[1];
    const prefix = completionPrefix(match[2], context.pos);
    const parts = splitSqlQualifiedName(qualifier);
    if (parts.length === 0 || parts.length > 3) return null;
    if (parts.length === 1) {
      const localRelation = sqlLocalRelations(currentStatement(context, doc))
        .get(parts[0].toLocaleLowerCase());
      if (localRelation) return null;
    }
    context.addEventListener("abort", () => undefined, { onDocChange: true });

    options.onLoadingChange?.(true);
    try {
      const aliases = aliasMapFor(
        currentStatement(context, doc),
        options.engine,
        options.activeSchema,
        options.catalog,
      );
      let completions = await completionsForParts(
        parts,
        aliases,
        prefix.text,
        maxOptions,
        prefix.quoted,
        options,
      );
      if (context.aborted) return null;
      if (!prefix.text && completions.length > 0
        && completions.every((completion) => completion.type === "property")) {
        completions = [
          allColumnsOption(
            options.engine,
            qualifier,
            match.index ?? context.pos,
            completions,
          ),
          ...completions,
        ];
      }
      const filtered = filterOptions(
        completions,
        prefix.text,
        maxOptions,
      );
      reportResult(filtered, maxOptions, options);
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
    } finally {
      options.onLoadingChange?.(false);
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
