import { EditorState } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import { MSSQL, MySQL, PostgreSQL, StandardSQL } from "@codemirror/lang-sql";
import { describe, expect, it } from "vitest";
import { codeMirrorSqlDialect } from "./sqlEditorDialect";

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
    expect(codeMirrorSqlDialect("ClickHouse")).toBe(StandardSQL);
    expect(codeMirrorSqlDialect("Presto")).toBe(StandardSQL);
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
});
