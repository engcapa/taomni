import type { Completion } from "@codemirror/autocomplete";
import { type TableRef, type SqlMetadataCompletionOptions } from "./types";
import { listColumnsFor, isPrestoCatalog, activeSchemaHasTable, listTablesFor } from "./metadata";
import { schemaOptions } from "./options";
import { truthy } from "./parsing";

export async function completionsForParts(
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
