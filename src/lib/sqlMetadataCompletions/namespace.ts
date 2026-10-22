import type { SQLNamespace } from "@codemirror/lang-sql";
import { type DbMetadataCache } from "../dbMetadataCache";
import type { DbColumnDescription, DbTable } from "../ipc";
import { columnOptions, identifierOption } from "./options";
import { type SqlMetadataNamespaceOptions } from "./types";
import { truthy } from "./parsing";

export function columnsNamespace(
  columns: DbColumnDescription[] | null,
  engine: string,
): SQLNamespace {
  return columnOptions(columns ?? [], engine);
}

export function tableNamespace(
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

export function schemaNamespace(
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
