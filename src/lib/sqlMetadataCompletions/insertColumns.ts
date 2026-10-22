import type { CompletionContext, CompletionResult } from "@codemirror/autocomplete";
import { splitSqlQualifiedName } from "../dbMetadataCache";
import { type SqlMetadataCompletionOptions } from "./types";
import { tableRefFromParts, lastUnquotedComma, completionPrefix, identifierList } from "./parsing";
import { COMPLETION_PREFIX_FULL_RE, QUOTED_IDENTIFIER_VALID_FOR, BARE_IDENTIFIER_VALID_FOR } from "./syntax";
import { columnOptions, insertAllColumnsOption, filterOptions, reportResult } from "./options";

export async function insertColumnCompletions(
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
