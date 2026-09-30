import { asSqlEngine, quoteIdent, sqlLiteral } from "./sqlDialect";

/** A pending grid row edit, structurally matching `QueryGridRowChange`. */
export interface GridRowChange {
  status: "inserted" | "updated" | "deleted";
  values: (string | null)[];
  original: (string | null)[] | null;
}

export interface GridChangeCounts {
  inserted: number;
  updated: number;
  deleted: number;
}

export interface GridChangeStatements {
  statements: string[];
  /** True when UPDATE / DELETE rows are matched on every result column. */
  whereUsesAllColumns: boolean;
}

/** What the save confirmation shows before the DML runs (DB-EDIT-001). */
export interface GridChangePreview {
  statements: string[];
  warning: string | null;
}

export const NO_PRIMARY_KEY_WARNING =
  "No primary key found: UPDATE and DELETE match rows on every column and may change more than one row.";

export const MAX_PREVIEW_STATEMENTS = 20;

function whereForColumns(engine: string, columns: string[], allColumns: string[], values: (string | null)[]): string {
  const clauses = columns.map((column) => {
    const index = allColumns.findIndex((name) => name === column);
    const value = index >= 0 ? values[index] : null;
    const ident = quoteIdent(asSqlEngine(engine), column);
    return value === null ? `${ident} IS NULL` : `${ident} = ${sqlLiteral(value)}`;
  });
  return clauses.length > 0 ? clauses.join(" AND ") : "1 = 0";
}

/**
 * Generate the DML for grid edits. Rows are matched on the primary key when
 * the result contains it, otherwise on every result column.
 */
export function buildGridChangeStatements(options: {
  engine: string;
  tableName: string;
  columns: string[];
  primaryKeys: string[];
  changes: GridRowChange[];
}): GridChangeStatements {
  const { engine, tableName, columns, changes } = options;
  const quote = (name: string) => quoteIdent(asSqlEngine(engine), name);
  const primaryKeys = options.primaryKeys.filter((name) => columns.includes(name));
  const whereColumns = primaryKeys.length > 0 ? primaryKeys : columns;
  const statements: string[] = [];
  let matchesRows = false;
  for (const change of changes) {
    if (change.status === "inserted") {
      const cols = columns.map(quote).join(", ");
      const values = change.values.map(sqlLiteral).join(", ");
      statements.push(`INSERT INTO ${tableName} (${cols}) VALUES (${values})`);
    } else if (change.status === "updated") {
      if (!change.original) continue;
      const assignments = columns
        .map((name, index) =>
          change.values[index] === change.original?.[index] ? null : `${quote(name)} = ${sqlLiteral(change.values[index])}`,
        )
        .filter((value): value is string => Boolean(value));
      if (assignments.length === 0) continue;
      const where = whereForColumns(engine, whereColumns, columns, change.original);
      statements.push(`UPDATE ${tableName} SET ${assignments.join(", ")} WHERE ${where}`);
      matchesRows = true;
    } else if (change.status === "deleted") {
      if (!change.original) continue;
      const where = whereForColumns(engine, whereColumns, columns, change.original);
      statements.push(`DELETE FROM ${tableName} WHERE ${where}`);
      matchesRows = true;
    }
  }
  return { statements, whereUsesAllColumns: matchesRows && primaryKeys.length === 0 };
}

export function gridChangePreview(generated: GridChangeStatements): GridChangePreview {
  return {
    statements: generated.statements,
    warning: generated.whereUsesAllColumns ? NO_PRIMARY_KEY_WARNING : null,
  };
}

/** Save-confirmation text: counts, the no-key warning and the SQL to run. */
export function gridChangeConfirmMessage(counts: GridChangeCounts, preview: GridChangePreview | null): string {
  const lines = [
    "Apply grid changes to the database?",
    "",
    `Added: ${counts.inserted}`,
    `Modified: ${counts.updated}`,
    `Deleted: ${counts.deleted}`,
  ];
  if (!preview) return lines.join("\n");
  if (preview.warning) lines.push("", `⚠ ${preview.warning}`);
  const shown = preview.statements.slice(0, MAX_PREVIEW_STATEMENTS);
  lines.push("", `SQL to execute (${preview.statements.length}):`, ...shown.map((sql) => `${sql};`));
  const hidden = preview.statements.length - shown.length;
  if (hidden > 0) lines.push(`… and ${hidden} more`);
  return lines.join("\n");
}
