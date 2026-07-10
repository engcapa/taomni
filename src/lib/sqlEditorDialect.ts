import {
  MSSQL,
  MySQL,
  PLSQL,
  PostgreSQL,
  SQLDialect,
  StandardSQL,
} from "@codemirror/lang-sql";
import { asSqlEngine, quoteIdent } from "./sqlDialect";

const OracleSQL = SQLDialect.define({
  ...PLSQL.spec,
  doubleQuotedStrings: false,
  identifierQuotes: "\"",
});

const ClickHouseSQL = SQLDialect.define({
  ...StandardSQL.spec,
  identifierQuotes: "`\"",
});

const keywordSets = new WeakMap<SQLDialect, Set<string>>();

function keywordSet(dialect: SQLDialect): Set<string> {
  const cached = keywordSets.get(dialect);
  if (cached) return cached;
  const keywords = new Set(
    (dialect.spec.keywords ?? "")
      .split(/\s+/)
      .filter(Boolean)
      .map((keyword) => keyword.toLowerCase()),
  );
  keywordSets.set(dialect, keywords);
  return keywords;
}

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
      return ClickHouseSQL;
    case "Presto":
    default:
      return StandardSQL;
  }
}

function hasSafeUnquotedCase(engine: string, name: string): boolean {
  const standardIdentifier = /^[\p{L}_][\p{L}\p{N}\p{M}_$]*$/u.test(name);
  if (engine === "PostgreSQL" || engine === "PanWeiDB" || engine === "Presto") {
    return standardIdentifier && name === name.toLocaleLowerCase();
  }
  if (engine === "Oracle") {
    return /^[\p{L}_][\p{L}\p{N}\p{M}_$#]*$/u.test(name)
      && name === name.toLocaleUpperCase();
  }
  return /^[\p{L}_][\p{L}\p{N}\p{M}_$#@]*$/u.test(name);
}

/**
 * Text to insert for a metadata identifier. Ordinary identifiers keep their
 * readable form; reserved, mixed-case, or otherwise unsafe names are quoted.
 */
export function sqlIdentifierCompletionApply(
  engine: string,
  name: string,
  forceQuote = false,
): string | undefined {
  const needsQuote = forceQuote
    || !hasSafeUnquotedCase(engine, name)
    || keywordSet(codeMirrorSqlDialect(engine)).has(name.toLowerCase());
  return needsQuote ? quoteIdent(asSqlEngine(engine), name) : undefined;
}
