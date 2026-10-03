// Builds the EXPLAIN statement for the statement under the cursor. EXPLAIN is
// never combined with ANALYZE, so DML is planned but not executed.
import { stripSqlCommentsAndLiterals } from "./sqlDangerousStatements";

export type ExplainPlan = { ok: true; sql: string } | { ok: false; reason: string };

const EXPLAINABLE = new Set(["SELECT", "WITH", "INSERT", "UPDATE", "DELETE", "REPLACE", "VALUES", "TABLE"]);

const UNSUPPORTED_ENGINE: Record<string, string> = {
  Oracle: "Oracle EXPLAIN PLAN needs PLAN_TABLE and DBMS_XPLAN; not supported yet.",
  SQLServer: "SQL Server SHOWPLAN must run in its own batch; not supported yet.",
};

export function explainSqlFor(engine: string, statement: string): ExplainPlan {
  const unsupported = UNSUPPORTED_ENGINE[engine];
  if (unsupported) return { ok: false, reason: unsupported };
  const sql = statement.trim().replace(/;+\s*$/, "").trim();
  const keyword = /^[A-Za-z]+/.exec(stripSqlCommentsAndLiterals(sql).trim())?.[0]?.toUpperCase();
  if (!keyword) return { ok: false, reason: "No SQL statement at the current cursor." };
  if (keyword === "EXPLAIN") return { ok: true, sql };
  if (!EXPLAINABLE.has(keyword)) {
    return { ok: false, reason: "Explain supports SELECT, WITH, INSERT, UPDATE, DELETE and REPLACE statements." };
  }
  return { ok: true, sql: `EXPLAIN ${sql}` };
}
