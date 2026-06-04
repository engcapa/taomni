import { describe, expect, it } from "vitest";
import { splitSqlStatements } from "./sqlStatements";

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
});
