import type { Completion } from "@codemirror/autocomplete";
import type { DbColumnDescription, DbForeignKey } from "../ipc";
import { type NamedTableRef, type TableRef } from "./types";
import { identifierText } from "./options";
import { equalsName } from "./parsing";

export function singularTableName(name: string): string {
  const lower = name.toLocaleLowerCase();
  if (lower.endsWith("ies") && lower.length > 3) return `${lower.slice(0, -3)}y`;
  if (lower.endsWith("ses") && lower.length > 3) return lower.slice(0, -2);
  if (lower.endsWith("s") && lower.length > 1) return lower.slice(0, -1);
  return lower;
}

export function joinPredicateOptions(
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
