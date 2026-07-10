import { EditorState } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import { MSSQL, MySQL, PostgreSQL, StandardSQL } from "@codemirror/lang-sql";
import { describe, expect, it } from "vitest";
import { codeMirrorSqlDialect, sqlIdentifierCompletionApply } from "./sqlEditorDialect";

function parsedNodes(engine: string, doc: string): string {
  const dialect = codeMirrorSqlDialect(engine);
  const state = EditorState.create({ doc, extensions: [dialect.extension] });
  return syntaxTree(state).toString();
}

describe("codeMirrorSqlDialect", () => {
  it("maps compatible engines to their closest CodeMirror dialect", () => {
    expect(codeMirrorSqlDialect("MySQL")).toBe(MySQL);
    expect(codeMirrorSqlDialect("StarRocks")).toBe(MySQL);
    expect(codeMirrorSqlDialect("PostgreSQL")).toBe(PostgreSQL);
    expect(codeMirrorSqlDialect("PanWeiDB")).toBe(PostgreSQL);
    expect(codeMirrorSqlDialect("SQLServer")).toBe(MSSQL);
    expect(codeMirrorSqlDialect("Presto")).toBe(StandardSQL);
    expect(codeMirrorSqlDialect("ClickHouse").spec.identifierQuotes).toContain("`");
  });

  it("parses SQL Server bracketed identifiers", () => {
    expect(parsedNodes("SQLServer", "select [Order Details] from [sales].[orders]")).toContain(
      "QuotedIdentifier",
    );
  });

  it("uses PL/SQL keywords while treating Oracle double quotes as identifiers", () => {
    const dialect = codeMirrorSqlDialect("Oracle");

    expect(dialect.spec.keywords).toContain("pragma");
    expect(dialect.spec.doubleQuotedStrings).toBe(false);
    expect(parsedNodes("Oracle", 'select "Order Details" from "orders"')).toContain(
      "QuotedIdentifier",
    );
  });

  it("quotes unsafe and reserved metadata identifiers for each engine", () => {
    expect(sqlIdentifierCompletionApply("PostgreSQL", "orders")).toBeUndefined();
    expect(sqlIdentifierCompletionApply("PostgreSQL", "订单")).toBeUndefined();
    expect(sqlIdentifierCompletionApply("PostgreSQL", "Order Items")).toBe('"Order Items"');
    expect(sqlIdentifierCompletionApply("PostgreSQL", "order")).toBe('"order"');
    expect(sqlIdentifierCompletionApply("Oracle", "ORDERS")).toBeUndefined();
    expect(sqlIdentifierCompletionApply("Oracle", "Orders")).toBe('"Orders"');
    expect(sqlIdentifierCompletionApply("MySQL", "order")).toBe("`order`");
    expect(sqlIdentifierCompletionApply("SQLServer", "Order Items")).toBe("[Order Items]");
  });
});
