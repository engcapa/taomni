import type { CompletionContext, CompletionResult } from "@codemirror/autocomplete";
import { type SqlMetadataCompletionOptions } from "./types";
import { relationRefsFor } from "./parsing";
import { filterOptions, reportResult } from "./options";
import { joinPredicateOptions } from "./joinPredicates";
import { BARE_IDENTIFIER_VALID_FOR } from "./syntax";

export async function joinOnCompletions(
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
