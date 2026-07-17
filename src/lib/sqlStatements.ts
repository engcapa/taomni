export interface SqlStatementRange {
  sql: string;
  from: number;
  to: number;
}

interface SplitSqlStatementOptions {
  splitGo?: boolean;
}

function trimRange(sql: string, from: number, to: number): { from: number; to: number; text: string } {
  let start = from;
  let end = to;
  while (start < end && /\s/.test(sql[start])) start += 1;
  while (end > start && /\s/.test(sql[end - 1])) end -= 1;
  return { from: start, to: end, text: sql.slice(start, end) };
}

function dollarQuoteTagAt(sql: string, index: number): string | null {
  if (sql[index] !== "$") return null;
  const rest = sql.slice(index);
  const match = rest.match(/^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/);
  return match?.[0] ?? null;
}

function lineEndIndex(sql: string, index: number): number {
  const nextNewline = sql.indexOf("\n", index);
  return nextNewline === -1 ? sql.length : nextNewline;
}

function isGoBatchSeparatorAt(sql: string, index: number, lineStart: number): boolean {
  if (sql[index]?.toLowerCase() !== "g" || sql[index + 1]?.toLowerCase() !== "o") return false;
  const before = sql.slice(lineStart, index);
  if (!/^[ \t]*$/.test(before)) return false;
  const after = sql.slice(index + 2, lineEndIndex(sql, index + 2));
  return /^[ \t]*$/.test(after);
}

export function splitSqlStatementRanges(
  sql: string,
  options: SplitSqlStatementOptions = {},
): SqlStatementRange[] {
  const statements: SqlStatementRange[] = [];
  let segmentStart = 0;
  let i = 0;
  let lineStart = 0;
  let singleQuoted = false;
  let doubleQuoted = false;
  let backtickQuoted = false;
  let bracketQuoted = false;
  let dollarQuotedTag: string | null = null;
  let lineComment = false;
  let blockComment = false;

  const pushStatement = (from: number, to: number) => {
    const trimmed = trimRange(sql, from, to);
    if (trimmed.text && hasExecutableSql(trimmed.text)) {
      statements.push({
        sql: trimmed.text,
        from: trimmed.from,
        to: trimmed.to,
      });
    }
  };

  const advance = (count = 1) => {
    for (let offset = 0; offset < count; offset += 1) {
      if (sql[i + offset] === "\n") {
        lineStart = i + offset + 1;
      }
    }
    i += count;
  };

  while (i < sql.length) {
    const ch = sql[i];
    const next = sql[i + 1];

    if (dollarQuotedTag) {
      if (sql.startsWith(dollarQuotedTag, i)) {
        advance(dollarQuotedTag.length);
        dollarQuotedTag = null;
      } else {
        advance();
      }
      continue;
    }

    if (lineComment) {
      if (ch === "\n") {
        lineComment = false;
      }
      advance();
      continue;
    }

    if (blockComment) {
      if (ch === "*" && next === "/") {
        advance(2);
        blockComment = false;
      } else {
        advance();
      }
      continue;
    }

    if (singleQuoted) {
      if (ch === "'" && next === "'") {
        advance(2);
      } else {
        if (ch === "'") {
          singleQuoted = false;
        }
        advance();
      }
      continue;
    }

    if (doubleQuoted) {
      if (ch === "\"" && next === "\"") {
        advance(2);
      } else {
        if (ch === "\"") {
          doubleQuoted = false;
        }
        advance();
      }
      continue;
    }

    if (backtickQuoted) {
      if (ch === "`" && next === "`") {
        advance(2);
      } else {
        if (ch === "`") {
          backtickQuoted = false;
        }
        advance();
      }
      continue;
    }

    if (bracketQuoted) {
      if (ch === "]" && next === "]") {
        advance(2);
      } else {
        if (ch === "]") {
          bracketQuoted = false;
        }
        advance();
      }
      continue;
    }

    if (options.splitGo && isGoBatchSeparatorAt(sql, i, lineStart)) {
      pushStatement(segmentStart, lineStart);
      const end = lineEndIndex(sql, i);
      i = end;
      if (sql[i] === "\n") {
        i += 1;
      }
      lineStart = i;
      segmentStart = i;
      continue;
    }

    if (ch === "-" && next === "-") {
      lineComment = true;
      advance(2);
      continue;
    }

    if (ch === "/" && next === "*") {
      blockComment = true;
      advance(2);
      continue;
    }

    if (ch === "'") {
      singleQuoted = true;
      advance();
      continue;
    }

    if (ch === "\"") {
      doubleQuoted = true;
      advance();
      continue;
    }

    if (ch === "`") {
      backtickQuoted = true;
      advance();
      continue;
    }

    if (ch === "[") {
      bracketQuoted = true;
      advance();
      continue;
    }

    const dollarTag = dollarQuoteTagAt(sql, i);
    if (dollarTag) {
      dollarQuotedTag = dollarTag;
      advance(dollarTag.length);
      continue;
    }

    if (ch === ";") {
      pushStatement(segmentStart, i);
      advance();
      segmentStart = i;
      continue;
    }

    advance();
  }

  pushStatement(segmentStart, sql.length);
  return statements;
}

