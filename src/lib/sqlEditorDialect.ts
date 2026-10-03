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

function wordSet(value: string): Set<string> {
  return new Set(value.trim().split(/\s+/));
}

const COMMON_RESERVED_IDENTIFIERS = wordSet(`
  all alter and as asc authorization between by case check column constraint
  create cross current_date current_time current_timestamp delete desc distinct
  drop else end except exists false fetch for foreign from full grant group
  having in inner insert intersect into is join key leading left like limit
  natural not null offset on or order outer primary references returning revoke
  right schema select set table then to trailing true union unique update user
  using values view when where with
`);

const POSTGRES_RESERVED_IDENTIFIERS = wordSet(`
  analyse analyze binary collate current_catalog current_role current_schema
  do freeze ilike isnull notnull overlaps placing session_user similar verbose
`);

const ENGINE_RESERVED_IDENTIFIERS: Record<string, Set<string>> = {
  MySQL: wordSet(`
    accessible change database databases delayed div dual explain high_priority
    ignore index keys lock low_priority optimize outfile procedure purge read
    regexp rename replace require rlike show spatial sql ssl straight_join
    trigger unlock unsigned usage utc_date utc_time utc_timestamp write xor zerofill
  `),
  StarRocks: wordSet("database databases explain index keys show"),
  PostgreSQL: POSTGRES_RESERVED_IDENTIFIERS,
  PanWeiDB: POSTGRES_RESERVED_IDENTIFIERS,
  Oracle: wordSet(`
    access audit cluster compress exclusive identified level minus mode noaudit
    nowait number prior public resource row rownum start successful synonym uid
    validate varchar2 whenever
  `),
  SQLServer: wordSet(`
    backup browse bulk clustered compute contains containstable dbcc deny disk
    distributed dump errlvl exec execute file fillfactor freetext freetexttable
    function holdlock identity identity_insert identitycol index kill lineno
    national nocheck nonclustered off offsets open opendatasource openquery
    openrowset openxml percent pivot plan precision proc raiserror readtext
    reconfigure replication restore restrict rowcount rule securityaudit
    semantickeyphrasetable semanticsimilaritydetailstable semanticsimilaritytable
    setuser shutdown statistics system_user tablesample textsize top tran
    transaction trigger truncate try_convert tsequal unpivot updatetext use
    varying waitfor while within writetext
  `),
  ClickHouse: wordSet(`
    attach database databases dictionary engine format materialized optimize
    prewhere sample settings show system ttl
  `),
  Presto: wordSet(`
    array current_catalog current_path current_schema current_user cube grouping
    lateral localtime localtimestamp normalize rollup tablesample unnest
  `),
};

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

function isReservedIdentifier(engine: string, name: string): boolean {
  const lower = name.toLocaleLowerCase();
  return COMMON_RESERVED_IDENTIFIERS.has(lower)
    || ENGINE_RESERVED_IDENTIFIERS[engine]?.has(lower)
    || false;
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
    || isReservedIdentifier(engine, name);
  return needsQuote ? quoteIdent(asSqlEngine(engine), name) : undefined;
}
