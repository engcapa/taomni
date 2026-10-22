import type { Completion } from "@codemirror/autocomplete";
import { type SqlMetadataCompletionOptions, type TableRef } from "./types";
import { truthy, equalsName } from "./parsing";
import { columnOptions, tableOptions } from "./options";

export async function isPrestoCatalog(name: string, options: SqlMetadataCompletionOptions): Promise<boolean> {
  if (options.engine !== "Presto") return false;
  const defaultCatalog = truthy(options.catalog) ?? options.cache.getDefaultCatalog();
  if (defaultCatalog && equalsName(defaultCatalog, name)) return true;
  const catalogs = await options.cache.listCatalogs();
  return catalogs.some((catalog) => equalsName(catalog, name));
}

export async function listColumnsFor(
  ref: TableRef,
  options: SqlMetadataCompletionOptions,
  forceQuote: boolean,
): Promise<Completion[]> {
  const columns = await options.cache.describeTable(ref.schema, ref.table, ref.catalog);
  return columnOptions(columns, options.engine, forceQuote);
}

export async function listTablesFor(
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

export async function activeSchemaHasTable(
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
