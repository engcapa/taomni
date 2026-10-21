import type { DbResultSqlRewriteRequest } from "../../../lib/ipc";
import { asSqlEngine, quoteIdent as dialectQuoteIdent, sqlLiteral as dialectSqlLiteral, type SqlEngine } from "../../../lib/sqlDialect";
import { filterValueKey } from "./model";
import { type GeneratedResultSqlOptions } from "./types";


export function stripSqlTerminator(sql: string): string {
  return sql.trim().replace(/;+\s*$/, "");
}


export function sqlWithTerminator(sql: string): string {
  return `${stripSqlTerminator(sql)};`;
}


export function sqlTextExpression(engine: SqlEngine, expression: string): string {
  switch (engine) {
    case "MySQL":
    case "StarRocks":
      return `CAST(${expression} AS CHAR)`;
    case "PostgreSQL":
    case "PanWeiDB":
      return `${expression}::text`;
    case "Oracle":
      return `CAST(${expression} AS VARCHAR2(4000))`;
    case "SQLServer":
      return `CAST(${expression} AS NVARCHAR(MAX))`;
    case "ClickHouse":
      return `toString(${expression})`;
    case "Presto":
      return `CAST(${expression} AS VARCHAR)`;
  }
}


export function escapeLikePattern(value: string): string {
  return value.replace(/[!%_]/g, (char) => `!${char}`);
}


export function sqlLikeCondition(expression: string, value: string): string {
  return `${expression} LIKE ${dialectSqlLiteral(`%${escapeLikePattern(value)}%`)} ESCAPE '!'`;
}


export function uniqueFilterValues(values: (string | null)[]): (string | null)[] {
  const seen = new Set<string>();
  const unique: (string | null)[] = [];
  for (const value of values) {
    const key = filterValueKey(value);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(value);
  }
  return unique;
}


export function selectedValuesCondition(columnSql: string, values: (string | null)[]): string | null {
  const unique = uniqueFilterValues(values);
  const nonNull = unique.filter((value): value is string => value !== null);
  const clauses: string[] = [];
  if (nonNull.length === 1) {
    clauses.push(`${columnSql} = ${dialectSqlLiteral(nonNull[0])}`);
  } else if (nonNull.length > 1) {
    clauses.push(`${columnSql} IN (${nonNull.map((value) => dialectSqlLiteral(value)).join(", ")})`);
  }
  if (unique.some((value) => value === null)) clauses.push(`${columnSql} IS NULL`);
  if (clauses.length === 0) return null;
  return clauses.length === 1 ? clauses[0] : `(${clauses.join(" OR ")})`;
}


export function isIdentChar(char: string | undefined): boolean {
  return !!char && /[A-Za-z0-9_$]/.test(char);
}


export function keywordMatchAt(sql: string, index: number, pattern: RegExp): number {
  if (isIdentChar(sql[index - 1])) return 0;
  const match = sql.slice(index).match(pattern);
  if (!match) return 0;
  const end = index + match[0].length;
  return isIdentChar(sql[end]) ? 0 : match[0].length;
}


