import { describe, expect, it } from "vitest";
import { explainSqlFor } from "./sqlExplain";

describe("explainSqlFor", () => {
  it.each(["MySQL", "StarRocks", "PostgreSQL", "PanWeiDB", "ClickHouse", "Presto"])(
    "prefixes EXPLAIN and drops the trailing semicolon for %s",
    (engine) => {
      expect(explainSqlFor(engine, "  select * from t where id = 1;  ")).toEqual({
        ok: true,
        sql: "EXPLAIN select * from t where id = 1",
      });
    },
  );

  it("keeps an existing EXPLAIN and accepts DML and CTEs", () => {
    expect(explainSqlFor("MySQL", "EXPLAIN FORMAT=JSON SELECT 1")).toEqual({ ok: true, sql: "EXPLAIN FORMAT=JSON SELECT 1" });
    expect(explainSqlFor("PostgreSQL", "with x as (select 1) select * from x")).toMatchObject({ ok: true });
    expect(explainSqlFor("MySQL", "/* hint */ delete from t")).toEqual({ ok: true, sql: "EXPLAIN /* hint */ delete from t" });
  });

  it("explains why DDL and unsupported engines cannot be explained", () => {
    expect(explainSqlFor("MySQL", "create table t (id int)")).toEqual({
      ok: false,
      reason: "Explain supports SELECT, WITH, INSERT, UPDATE, DELETE and REPLACE statements.",
    });
    expect(explainSqlFor("Oracle", "select 1 from dual")).toMatchObject({ ok: false, reason: expect.stringContaining("Oracle") });
    expect(explainSqlFor("SQLServer", "select 1")).toMatchObject({ ok: false, reason: expect.stringContaining("SHOWPLAN") });
    expect(explainSqlFor("MySQL", "  ;  ")).toMatchObject({ ok: false });
  });
});
