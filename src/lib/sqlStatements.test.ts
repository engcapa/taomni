import { describe, expect, it } from "vitest";
import { splitSqlStatements, sqlStatementsForExecution } from "./sqlStatements";

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

  it("does not split engines that still rely on backend single-call execution semantics", () => {
    expect(sqlStatementsForExecution("PostgreSQL", "select 1; select 2;")).toEqual([
      "select 1; select 2;",
    ]);
  });
});
