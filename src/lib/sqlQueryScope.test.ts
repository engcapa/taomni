import { describe, expect, it } from "vitest";
import { sqlSelectListScope } from "./sqlQueryScope";

function scope(markedSql: string) {
  const cursor = markedSql.indexOf("‸");
  const sql = markedSql.replace("‸", "");
  return sqlSelectListScope(sql, cursor);
}

describe("sqlSelectListScope", () => {
  it("reads a downstream FROM relation while the cursor is in the select list", () => {
    expect(scope("SELECT ‸ FROM sales.orders AS o")).toMatchObject({
      queryDepth: 0,
      relations: [{ kind: "named", parts: ["sales", "orders"], qualifier: "o" }],
    });
  });

  it("collects JOIN and comma relations in source order", () => {
    expect(scope(`
      SELECT ‸
      FROM orders o, tenants t
      LEFT JOIN public.customers AS c ON c.tenant_id = t.id
      WHERE o.customer_id = c.id
    `)?.relations).toEqual([
      { kind: "named", parts: ["orders"], qualifier: "o" },
      { kind: "named", parts: ["tenants"], qualifier: "t" },
      { kind: "named", parts: ["public", "customers"], qualifier: "c" },
    ]);
  });

  it("tracks quoted catalog, schema, table, and alias identifiers", () => {
    expect(scope('SELECT ‸ FROM "lake house".`sales-data`.[Order Items] AS "order row"')?.relations)
      .toEqual([{
        kind: "named",
        parts: ["lake house", "sales-data", "Order Items"],
        qualifier: "order row",
      }]);
  });

  it("returns a derived-table alias without treating its inner source as a peer", () => {
    expect(scope("SELECT ‸ FROM (SELECT id FROM orders) AS recent")?.relations).toEqual([
      { kind: "derived", parts: [], qualifier: "recent" },
    ]);
  });

  it("keeps CTE references available as named relations", () => {
    expect(scope(`
      WITH recent AS (SELECT id, total FROM orders)
      SELECT ‸ FROM recent r
    `)?.relations).toEqual([
      { kind: "named", parts: ["recent"], qualifier: "r" },
    ]);
  });

  it("selects the innermost query block at the cursor", () => {
    const sql = "SELECT id, (SELECT ‸ FROM line_items li) FROM orders o";
    expect(scope(sql)).toMatchObject({
      queryDepth: 1,
      relations: [{ kind: "named", parts: ["line_items"], qualifier: "li" }],
    });
  });

  it("allows expression parentheses inside a select list", () => {
    expect(scope("SELECT COALESCE(‸, 0) FROM orders o")?.relations).toEqual([
      { kind: "named", parts: ["orders"], qualifier: "o" },
    ]);
  });

  it("ignores keywords and parentheses inside strings and comments", () => {
    expect(scope(`
      SELECT CONCAT('FROM fake)', ‸) /* JOIN ignored */
      FROM orders o -- JOIN hidden h
    `)?.relations).toEqual([
      { kind: "named", parts: ["orders"], qualifier: "o" },
    ]);
  });

  it("does not return a select-list scope after FROM or across statements", () => {
    expect(scope("SELECT id FROM ‸orders")).toBeNull();
    expect(scope("SELECT id FROM orders; SELECT ‸")).toBeNull();
  });
});
