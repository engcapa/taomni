import type { CompletionContext, CompletionResult, CompletionSource } from "@codemirror/autocomplete";
import { DB_METADATA_COMPLETION_LIMIT, splitSqlQualifiedName } from "../dbMetadataCache";
import { sqlLocalRelations } from "../sqlLocalRelations";
import { sqlSelectListScope } from "../sqlQueryScope";
import { type SqlMetadataCompletionOptions } from "./types";
import { completionIsBlocked, currentStatementBefore, truthy, completionPrefix, currentStatement, aliasMapFor } from "./parsing";
import {
  INSERT_COLUMNS_CONTEXT_RE,
  JOIN_ON_CONTEXT_RE,
  DOT_CONTEXT_RE,
  RELATION_CONTEXT_RE,
  QUOTED_IDENTIFIER_VALID_FOR,
  BARE_IDENTIFIER_VALID_FOR,
} from "./syntax";
import { insertColumnCompletions } from "./insertColumns";
import { joinOnCompletions } from "./joinOn";
import { selectListCompletions } from "./selectList";
import { tableOptions, filterOptions, reportResult, allColumnsOption } from "./options";
import { completionsForParts } from "./qualified";

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
      const selectScope = sqlSelectListScope(doc, context.pos);
      if (selectScope) {
        return selectListCompletions(context, selectScope, doc, maxOptions, options);
      }
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
