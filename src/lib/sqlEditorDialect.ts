import {
  MSSQL,
  MySQL,
  PLSQL,
  PostgreSQL,
  SQLDialect,
  StandardSQL,
} from "@codemirror/lang-sql";

const OracleSQL = SQLDialect.define({
  ...PLSQL.spec,
  doubleQuotedStrings: false,
  identifierQuotes: "\"",
});

/** CodeMirror SQL grammar and keyword set used by each database engine. */
export function codeMirrorSqlDialect(engine: string): SQLDialect {
  switch (engine) {
    case "MySQL":
    case "StarRocks":
      return MySQL;
    case "PostgreSQL":
    case "PanWeiDB":
      return PostgreSQL;
    case "Oracle":
      return OracleSQL;
    case "SQLServer":
      return MSSQL;
    case "ClickHouse":
    case "Presto":
    default:
      return StandardSQL;
  }
}
