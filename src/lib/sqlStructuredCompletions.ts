import {
  snippetCompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
  type CompletionSource,
} from "@codemirror/autocomplete";
import { syntaxTree } from "@codemirror/language";
import { splitSqlQualifiedName } from "./dbMetadataCache";
import { sqlIdentifierCompletionApply } from "./sqlEditorDialect";
import { sqlLocalRelations } from "./sqlLocalRelations";

interface SqlFunctionDefinition {
  label: string;
  signature: string;
  snippet: string;
  engines?: string[];
}

const WORD_PATTERN = String.raw`[\p{L}_][\p{L}\p{N}\p{M}_$]*`;
const IDENT_PATTERN = String.raw`(?:"(?:[^"]|"")*"|` + "`(?:[^`]|``)*`" + String.raw`|\[[^\]]+\]|${WORD_PATTERN})`;
const QUALIFIED_PATTERN = `${IDENT_PATTERN}(?:\\s*\\.\\s*${IDENT_PATTERN}){0,2}`;
const PREFIX_PATTERN = String.raw`[\p{L}\p{N}\p{M}_$]*`;
const DOT_CONTEXT_RE = new RegExp(`(${QUALIFIED_PATTERN})\\.(${PREFIX_PATTERN})?$`, "u");
const RELATION_CONTEXT_RE = new RegExp(`\\b(?:from|join|update|into)\\s+(${PREFIX_PATTERN})?$`, "iu");
const WORD_VALID_FOR = /^[\p{L}\p{N}\p{M}_$]*$/u;
const BLOCKED_NODES = new Set(["String", "LineComment", "BlockComment"]);

const SQL_FUNCTIONS: SqlFunctionDefinition[] = [
  { label: "COUNT", signature: "COUNT(expression)", snippet: "COUNT(${expression})" },
  { label: "SUM", signature: "SUM(expression)", snippet: "SUM(${expression})" },
  { label: "AVG", signature: "AVG(expression)", snippet: "AVG(${expression})" },
  { label: "MIN", signature: "MIN(expression)", snippet: "MIN(${expression})" },
  { label: "MAX", signature: "MAX(expression)", snippet: "MAX(${expression})" },
  {
    label: "COALESCE",
    signature: "COALESCE(value, fallback)",
    snippet: "COALESCE(${value}, ${fallback})",
  },
  { label: "NULLIF", signature: "NULLIF(left, right)", snippet: "NULLIF(${left}, ${right})" },
  { label: "CAST", signature: "CAST(expression AS type)", snippet: "CAST(${expression} AS ${type})" },
  {
    label: "DATE_TRUNC",
    signature: "DATE_TRUNC(precision, timestamp)",
    snippet: "DATE_TRUNC(${precision}, ${timestamp})",
    engines: ["PostgreSQL", "PanWeiDB", "Presto"],
  },
  {
    label: "STRING_AGG",
    signature: "STRING_AGG(expression, delimiter)",
    snippet: "STRING_AGG(${expression}, ${delimiter})",
    engines: ["PostgreSQL", "PanWeiDB", "SQLServer"],
  },
  { label: "IFNULL", signature: "IFNULL(value, fallback)", snippet: "IFNULL(${value}, ${fallback})", engines: ["MySQL", "StarRocks"] },
  {
    label: "DATE_FORMAT",
    signature: "DATE_FORMAT(date, format)",
    snippet: "DATE_FORMAT(${date}, ${format})",
    engines: ["MySQL", "StarRocks"],
  },
  {
    label: "GROUP_CONCAT",
    signature: "GROUP_CONCAT(expression)",
    snippet: "GROUP_CONCAT(${expression})",
    engines: ["MySQL", "StarRocks"],
  },
  { label: "ISNULL", signature: "ISNULL(value, fallback)", snippet: "ISNULL(${value}, ${fallback})", engines: ["SQLServer"] },
  {
    label: "DATEADD",
    signature: "DATEADD(part, number, date)",
    snippet: "DATEADD(${part}, ${number}, ${date})",
    engines: ["SQLServer"],
  },
  {
    label: "DATEDIFF",
    signature: "DATEDIFF(part, start, end)",
    snippet: "DATEDIFF(${part}, ${start}, ${end})",
    engines: ["SQLServer"],
  },
  { label: "NVL", signature: "NVL(value, fallback)", snippet: "NVL(${value}, ${fallback})", engines: ["Oracle"] },
  {
    label: "TO_CHAR",
    signature: "TO_CHAR(value, format)",
    snippet: "TO_CHAR(${value}, ${format})",
    engines: ["Oracle", "PostgreSQL", "PanWeiDB"],
  },
  {
    label: "TO_DATETIME",
    signature: "toDateTime(expression)",
    snippet: "toDateTime(${expression})",
    engines: ["ClickHouse"],
  },
  { label: "UNIQ", signature: "uniq(expression)", snippet: "uniq(${expression})", engines: ["ClickHouse"] },
  { label: "GROUPARRAY", signature: "groupArray(expression)", snippet: "groupArray(${expression})", engines: ["ClickHouse"] },
  {
    label: "APPROX_DISTINCT",
    signature: "approx_distinct(expression)",
    snippet: "approx_distinct(${expression})",
    engines: ["Presto"],
  },
  {
    label: "ARRAY_AGG",
    signature: "array_agg(expression)",
    snippet: "array_agg(${expression})",
    engines: ["PostgreSQL", "PanWeiDB", "Presto"],
  },
];

