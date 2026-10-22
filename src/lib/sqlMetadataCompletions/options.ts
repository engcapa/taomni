import type { Completion } from "@codemirror/autocomplete";
import type { DbColumnDescription, DbTable } from "../ipc";
import { sqlIdentifierCompletionApply } from "../sqlEditorDialect";
import { type SqlMetadataCompletionOptions } from "./types";

export function filterOptions(options: Completion[], prefix: string, maxOptions: number): Completion[] {
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

export function reportResult(
  completions: Completion[],
  maxOptions: number,
  options: SqlMetadataCompletionOptions,
): void {
  options.onResult?.({
    count: completions.length,
    limitReached: completions.length >= maxOptions,
  });
}

export function identifierOption(
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

export function schemaOptions(names: string[], engine: string, forceQuote = false): Completion[] {
  return names.map((name) => identifierOption(name, "namespace", engine, forceQuote));
}

export function tableOptions(tables: DbTable[], engine: string, forceQuote = false): Completion[] {
  return tables.map((table) => ({
    ...identifierOption(table.name, table.kind === "view" ? "view" : "table", engine, forceQuote),
    detail: table.kind === "materialized_view" ? "materialized view" : table.kind,
  }));
}

export function columnOptions(
  columns: DbColumnDescription[],
  engine: string,
  forceQuote = false,
): Completion[] {
  return columns.map((column) => ({
    ...identifierOption(column.name, "property", engine, forceQuote),
    detail: column.type,
  }));
}

export function identifierText(engine: string, name: string): string {
  return sqlIdentifierCompletionApply(engine, name) ?? name;
}

export function allColumnsOption(
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

export function insertAllColumnsOption(engine: string, columns: DbColumnDescription[]): Completion {
  return {
    label: "All columns — insert column list",
    type: "text",
    detail: `${columns.length} columns`,
    boost: 70,
    apply: columns.map((column) => identifierText(engine, column.name)).join(", "),
  };
}
