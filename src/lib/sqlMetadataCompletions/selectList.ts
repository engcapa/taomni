import type { Completion, CompletionContext, CompletionResult } from "@codemirror/autocomplete";
import { sqlIdentifierCompletionApply } from "../sqlEditorDialect";
import { sqlLocalRelations } from "../sqlLocalRelations";
import { type SqlSelectListScope } from "../sqlQueryScope";
import { type SelectColumnSource, type SqlMetadataCompletionOptions, type TableRef } from "./types";
import { identifierText, filterOptions, reportResult } from "./options";
import { COMPLETION_PREFIX_PATTERN, SQL_SELECT_RELATION_LIMIT, QUOTED_IDENTIFIER_VALID_FOR, BARE_IDENTIFIER_VALID_FOR } from "./syntax";
import { completionPrefix, currentStatement, tableRefFromParts } from "./parsing";

export function selectColumnOptions(
  sources: SelectColumnSource[],
  relationCount: number,
  engine: string,
  forceQuote: boolean,
): Completion[] {
  const qualify = relationCount > 1;
  const completions: Completion[] = [];
  for (const source of sources) {
    const qualifier = identifierText(engine, source.qualifier);
    if (source.columns.length > 0) {
      const expanded = source.columns
        .map((column) => {
          const columnName = identifierText(engine, column.name);
          return qualify ? `${qualifier}.${columnName}` : columnName;
        })
        .join(", ");
      completions.push({
        label: qualify ? `${source.qualifier}.* — expand columns` : "* — expand all columns",
        type: "text",
        detail: `${source.detail} · ${source.columns.length} columns`,
        apply: expanded,
        boost: 10,
      });
    }
    for (const column of source.columns) {
      const columnName = sqlIdentifierCompletionApply(engine, column.name, forceQuote) ?? column.name;
      completions.push({
        label: column.name,
        displayLabel: qualify ? `${source.qualifier}.${column.name}` : column.name,
        sortText: `${column.name}\u0000${source.qualifier}`,
        type: "property",
        detail: [source.detail, column.type, column.primaryKey ? "PK" : null]
          .filter(Boolean)
          .join(" · "),
        apply: qualify ? `${qualifier}.${columnName}` : columnName,
        boost: column.primaryKey ? 25 : 20,
      });
    }
  }
  return completions;
}

export async function selectListCompletions(
  context: CompletionContext,
  scope: SqlSelectListScope,
  doc: string,
  maxOptions: number,
  options: SqlMetadataCompletionOptions,
): Promise<CompletionResult | null> {
  const beforeCursor = doc.slice(scope.selectListFrom, context.pos);
  const prefixMatch = beforeCursor.match(new RegExp(`(${COMPLETION_PREFIX_PATTERN})?$`, "u"));
  const prefix = completionPrefix(prefixMatch?.[1], context.pos);
  const relations = scope.relations.slice(0, SQL_SELECT_RELATION_LIMIT);
  if (relations.length === 0) return null;

  const localRelations = sqlLocalRelations(currentStatement(context, doc));
  const localSources: SelectColumnSource[] = [];
  const physicalRelations: Array<{ qualifier: string; ref: TableRef; }> = [];
  for (const relation of relations) {
    const sourceName = relation.parts.at(-1)?.toLocaleLowerCase();
    const local = localRelations.get(relation.qualifier.toLocaleLowerCase())
      ?? (sourceName ? localRelations.get(sourceName) : null);
    if (local) {
      localSources.push({
        qualifier: relation.qualifier,
        detail: local.kind === "cte" ? `CTE ${relation.qualifier}` : `Derived table ${relation.qualifier}`,
        columns: local.columns.map((name) => ({ name })),
      });
      continue;
    }
    if (relation.kind !== "named") continue;
    const ref = tableRefFromParts(relation.parts, options.engine, options.activeSchema, options.catalog);
    if (ref) physicalRelations.push({ qualifier: relation.qualifier, ref });
  }

  context.addEventListener("abort", () => undefined, { onDocChange: true });
  if (physicalRelations.length > 0) options.onLoadingChange?.(true);
  try {
    const errors: unknown[] = [];
    const physicalSources = (await Promise.all(physicalRelations.map(async (
      { qualifier, ref },
    ): Promise<SelectColumnSource | null> => {
      try {
        const columns = await options.cache.describeTable(ref.schema, ref.table, ref.catalog);
        return {
          qualifier,
          detail: qualifier === ref.table ? ref.table : `${qualifier} · ${ref.table}`,
          columns,
        };
      } catch (error) {
        errors.push(error);
        return null;
      }
    }))).filter((source): source is SelectColumnSource => source !== null);
    if (context.aborted) return null;

    const sources = [...localSources, ...physicalSources];
    if (sources.length === 0) {
      if (errors.length > 0) options.onError?.(String(errors[0]));
      return null;
    }
    const filtered = filterOptions(
      selectColumnOptions(sources, relations.length, options.engine, prefix.quoted),
      prefix.text,
      maxOptions,
    );
    reportResult(filtered, maxOptions, options);
    return filtered.length > 0
      ? {
        from: prefix.from,
        options: filtered,
        validFor: prefix.quoted ? QUOTED_IDENTIFIER_VALID_FOR : BARE_IDENTIFIER_VALID_FOR,
      }
      : null;
  } finally {
    if (physicalRelations.length > 0) options.onLoadingChange?.(false);
  }
}