export function splitSqlStatements(sql: string): string[] {
  return splitSqlStatementRanges(sql).map((statement) => statement.sql);
}

export function sqlStatementsForExecution(engine: string, sql: string): string[] {
  return sqlStatementRangesForExecution(engine, sql).map((statement) => statement.sql);
}

export function sqlStatementRangesForExecution(engine: string, sql: string): SqlStatementRange[] {
  const trimmed = sql.trim();
  if (!trimmed) return [];
  if (shouldSplitSqlForExecution(engine)) {
    return splitSqlStatementRanges(sql, { splitGo: engine === "SQLServer" });
  }
  const trimmedRange = trimRange(sql, 0, sql.length);
  return trimmedRange.text && hasExecutableSql(trimmedRange.text)
    ? [{ sql: trimmedRange.text, from: trimmedRange.from, to: trimmedRange.to }]
    : [];
}

export function selectedSqlStatementRange(sql: string, from: number, to: number): SqlStatementRange | null {
  const start = Math.max(0, Math.min(from, to, sql.length));
  const end = Math.max(0, Math.min(Math.max(from, to), sql.length));
  const trimmed = trimRange(sql, start, end);
  return trimmed.text && hasExecutableSql(trimmed.text)
    ? { sql: trimmed.text, from: trimmed.from, to: trimmed.to }
    : null;
}

export function sqlStatementRangeAt(engine: string, sql: string, position: number): SqlStatementRange | null {
  const ranges = sqlStatementRangesForExecution(engine, sql);
  if (ranges.length === 0) return null;
  const clamped = Math.max(0, Math.min(position, sql.length));
  const containing = ranges.find((range) => range.from <= clamped && clamped <= range.to);
  if (containing) return containing;
  return ranges.length === 1 ? ranges[0] : null;
}

function shouldSplitSqlForExecution(engine: string): boolean {
  // Engines that reject multi-command prepared statements (or prefer one statement
  // per request) must be split on the client before execute/stream.
  // PostgreSQL / PanWeiDB: sqlx extended protocol → "cannot insert multiple commands
  // into a prepared statement" for batch DDL/DML scripts (#403).
  return (
    engine === "MySQL" ||
    engine === "StarRocks" ||
    engine === "SQLServer" ||
    engine === "Presto" ||
    engine === "PostgreSQL" ||
    engine === "PanWeiDB"
  );
}

function hasExecutableSql(statement: string): boolean {
  let i = 0;
  while (i < statement.length) {
    const ch = statement[i];
    const next = statement[i + 1];
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    if (ch === "-" && next === "-") {
      i += 2;
      while (i < statement.length && statement[i] !== "\n") {
        i += 1;
      }
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < statement.length && !(statement[i] === "*" && statement[i + 1] === "/")) {
        i += 1;
      }
      i = Math.min(statement.length, i + 2);
      continue;
    }
    return true;
  }
  return false;
}
