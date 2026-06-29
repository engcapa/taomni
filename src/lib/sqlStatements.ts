export function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = "";
  let i = 0;
  let singleQuoted = false;
  let doubleQuoted = false;
  let backtickQuoted = false;
  let bracketQuoted = false;
  let lineComment = false;
  let blockComment = false;

  const pushStatement = () => {
    const statement = current.trim();
    if (statement && hasExecutableSql(statement)) {
      statements.push(statement);
    }
    current = "";
  };

  while (i < sql.length) {
    const ch = sql[i];
    const next = sql[i + 1];

    if (lineComment) {
      current += ch;
      if (ch === "\n") {
        lineComment = false;
      }
      i += 1;
      continue;
    }

    if (blockComment) {
      current += ch;
      if (ch === "*" && next === "/") {
        current += next;
        i += 2;
        blockComment = false;
      } else {
        i += 1;
      }
      continue;
    }

    if (singleQuoted) {
      current += ch;
      if (ch === "'" && next === "'") {
        current += next;
        i += 2;
      } else {
        if (ch === "'") {
          singleQuoted = false;
        }
        i += 1;
      }
      continue;
    }

    if (doubleQuoted) {
      current += ch;
      if (ch === "\"" && next === "\"") {
        current += next;
        i += 2;
      } else {
        if (ch === "\"") {
          doubleQuoted = false;
        }
        i += 1;
      }
      continue;
    }

    if (backtickQuoted) {
      current += ch;
      if (ch === "`" && next === "`") {
        current += next;
        i += 2;
      } else {
        if (ch === "`") {
          backtickQuoted = false;
        }
        i += 1;
      }
      continue;
    }

    if (bracketQuoted) {
      current += ch;
      if (ch === "]" && next === "]") {
        current += next;
        i += 2;
      } else {
        if (ch === "]") {
          bracketQuoted = false;
        }
        i += 1;
      }
      continue;
    }

    if (ch === "-" && next === "-") {
      current += ch + next;
      lineComment = true;
      i += 2;
      continue;
    }

    if (ch === "/" && next === "*") {
      current += ch + next;
      blockComment = true;
      i += 2;
      continue;
    }

    if (ch === "'") {
      current += ch;
      singleQuoted = true;
      i += 1;
      continue;
    }

    if (ch === "\"") {
      current += ch;
      doubleQuoted = true;
      i += 1;
      continue;
    }

    if (ch === "`") {
      current += ch;
      backtickQuoted = true;
      i += 1;
      continue;
    }

    if (ch === "[") {
      current += ch;
      bracketQuoted = true;
      i += 1;
      continue;
    }

    if (ch === ";") {
      pushStatement();
      i += 1;
      continue;
    }

    current += ch;
    i += 1;
  }

  pushStatement();
  return statements;
}

export function sqlStatementsForExecution(engine: string, sql: string): string[] {
  const trimmed = sql.trim();
  if (!trimmed) return [];
  return shouldSplitSqlForExecution(engine) ? splitSqlStatements(trimmed) : [trimmed];
}

function shouldSplitSqlForExecution(engine: string): boolean {
  return engine === "MySQL" || engine === "StarRocks" || engine === "SQLServer" || engine === "Presto";
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
