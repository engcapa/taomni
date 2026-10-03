export interface SqlLocalRelation {
  name: string;
  columns: string[];
  kind: "cte" | "derived";
}

interface SqlToken {
  kind: "identifier" | "literal" | "symbol";
  text: string;
  lower: string;
}

const RELATION_END_WORDS = new Set([
  "where",
  "group",
  "having",
  "order",
  "limit",
  "offset",
  "fetch",
  "join",
  "inner",
  "left",
  "right",
  "full",
  "cross",
  "on",
  "using",
  "union",
]);

function unquoteIdentifier(text: string): string {
  if (text.startsWith('"')) return text.slice(1, -1).replace(/""/g, '"');
  if (text.startsWith("`")) return text.slice(1, -1).replace(/``/g, "`");
  if (text.startsWith("[")) return text.slice(1, -1).replace(/\]\]/g, "]");
  return text;
}

function dollarQuoteTagAt(sql: string, index: number): string | null {
  return sql.slice(index).match(/^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/)?.[0] ?? null;
}

function tokenize(sql: string): SqlToken[] {
  const tokens: SqlToken[] = [];
  let index = 0;

  const push = (kind: SqlToken["kind"], text: string) => {
    const value = kind === "identifier" ? unquoteIdentifier(text) : text;
    tokens.push({ kind, text: value, lower: value.toLocaleLowerCase() });
  };

  while (index < sql.length) {
    const char = sql[index];
    const next = sql[index + 1];
    if (/\s/u.test(char)) {
      index += 1;
      continue;
    }
    if (char === "-" && next === "-") {
      index += 2;
      while (index < sql.length && sql[index] !== "\n") index += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      index += 2;
      while (index < sql.length && !(sql[index] === "*" && sql[index + 1] === "/")) index += 1;
      index = Math.min(sql.length, index + 2);
      continue;
    }
    const dollarTag = char === "$" ? dollarQuoteTagAt(sql, index) : null;
    if (dollarTag) {
      const end = sql.indexOf(dollarTag, index + dollarTag.length);
      index = end < 0 ? sql.length : end + dollarTag.length;
      push("literal", "literal");
      continue;
    }
    if (char === "'") {
      index += 1;
      while (index < sql.length) {
        if (sql[index] === "'" && sql[index + 1] === "'") {
          index += 2;
        } else if (sql[index] === "'") {
          index += 1;
          break;
        } else {
          index += 1;
        }
      }
      push("literal", "literal");
      continue;
    }
    if (char === '"' || char === "`" || char === "[") {
      const close = char === "[" ? "]" : char;
      const start = index;
      index += 1;
      while (index < sql.length) {
        if (sql[index] === close && sql[index + 1] === close) {
          index += 2;
        } else if (sql[index] === close) {
          index += 1;
          break;
        } else {
          index += 1;
        }
      }
      push("identifier", sql.slice(start, index));
      continue;
    }
    if (/^[\p{L}\p{N}\p{M}_$#@]$/u.test(char)) {
      const start = index;
      index += 1;
      while (index < sql.length && /^[\p{L}\p{N}\p{M}_$#@]$/u.test(sql[index])) index += 1;
      push("identifier", sql.slice(start, index));
      continue;
    }
    push("symbol", char);
    index += 1;
  }
  return tokens;
}

function matchingParen(tokens: SqlToken[], open: number, end = tokens.length): number {
  let depth = 0;
  for (let index = open; index < end; index += 1) {
    if (tokens[index].text === "(") depth += 1;
    if (tokens[index].text === ")") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function splitTopLevel(tokens: SqlToken[], start: number, end: number): SqlToken[][] {
  const parts: SqlToken[][] = [];
  let partStart = start;
  let depth = 0;
  for (let index = start; index < end; index += 1) {
    if (tokens[index].text === "(") depth += 1;
    if (tokens[index].text === ")") depth -= 1;
    if (tokens[index].text === "," && depth === 0) {
      parts.push(tokens.slice(partStart, index));
      partStart = index + 1;
    }
  }
  parts.push(tokens.slice(partStart, end));
  return parts;
}

function inferredColumn(expression: SqlToken[]): string | null {
  const tokens = expression.filter((token) => token.text !== ";");
  while (tokens[0]?.lower === "distinct" || tokens[0]?.lower === "all") tokens.shift();
  if (tokens.length === 0) return null;

  let depth = 0;
  let asIndex = -1;
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index].text === "(") depth += 1;
    if (tokens[index].text === ")") depth -= 1;
    if (depth === 0 && tokens[index].lower === "as") asIndex = index;
  }
  if (asIndex >= 0 && tokens[asIndex + 1]?.kind === "identifier") {
    return tokens[asIndex + 1].text;
  }
  const last = tokens.at(-1);
  if (!last || last.kind !== "identifier") return null;
  if (tokens.length === 1) return last.text;
  if (tokens.at(-2)?.text === ".") return last.text;
  if (tokens.at(-2)?.text === ")") return last.text;
  if (tokens.at(-2)?.kind === "identifier") return last.text;
  if (tokens.some((token) => token.text === "*")) return null;
  return null;
}

function selectColumns(tokens: SqlToken[], start: number, end: number): string[] {
  let depth = 0;
  let select = -1;
  for (let index = start; index < end; index += 1) {
    if (tokens[index].text === "(") depth += 1;
    if (tokens[index].text === ")") depth -= 1;
    if (depth === 0 && tokens[index].lower === "select") {
      select = index;
      break;
    }
  }
  if (select < 0) return [];

  depth = 0;
  let from = end;
  for (let index = select + 1; index < end; index += 1) {
    if (tokens[index].text === "(") depth += 1;
    if (tokens[index].text === ")") depth -= 1;
    if (depth === 0 && tokens[index].lower === "from") {
      from = index;
      break;
    }
  }

  const columns = splitTopLevel(tokens, select + 1, from)
    .map(inferredColumn)
    .filter((column): column is string => Boolean(column));
  return Array.from(new Set(columns));
}

function explicitColumnList(tokens: SqlToken[], open: number, close: number): string[] {
  return splitTopLevel(tokens, open + 1, close)
    .map((part) => part.find((token) => token.kind === "identifier")?.text ?? null)
    .filter((column): column is string => Boolean(column));
}

function addRelation(
  relations: Map<string, SqlLocalRelation>,
  relation: SqlLocalRelation,
): void {
  if (relation.name && relation.columns.length > 0) {
    relations.set(relation.name.toLocaleLowerCase(), relation);
  }
}

/** Extract CTEs, derived-table aliases, and their projected column names. */
export function sqlLocalRelations(sql: string): Map<string, SqlLocalRelation> {
  const tokens = tokenize(sql);
  const relations = new Map<string, SqlLocalRelation>();

  let cursor = tokens[0]?.lower === "with" ? 1 : -1;
  if (cursor >= 0 && tokens[cursor]?.lower === "recursive") cursor += 1;
  while (cursor >= 0 && cursor < tokens.length && tokens[cursor]?.kind === "identifier") {
    const name = tokens[cursor].text;
    cursor += 1;
    let explicitColumns: string[] = [];
    if (tokens[cursor]?.text === "(") {
      const close = matchingParen(tokens, cursor);
      if (close < 0) break;
      explicitColumns = explicitColumnList(tokens, cursor, close);
      cursor = close + 1;
    }
    if (tokens[cursor]?.lower !== "as" || tokens[cursor + 1]?.text !== "(") break;
    const open = cursor + 1;
    const close = matchingParen(tokens, open);
    if (close < 0) break;
    addRelation(relations, {
      name,
      columns: explicitColumns.length > 0 ? explicitColumns : selectColumns(tokens, open + 1, close),
      kind: "cte",
    });
    cursor = close + 1;
    if (tokens[cursor]?.text !== ",") break;
    cursor += 1;
  }

  for (let open = 0; open < tokens.length; open += 1) {
    if (tokens[open].text !== "(") continue;
    const close = matchingParen(tokens, open);
    if (close < 0) continue;
    const first = tokens[open + 1]?.lower;
    if (first !== "select" && first !== "with") continue;
    let aliasIndex = close + 1;
    if (tokens[aliasIndex]?.lower === "as") aliasIndex += 1;
    const alias = tokens[aliasIndex];
    if (alias?.kind !== "identifier" || RELATION_END_WORDS.has(alias.lower)) continue;
    addRelation(relations, {
      name: alias.text,
      columns: selectColumns(tokens, open + 1, close),
      kind: "derived",
    });
  }

  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index].lower !== "from" && tokens[index].lower !== "join") continue;
    let relationIndex = index + 1;
    if (tokens[relationIndex]?.text === "(") continue;
    let relationName: SqlToken | null = null;
    while (tokens[relationIndex]?.kind === "identifier") {
      relationName = tokens[relationIndex];
      if (tokens[relationIndex + 1]?.text !== ".") break;
      relationIndex += 2;
    }
    if (!relationName) continue;
    const source = relations.get(relationName.lower);
    if (!source) continue;
    let aliasIndex = relationIndex + 1;
    if (tokens[aliasIndex]?.lower === "as") aliasIndex += 1;
    const alias = tokens[aliasIndex];
    if (alias?.kind !== "identifier" || RELATION_END_WORDS.has(alias.lower)) continue;
    addRelation(relations, { ...source, name: alias.text });
  }

  return relations;
}
