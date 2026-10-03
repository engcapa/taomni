// Detects statements that should be confirmed before execution: DROP,
// TRUNCATE, and DELETE / UPDATE without a WHERE clause. Comments and quoted
// text are removed first so keywords inside them do not count. A WHERE inside
// a subquery is treated as a WHERE (known, conservative limitation).

export type DangerousStatementReason = "drop" | "truncate" | "delete-without-where" | "update-without-where";

/** Replace comments and quoted literals/identifiers with spaces. */
export function stripSqlCommentsAndLiterals(sql: string): string {
  let out = "";
  let index = 0;
  while (index < sql.length) {
    const char = sql[index];
    const next = sql[index + 1];
    if (char === "-" && next === "-") {
      const end = sql.indexOf("\n", index);
      index = end < 0 ? sql.length : end;
      out += " ";
      continue;
    }
    if (char === "#") {
      const end = sql.indexOf("\n", index);
      index = end < 0 ? sql.length : end;
      out += " ";
      continue;
    }
    if (char === "/" && next === "*") {
      const end = sql.indexOf("*/", index + 2);
      index = end < 0 ? sql.length : end + 2;
      out += " ";
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      let cursor = index + 1;
      while (cursor < sql.length) {
        if (sql[cursor] === char) {
          if (sql[cursor + 1] === char) {
            cursor += 2;
            continue;
          }
          break;
        }
        if (sql[cursor] === "\\" && char === "'") cursor += 1;
        cursor += 1;
      }
      index = cursor + 1;
      out += " ";
      continue;
    }
    out += char;
    index += 1;
  }
  return out;
}

export function dangerousStatementReason(sql: string): DangerousStatementReason | null {
  const text = stripSqlCommentsAndLiterals(sql).trim();
  const keyword = /^[A-Za-z]+/.exec(text)?.[0]?.toUpperCase();
  if (!keyword) return null;
  const hasWhere = /\bwhere\b/i.test(text);
  switch (keyword) {
    case "DROP":
      return "drop";
    case "TRUNCATE":
      return "truncate";
    case "DELETE":
      return hasWhere ? null : "delete-without-where";
    case "UPDATE":
      return hasWhere ? null : "update-without-where";
    default:
      return null;
  }
}

export const DANGEROUS_REASON_LABEL: Record<DangerousStatementReason, string> = {
  drop: "DROP",
  truncate: "TRUNCATE",
  "delete-without-where": "DELETE without WHERE",
  "update-without-where": "UPDATE without WHERE",
};

export function dangerousConfirmationMessage(statements: string[], limit = 10): string | null {
  const flagged = statements
    .map((sql) => ({ sql, reason: dangerousStatementReason(sql) }))
    .filter((item): item is { sql: string; reason: DangerousStatementReason } => item.reason !== null);
  if (flagged.length === 0) return null;
  const lines = flagged
    .slice(0, limit)
    .map((item) => `• [${DANGEROUS_REASON_LABEL[item.reason]}] ${item.sql.replace(/\s+/g, " ").trim()}`);
  if (flagged.length > limit) lines.push(`… and ${flagged.length - limit} more`);
  return `This run contains ${flagged.length} statement${flagged.length === 1 ? "" : "s"} that can remove data:\n${lines.join("\n")}\n\nExecute the whole run?`;
}
