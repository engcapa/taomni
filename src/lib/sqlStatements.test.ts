import { describe, expect, it } from "vitest";
import {
  splitSqlStatementRanges,
  splitSqlStatements,
  sqlStatementRangeAt,
  sqlStatementsForExecution,
  sqlStatementRangesForExecution,
} from "./sqlStatements";

describe("splitSqlStatements", () => {
  it("splits semicolon-delimited SQL scripts into executable statements", () => {
    expect(
      splitSqlStatements(`
        select * from daas_daat.dim_tag limit 10;

        select * from daas_daat.dim_app limit 10;
      `),
    ).toEqual([
      "select * from daas_daat.dim_tag limit 10",
      "select * from daas_daat.dim_app limit 10",
    ]);
  });

  it("keeps semicolons inside quoted values and comments", () => {
    expect(
      splitSqlStatements(`
        select ';' as literal, "semi;colon" as ident -- comment ; ignored
        from t;
        /* comment ; ignored */ select 'it''s; ok';
      `),
    ).toEqual([
      `select ';' as literal, "semi;colon" as ident -- comment ; ignored
        from t`,
      `/* comment ; ignored */ select 'it''s; ok'`,
    ]);
  });

  it("ignores empty and comment-only statements", () => {
    expect(splitSqlStatements("; /* comment only */ ; -- trailing")).toEqual([]);
  });

  it("splits MySQL scripts for execution into separate result statements", () => {
    expect(sqlStatementsForExecution("MySQL", "select 1; select 2;")).toEqual([
      "select 1",
      "select 2",
    ]);
  });

  it("splits StarRocks scripts for execution like MySQL-compatible sessions", () => {
    expect(sqlStatementsForExecution("StarRocks", "select 1; select 2;")).toEqual([
      "select 1",
      "select 2",
    ]);
  });

  it("continues splitting Presto scripts so each request sends one statement", () => {
    expect(sqlStatementsForExecution("Presto", "select 1; select 2;")).toEqual([
      "select 1",
      "select 2",
    ]);
  });

  it("splits SQL Server scripts while preserving bracketed identifiers", () => {
    expect(sqlStatementsForExecution("SQLServer", "select [a;b] from [dbo].[t]; select 2;")).toEqual([
      "select [a;b] from [dbo].[t]",
      "select 2",
    ]);
  });

  it("splits PostgreSQL scripts so each statement is prepared/executed alone", () => {
    // Backend uses sqlx query()/execute() (extended protocol). PostgreSQL rejects
    // multiple commands in one prepared statement (#403).
    expect(sqlStatementsForExecution("PostgreSQL", "select 1; select 2;")).toEqual([
      "select 1",
      "select 2",
    ]);
    expect(
      sqlStatementsForExecution(
        "PostgreSQL",
        "create table t1(id int);\ncreate table t2(id int);\ndrop table if exists t1;",
      ),
    ).toEqual([
      "create table t1(id int)",
      "create table t2(id int)",
      "drop table if exists t1",
    ]);
  });

  it("splits PanWeiDB scripts like PostgreSQL-compatible sessions", () => {
    expect(sqlStatementsForExecution("PanWeiDB", "select 1; select 2;")).toEqual([
      "select 1",
      "select 2",
    ]);
  });

  it("does not split engines that still rely on backend single-call execution semantics", () => {
    expect(sqlStatementsForExecution("Oracle", "select 1; select 2;")).toEqual([
      "select 1; select 2;",
    ]);
    expect(sqlStatementsForExecution("ClickHouse", "select 1; select 2;")).toEqual([
      "select 1; select 2;",
    ]);
  });

  it("returns source ranges for executable statements", () => {
    const sql = "  select 1;\n\n  select 2;";

    expect(splitSqlStatementRanges(sql)).toEqual([
      { sql: "select 1", from: 2, to: 10 },
      { sql: "select 2", from: 15, to: 23 },
    ]);
  });

  it("keeps semicolons inside PostgreSQL dollar-quoted strings", () => {
    expect(splitSqlStatements("select $$a;b$$ as value; select $tag$c;d$tag$;")).toEqual([
      "select $$a;b$$ as value",
      "select $tag$c;d$tag$",
    ]);
  });

  it("splits SQL Server GO batch separators for execution ranges", () => {
    const sql = "select 1\nGO\nselect [a;b]\nfrom [dbo].[t];";

    expect(sqlStatementRangesForExecution("SQLServer", sql).map((range) => range.sql)).toEqual([
      "select 1",
      "select [a;b]\nfrom [dbo].[t]",
    ]);
  });

  it("resolves the SQL statement under the cursor", () => {
    const sql = "select 1;\n\nselect 2;";

    expect(sqlStatementRangeAt("MySQL", sql, sql.indexOf("2"))).toMatchObject({
      sql: "select 2",
    });
    expect(sqlStatementRangeAt("MySQL", sql, sql.indexOf("\n\n"))).toBeNull();
    expect(sqlStatementRangeAt("PostgreSQL", sql, sql.indexOf("2"))).toMatchObject({
      sql: "select 2",
    });
    expect(sqlStatementRangeAt("PostgreSQL", sql, sql.indexOf("\n\n"))).toBeNull();
  });

  it("keeps PostgreSQL dollar-quoted function bodies intact when splitting for execution", () => {
    const sql = `
CREATE FUNCTION add_one(i int) RETURNS int AS $$
BEGIN
  RETURN i + 1;
END;
$$ LANGUAGE plpgsql;
SELECT add_one(1);
`.trim();

    expect(sqlStatementsForExecution("PostgreSQL", sql)).toEqual([
      `CREATE FUNCTION add_one(i int) RETURNS int AS $$
BEGIN
  RETURN i + 1;
END;
$$ LANGUAGE plpgsql`,
      "SELECT add_one(1)",
    ]);
  });
});