export function topLevelSqlClauses(sql: string): Record<string, number> {
  const clauses: Record<string, number> = {};
  let depth = 0;
  let singleQuoted = false;
  let doubleQuoted = false;
  let backtickQuoted = false;
  let bracketQuoted = false;
  let lineComment = false;
  let blockComment = false;

  for (let i = 0; i < sql.length; i += 1) {
    const ch = sql[i];
    const next = sql[i + 1];

    if (lineComment) {
      if (ch === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (ch === "*" && next === "/") {
        blockComment = false;
        i += 1;
      }
      continue;
    }
    if (singleQuoted) {
      if (ch === "'" && next === "'") i += 1;
      else if (ch === "'") singleQuoted = false;
      continue;
    }
    if (doubleQuoted) {
      if (ch === "\"" && next === "\"") i += 1;
      else if (ch === "\"") doubleQuoted = false;
      continue;
    }
    if (backtickQuoted) {
      if (ch === "`" && next === "`") i += 1;
      else if (ch === "`") backtickQuoted = false;
      continue;
    }
    if (bracketQuoted) {
      if (ch === "]" && next === "]") i += 1;
      else if (ch === "]") bracketQuoted = false;
      continue;
    }

    if (ch === "-" && next === "-") {
      lineComment = true;
      i += 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      blockComment = true;
      i += 1;
      continue;
    }
    if (ch === "'") {
      singleQuoted = true;
      continue;
    }
    if (ch === "\"") {
      doubleQuoted = true;
      continue;
    }
    if (ch === "`") {
      backtickQuoted = true;
      continue;
    }
    if (ch === "[") {
      bracketQuoted = true;
      continue;
    }
    if (ch === "(") {
      depth += 1;
      continue;
    }
    if (ch === ")") {
      depth = Math.max(0, depth - 1);
      continue;
    }

    if (depth !== 0) continue;
    const checks: Array<[string, RegExp]> = [
      ["select", /^select\b/i],
      ["from", /^from\b/i],
      ["where", /^where\b/i],
      ["groupBy", /^group\s+by\b/i],
      ["having", /^having\b/i],
      ["orderBy", /^order\s+by\b/i],
      ["limit", /^limit\b/i],
      ["offset", /^offset\b/i],
      ["fetch", /^fetch\b/i],
      ["for", /^for\b/i],
      ["union", /^union\b/i],
      ["intersect", /^intersect\b/i],
      ["except", /^except\b/i],
    ];
    for (const [name, pattern] of checks) {
      if (clauses[name] !== undefined) continue;
      if (keywordMatchAt(sql, i, pattern) > 0) clauses[name] = i;
    }
  }
  return clauses;
}


export function firstClauseAfter(clauses: Record<string, number>, names: string[], after = -1): number | null {
  const indexes = names
    .map((name) => clauses[name])
    .filter((index): index is number => index !== undefined && index > after);
  return indexes.length > 0 ? Math.min(...indexes) : null;
}


export function selectListContainsTopLevelStar(sql: string, clauses: Record<string, number>): boolean {
  const selectStart = clauses.select;
  const fromStart = clauses.from;
  if (selectStart === undefined || fromStart === undefined || fromStart <= selectStart) return false;
  const list = sql.slice(selectStart + "select".length, fromStart);
  let depth = 0;
  let singleQuoted = false;
  let doubleQuoted = false;
  let backtickQuoted = false;
  let bracketQuoted = false;
  for (let i = 0; i < list.length; i += 1) {
    const ch = list[i];
    const next = list[i + 1];
    if (singleQuoted) {
      if (ch === "'" && next === "'") i += 1;
      else if (ch === "'") singleQuoted = false;
      continue;
    }
    if (doubleQuoted) {
      if (ch === "\"" && next === "\"") i += 1;
      else if (ch === "\"") doubleQuoted = false;
      continue;
    }
    if (backtickQuoted) {
      if (ch === "`" && next === "`") i += 1;
      else if (ch === "`") backtickQuoted = false;
      continue;
    }
    if (bracketQuoted) {
      if (ch === "]" && next === "]") i += 1;
      else if (ch === "]") bracketQuoted = false;
      continue;
    }
    if (ch === "'") singleQuoted = true;
    else if (ch === "\"") doubleQuoted = true;
    else if (ch === "`") backtickQuoted = true;
    else if (ch === "[") bracketQuoted = true;
    else if (ch === "(") depth += 1;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    else if (depth === 0 && ch === "*") return true;
  }
  return false;
}


export function tryBuildInlineResultSql(baseSql: string, whereClauses: string[], orderBy: string): string | null {
  let sql = stripSqlTerminator(baseSql);
  if (!/^\s*select\b/i.test(sql) || /^\s*with\b/i.test(sql)) return null;
  let clauses = topLevelSqlClauses(sql);
  if (
    clauses.select === undefined ||
    clauses.from === undefined ||
    clauses.union !== undefined ||
    clauses.intersect !== undefined ||
    clauses.except !== undefined ||
    clauses.groupBy !== undefined ||
    clauses.having !== undefined ||
    !selectListContainsTopLevelStar(sql, clauses)
  ) {
    return null;
  }

  if (whereClauses.length > 0) {
    const tailStart = firstClauseAfter(clauses, ["orderBy", "limit", "offset", "fetch", "for"]);
    const whereSql = whereClauses.join("\n  AND ");
    if (clauses.where !== undefined) {
      const insertAt = tailStart ?? sql.length;
      sql = `${sql.slice(0, insertAt).trimEnd()}\n  AND ${whereSql}${insertAt < sql.length ? `\n${sql.slice(insertAt).trimStart()}` : ""}`;
    } else {
      const insertAt = tailStart ?? sql.length;
      sql = `${sql.slice(0, insertAt).trimEnd()}\nWHERE ${whereSql}${insertAt < sql.length ? `\n${sql.slice(insertAt).trimStart()}` : ""}`;
    }
    clauses = topLevelSqlClauses(sql);
  }

  if (orderBy) {
    if (clauses.orderBy !== undefined) {
      return null;
    }
    const insertAt = firstClauseAfter(clauses, ["limit", "offset", "fetch", "for"]) ?? sql.length;
    sql = `${sql.slice(0, insertAt).trimEnd()}\n${orderBy}${insertAt < sql.length ? `\n${sql.slice(insertAt).trimStart()}` : ""}`;
  }

  return sqlWithTerminator(sql);
}


export function buildGeneratedResultSql({
  sourceSql,
  sqlEngine,
  columns,
  visibleColumnIndexes,
  globalFilterText,
  columnFilters,
  sorts,
}: GeneratedResultSqlOptions): string | null {
  const baseSql = stripSqlTerminator(sourceSql ?? "");
  if (!baseSql || !sqlEngine) return null;
  const engine = asSqlEngine(sqlEngine);
  const whereClauses: string[] = [];
  const columnSql = (columnIndex: number) =>
    dialectQuoteIdent(engine, columns[columnIndex]?.name || `column_${columnIndex + 1}`);
  const globalNeedle = globalFilterText.trim();
  if (globalNeedle && visibleColumnIndexes.length > 0) {
    whereClauses.push(
      `(${visibleColumnIndexes
        .map((columnIndex) => sqlLikeCondition(sqlTextExpression(engine, columnSql(columnIndex)), globalNeedle))
        .join(" OR ")})`,
    );
  }
  for (const filter of columnFilters) {
    const column = columnSql(filter.columnIndex);
    const selectedCondition = selectedValuesCondition(column, filter.selectedValues);
    if (selectedCondition) {
      whereClauses.push(selectedCondition);
    } else if (filter.text) {
      whereClauses.push(
        filter.mode === "exact"
          ? `${column} = ${dialectSqlLiteral(filter.text)}`
          : sqlLikeCondition(sqlTextExpression(engine, column), filter.text),
      );
    }
  }
  const orderBy =
    sorts.length > 0
      ? `ORDER BY ${sorts.map((sort) => `${columnSql(sort.columnIndex)} ${sort.dir.toUpperCase()}`).join(", ")}`
      : "";
  if (whereClauses.length === 0 && !orderBy) {
    return null;
  }
  const inlineSql = tryBuildInlineResultSql(baseSql, whereClauses, orderBy);
  if (inlineSql) return inlineSql;
  return sqlWithTerminator(baseSql);
}


export function buildResultSqlRewriteRequest({
  sourceSql,
  sqlEngine,
  columns,
  visibleColumnIndexes,
  globalFilterText,
  columnFilters,
  sorts,
}: GeneratedResultSqlOptions): DbResultSqlRewriteRequest | null {
  const baseSql = stripSqlTerminator(sourceSql ?? "");
  if (!baseSql || !sqlEngine) return null;
  if (!globalFilterText.trim() && columnFilters.length === 0 && sorts.length === 0) return null;
  return {
    engine: sqlEngine,
    sourceSql: baseSql,
    resultColumns: columns.map((column) => column.name),
    visibleColumnIndexes,
    globalFilterText,
    filters: columnFilters.map((filter) => ({
      columnIndex: filter.columnIndex,
      text: filter.text,
      mode: filter.mode,
      selectedValues: filter.selectedValues,
    })),
    sorts,
  };
}


export function resultSqlRewriteKey(request: DbResultSqlRewriteRequest | null): string {
  return request ? JSON.stringify(request) : "";
}


export function compactSqlForDisplay(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}
