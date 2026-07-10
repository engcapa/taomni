export interface SqlQueryRelation {
  kind: "named" | "derived";
  parts: string[];
  qualifier: string;
}

export interface SqlSelectListScope {
  selectFrom: number;
  selectListFrom: number;
  selectListTo: number;
  queryDepth: number;
  relations: SqlQueryRelation[];
}

interface SqlToken {
  kind: "identifier" | "symbol";
  text: string;
  lower: string;
  from: number;
  to: number;
  depth: number;
}

const QUERY_BOUNDARIES = new Set([";", "union", "except", "intersect"]);
const FROM_END_WORDS = new Set([
  "where",
  "group",
  "having",
  "order",
  "limit",
  "offset",
  "fetch",
  "qualify",
  "window",
  "returning",
  "for",
  ...QUERY_BOUNDARIES,
]);
const RESERVED_ALIASES = new Set([
  "as",
  "on",
  "using",
  "join",
  "inner",
  "left",
  "right",
  "full",
  "cross",
  "natural",
  ...FROM_END_WORDS,
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
  let depth = 0;

  const push = (
    kind: SqlToken["kind"],
    text: string,
    from: number,
    to: number,
    tokenDepth = depth,
  ) => {
    const value = kind === "identifier" ? unquoteIdentifier(text) : text;
    tokens.push({ kind, text: value, lower: value.toLocaleLowerCase(), from, to, depth: tokenDepth });
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
      continue;
    }
    if (char === "'") {
      index += 1;
      while (index < sql.length) {
        if (sql[index] === "'" && sql[index + 1] === "'") index += 2;
        else if (sql[index] === "'") {
          index += 1;
          break;
        } else index += 1;
      }
      continue;
    }
    if (char === '"' || char === "`" || char === "[") {
      const close = char === "[" ? "]" : char;
      const start = index;
      index += 1;
      while (index < sql.length) {
        if (sql[index] === close && sql[index + 1] === close) index += 2;
        else if (sql[index] === close) {
          index += 1;
          break;
        } else index += 1;
      }
      push("identifier", sql.slice(start, index), start, index);
      continue;
    }
    if (/^[\p{L}\p{N}\p{M}_$#@]$/u.test(char)) {
      const start = index;
      index += 1;
      while (index < sql.length && /^[\p{L}\p{N}\p{M}_$#@]$/u.test(sql[index])) index += 1;
      push("identifier", sql.slice(start, index), start, index);
      continue;
    }
    if (char === "(") {
      push("symbol", char, index, index + 1);
      depth += 1;
    } else if (char === ")") {
      depth = Math.max(0, depth - 1);
      push("symbol", char, index, index + 1);
    } else {
      push("symbol", char, index, index + 1);
    }
    index += 1;
  }
  return tokens;
}

function queryBoundaryAfter(tokens: SqlToken[], start: number, depth: number): number {
  for (let index = start; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.depth === depth && QUERY_BOUNDARIES.has(token.lower)) return index;
  }
  return tokens.length;
}

function matchingClose(tokens: SqlToken[], open: number): number {
  const depth = tokens[open]?.depth;
  if (depth === undefined || tokens[open].text !== "(") return -1;
  for (let index = open + 1; index < tokens.length; index += 1) {
    if (tokens[index].text === ")" && tokens[index].depth === depth) return index;
  }
  return -1;
}

function relationAlias(tokens: SqlToken[], index: number, end: number): { alias: string | null; next: number } {
  let cursor = index;
  if (tokens[cursor]?.lower === "as") cursor += 1;
  const token = tokens[cursor];
  if (
    cursor < end
    && token?.kind === "identifier"
    && !RESERVED_ALIASES.has(token.lower)
  ) {
    return { alias: token.text, next: cursor + 1 };
  }
  return { alias: null, next: index };
}

function relationAt(tokens: SqlToken[], start: number, end: number, depth: number): {
  relation: SqlQueryRelation | null;
  next: number;
} {
  let cursor = start;
  while (tokens[cursor]?.depth === depth && ["lateral", "only"].includes(tokens[cursor].lower)) {
    cursor += 1;
  }
  const first = tokens[cursor];
  if (!first || cursor >= end || first.depth !== depth) return { relation: null, next: start };

  if (first.text === "(") {
    const close = matchingClose(tokens, cursor);
    if (close < 0 || close >= end) return { relation: null, next: cursor + 1 };
    const { alias, next } = relationAlias(tokens, close + 1, end);
    return {
      relation: alias ? { kind: "derived", parts: [], qualifier: alias } : null,
      next: Math.max(close + 1, next),
    };
  }

  if (first.kind !== "identifier") return { relation: null, next: cursor + 1 };
  const parts = [first.text];
  cursor += 1;
  while (
    cursor + 1 < end
    && tokens[cursor]?.depth === depth
    && tokens[cursor]?.text === "."
    && tokens[cursor + 1]?.depth === depth
    && tokens[cursor + 1]?.kind === "identifier"
  ) {
    parts.push(tokens[cursor + 1].text);
    cursor += 2;
  }
  const { alias, next } = relationAlias(tokens, cursor, end);
  return {
    relation: {
      kind: "named",
      parts,
      qualifier: alias ?? parts.at(-1) ?? "",
    },
    next: Math.max(cursor, next),
  };
}

function queryRelations(
  tokens: SqlToken[],
  from: number,
  queryEnd: number,
  depth: number,
): SqlQueryRelation[] {
  let relationEnd = queryEnd;
  for (let index = from + 1; index < queryEnd; index += 1) {
    const token = tokens[index];
    if (token.depth === depth && FROM_END_WORDS.has(token.lower)) {
      relationEnd = index;
      break;
    }
  }

  const relations: SqlQueryRelation[] = [];
  let expectRelation = true;
  let index = from + 1;
  while (index < relationEnd) {
    const token = tokens[index];
    if (token.depth !== depth) {
      index += 1;
      continue;
    }
    if (token.lower === "join" || token.text === ",") {
      expectRelation = true;
      index += 1;
      continue;
    }
    if (!expectRelation) {
      index += 1;
      continue;
    }
    const parsed = relationAt(tokens, index, relationEnd, depth);
    if (parsed.relation?.qualifier) relations.push(parsed.relation);
    expectRelation = false;
    index = Math.max(index + 1, parsed.next);
  }
  return relations;
}

/**
 * Return the SELECT-list query scope containing `cursor`, including relations
 * declared later in the same query block. The parser is deliberately local and
 * skips strings/comments while respecting subquery parenthesis depth.
 */
export function sqlSelectListScope(sql: string, cursor: number): SqlSelectListScope | null {
  const pos = Math.max(0, Math.min(sql.length, cursor));
  const tokens = tokenize(sql);
  for (let selectIndex = tokens.length - 1; selectIndex >= 0; selectIndex -= 1) {
    const select = tokens[selectIndex];
    if (select.lower !== "select" || select.from >= pos) continue;
    const queryEnd = queryBoundaryAfter(tokens, selectIndex + 1, select.depth);
    const queryEndPos = tokens[queryEnd]?.from ?? sql.length;
    if (pos > queryEndPos) continue;

    let fromIndex = -1;
    for (let index = selectIndex + 1; index < queryEnd; index += 1) {
      const token = tokens[index];
      if (token.depth === select.depth && token.lower === "from") {
        fromIndex = index;
        break;
      }
    }
    if (fromIndex < 0) continue;
    const from = tokens[fromIndex];
    if (pos < select.to || pos > from.from) continue;

    return {
      selectFrom: select.from,
      selectListFrom: select.to,
      selectListTo: from.from,
      queryDepth: select.depth,
      relations: queryRelations(tokens, fromIndex, queryEnd, select.depth),
    };
  }
  return null;
}
