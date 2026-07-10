import { CompletionContext, type CompletionResult } from "@codemirror/autocomplete";
import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { codeMirrorSqlDialect } from "./sqlEditorDialect";
import { createSqlStructuredCompletionSource } from "./sqlStructuredCompletions";

function complete(doc: string, engine = "PostgreSQL"): CompletionResult | null {
  const pos = doc.indexOf("‸");
  const text = doc.replace("‸", "");
  const state = EditorState.create({
    doc: text,
    extensions: [codeMirrorSqlDialect(engine).extension],
  });
  const source = createSqlStructuredCompletionSource({ engine });
  return source(new CompletionContext(state, pos < 0 ? text.length : pos, true)) as CompletionResult | null;
}

const labels = (result: CompletionResult | null) =>
  (result?.options ?? []).map((option) => option.label);

describe("createSqlStructuredCompletionSource", () => {
  it("completes CTE columns through direct names and aliases", () => {
    const direct = complete(`
      WITH recent AS (SELECT id, total AS amount FROM orders)
      SELECT recent.‸ FROM recent
    `);
    const aliased = complete(`
      WITH recent AS (SELECT id, total AS amount FROM orders)
      SELECT r.‸ FROM recent r
    `);

    expect(labels(direct)).toEqual(["* — expand all columns", "amount", "id"]);
    expect(labels(aliased)).toEqual(["* — expand all columns", "amount", "id"]);
  });

  it("completes projected columns from a derived table", () => {
    const result = complete(`
      SELECT d.‸
      FROM (SELECT id, name AS customer_name FROM customers) d
    `);

    expect(labels(result)).toEqual(["* — expand all columns", "customer_name", "id"]);
  });

  it("suggests CTEs in relation positions", () => {
    const result = complete(`
      WITH recent_orders AS (SELECT id FROM orders)
      SELECT * FROM recent_‸
    `);

    expect(labels(result)).toEqual(["recent_orders"]);
    expect(result?.options[0]?.detail).toBe("CTE");
  });

  it("offers engine-aware function snippets in expression positions", () => {
    const postgres = complete("SELECT date_t‸", "PostgreSQL");
    const mysql = complete("SELECT date_f‸", "MySQL");
    const sqlServer = complete("SELECT datea‸", "SQLServer");

    expect(labels(postgres)).toEqual(["DATE_TRUNC"]);
    expect(postgres?.options[0]?.detail).toBe("DATE_TRUNC(precision, timestamp)");
    expect(typeof postgres?.options[0]?.apply).toBe("function");
    expect(labels(mysql)).toEqual(["DATE_FORMAT"]);
    expect(labels(sqlServer)).toEqual(["DATEADD"]);
  });

  it("does not suggest functions inside strings or relation positions", () => {
    expect(complete("SELECT 'cou‸'", "PostgreSQL")).toBeNull();
    expect(complete("SELECT * FROM cou‸", "PostgreSQL")).toBeNull();
  });
});
