import { describe, expect, it } from "vitest";
import { sqlLocalRelations } from "./sqlLocalRelations";

describe("sqlLocalRelations", () => {
  it("extracts projected and explicitly named CTE columns", () => {
    const relations = sqlLocalRelations(`
      WITH recent AS (
        SELECT o.id, o.total AS amount, count(*) row_count, status state
        FROM orders o
      ), named (customer_id, display_name) AS (
        SELECT id, name FROM customers
      )
      SELECT * FROM recent r
    `);

    expect(relations.get("recent")?.columns).toEqual(["id", "amount", "row_count", "state"]);
    expect(relations.get("named")?.columns).toEqual(["customer_id", "display_name"]);
    expect(relations.get("r")?.columns).toEqual(["id", "amount", "row_count", "state"]);
  });

  it("extracts derived-table aliases and ignores strings and comments", () => {
    const relations = sqlLocalRelations(`
      SELECT d.*
      FROM (
        SELECT id, name AS customer_name, 'from fake' AS note
        FROM customers -- JOIN ignored
      ) AS d
    `);

    expect(relations.get("d")?.columns).toEqual(["id", "customer_name", "note"]);
    expect(relations.has("fake")).toBe(false);
    expect(relations.has("ignored")).toBe(false);
  });

  it("supports quoted and Unicode local identifiers", () => {
    const relations = sqlLocalRelations(`
      WITH "订单汇总" AS (SELECT "订单号", total AS "总额" FROM orders)
      SELECT x.* FROM "订单汇总" x
    `);

    expect(relations.get("订单汇总")?.columns).toEqual(["订单号", "总额"]);
    expect(relations.get("x")?.columns).toEqual(["订单号", "总额"]);
  });
});