function blocked(context: CompletionContext): boolean {
  let node = syntaxTree(context.state).resolveInner(context.pos, -1);
  while (true) {
    if (BLOCKED_NODES.has(node.name)) return true;
    if (node.type.isTop || !node.parent) return false;
    node = node.parent;
  }
}

function currentStatement(context: CompletionContext): string {
  let node = syntaxTree(context.state).resolveInner(context.pos, -1);
  while (true) {
    if (node.name === "Statement") return context.state.sliceDoc(node.from, node.to);
    if (!node.parent) return context.state.doc.toString();
    node = node.parent;
  }
}

function rankedOptions(options: Completion[], prefix: string): Completion[] {
  const lower = prefix.toLocaleLowerCase();
  return options
    .filter((option) => option.label.toLocaleLowerCase().startsWith(lower))
    .map((option) => ({
      ...option,
      boost: (option.boost ?? 0) + (option.label.toLocaleLowerCase() === lower ? 80 : 20),
    }))
    .sort((left, right) =>
      (right.boost ?? 0) - (left.boost ?? 0) || left.label.localeCompare(right.label));
}

function columnOptions(engine: string, columns: string[]): Completion[] {
  return columns.map((column) => ({
    label: column,
    type: "property",
    apply: sqlIdentifierCompletionApply(engine, column),
    boost: 30,
  }));
}

function expansionOption(
  engine: string,
  rawQualifier: string,
  qualifierFrom: number,
  columns: string[],
): Completion {
  return {
    label: "* — expand all columns",
    type: "text",
    detail: `${columns.length} columns`,
    boost: 10,
    apply: (view, _completion, _from, to) => {
      const expanded = columns
        .map((column) => `${rawQualifier}.${sqlIdentifierCompletionApply(engine, column) ?? column}`)
        .join(", ");
      view.dispatch({
        changes: { from: qualifierFrom, to, insert: expanded },
        selection: { anchor: qualifierFrom + expanded.length },
      });
    },
  };
}

function functionOptions(engine: string): Completion[] {
  return SQL_FUNCTIONS
    .filter((definition) => !definition.engines || definition.engines.includes(engine))
    .map((definition) => snippetCompletion(definition.snippet, {
      label: definition.label,
      type: "function",
      detail: definition.signature,
      boost: 12,
    }));
}

export interface SqlStructuredCompletionOptions {
  engine: string;
}

/** Fast, local SQL completions that do not require database metadata I/O. */
export function createSqlStructuredCompletionSource(
  options: SqlStructuredCompletionOptions,
): CompletionSource {
  const functions = functionOptions(options.engine);
  return (context): CompletionResult | null => {
    if (blocked(context)) return null;
    const before = context.state.sliceDoc(0, context.pos);
    const dotMatch = before.match(DOT_CONTEXT_RE);
    if (dotMatch) {
      const relations = sqlLocalRelations(currentStatement(context));
      const parts = splitSqlQualifiedName(dotMatch[1]);
      const qualifier = parts.at(-1);
      const relation = qualifier ? relations.get(qualifier.toLocaleLowerCase()) : null;
      if (!relation) return null;
      const prefix = dotMatch[2] ?? "";
      const columns = rankedOptions(columnOptions(options.engine, relation.columns), prefix);
      if (!prefix) {
        columns.unshift(expansionOption(
          options.engine,
          dotMatch[1],
          dotMatch.index ?? context.pos,
          relation.columns,
        ));
      }
      return {
        from: context.pos - prefix.length,
        options: columns,
        validFor: WORD_VALID_FOR,
      };
    }

    const relationMatch = before.match(RELATION_CONTEXT_RE);
    if (relationMatch) {
      const relations = sqlLocalRelations(currentStatement(context));
      const prefix = relationMatch[1] ?? "";
      const relationOptions = Array.from(relations.values())
        .filter((relation, index, list) =>
          list.findIndex((candidate) =>
            candidate.name.toLocaleLowerCase() === relation.name.toLocaleLowerCase()) === index)
        .map((relation) => ({
          label: relation.name,
          type: "class",
          detail: relation.kind === "cte" ? "CTE" : "derived table",
          apply: sqlIdentifierCompletionApply(options.engine, relation.name),
          boost: 60,
        }));
      const filtered = rankedOptions(relationOptions, prefix);
      return filtered.length > 0
        ? { from: context.pos - prefix.length, options: filtered, validFor: WORD_VALID_FOR }
        : null;
    }

    const word = context.matchBefore(/[\p{L}\p{N}\p{M}_$]*$/u);
    if (!word || (!context.explicit && word.text.length === 0)) return null;
    const filtered = rankedOptions(functions, word.text);
    return filtered.length > 0
      ? { from: word.from, options: filtered, validFor: WORD_VALID_FOR }
      : null;
  };
}
