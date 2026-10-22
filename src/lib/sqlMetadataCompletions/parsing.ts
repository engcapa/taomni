import type { CompletionContext } from "@codemirror/autocomplete";
import { syntaxTree } from "@codemirror/language";
import { splitSqlQualifiedName } from "../dbMetadataCache";
import { COMPLETION_BLOCKED_NODES, RESERVED_AFTER_RELATION, QUALIFIED_PATTERN, IDENT_PATTERN } from "./syntax";
import { type CompletionPrefix, type TableRef, type NamedTableRef } from "./types";

export function truthy(value?: string | null): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed ? trimmed : null;
}

export function equalsName(a: string | null | undefined, b: string | null | undefined): boolean {
  return (a ?? "").toLowerCase() === (b ?? "").toLowerCase();
}

export function unquoteIdent(value: string): string {
  const parts = splitSqlQualifiedName(value);
  return parts[0] ?? value.trim();
}

export function currentStatement(context: CompletionContext, doc: string): string {
  let node = syntaxTree(context.state).resolveInner(context.pos, -1);
  while (true) {
    if (node.name === "Statement") return context.state.sliceDoc(node.from, node.to);
    if (!node.parent) break;
    node = node.parent;
  }
  const pos = context.pos;
  const before = doc.slice(0, pos);
  const after = doc.slice(pos);
  const start = before.lastIndexOf(";");
  const end = after.indexOf(";");
  return `${start >= 0 ? before.slice(start + 1) : before}${end >= 0 ? after.slice(0, end) : after}`;
}

export function currentStatementBefore(context: CompletionContext): string {
  let node = syntaxTree(context.state).resolveInner(context.pos, -1);
  while (true) {
    if (node.name === "Statement") return context.state.sliceDoc(node.from, context.pos);
    if (!node.parent) return context.state.sliceDoc(0, context.pos);
    node = node.parent;
  }
}

export function completionIsBlocked(context: CompletionContext): boolean {
  let node = syntaxTree(context.state).resolveInner(context.pos, -1);
  while (true) {
    if (COMPLETION_BLOCKED_NODES.has(node.name)) return true;
    if (node.type.isTop) break;
    if (!node.parent) break;
    node = node.parent;
  }
  return false;
}

export function completionPrefix(raw: string | undefined, pos: number): CompletionPrefix {
  const value = raw ?? "";
  const quote = value[0];
  if (quote === '"') {
    return { from: pos - value.length, text: value.slice(1).replace(/""/g, '"'), quoted: true };
  }
  if (quote === "`") {
    return { from: pos - value.length, text: value.slice(1).replace(/``/g, "`"), quoted: true };
  }
  if (quote === "[") {
    return { from: pos - value.length, text: value.slice(1).replace(/\]\]/g, "]"), quoted: true };
  }
  return { from: pos - value.length, text: value, quoted: false };
}

export function lastUnquotedComma(value: string): number {
  let quote: '"' | "`" | "]" | null = null;
  let last = -1;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (quote) {
      const closes = (quote === '"' && char === '"')
        || (quote === "`" && char === "`")
        || (quote === "]" && char === "]");
      if (closes && value[index + 1] === char) {
        index += 1;
      } else if (closes) {
        quote = null;
      }
      continue;
    }
    if (char === '"' || char === "`") quote = char;
    else if (char === "[") quote = "]";
    else if (char === ",") last = index;
  }
  return last;
}

export function identifierList(value: string): string[] {
  const result: string[] = [];
  let rest = value;
  while (rest.trim()) {
    const separator = lastUnquotedComma(rest);
    if (separator < 0) {
      const identifier = unquoteIdent(rest.trim());
      if (identifier) result.unshift(identifier);
      break;
    }
    const identifier = unquoteIdent(rest.slice(separator + 1).trim());
    if (identifier) result.unshift(identifier);
    rest = rest.slice(0, separator);
  }
  return result;
}

export function stripCommentsAndStrings(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--.*$/gm, " ")
    .replace(/'(?:''|[^'])*'/g, " ");
}

export function tableRefFromParts(
  parts: string[],
  engine: string,
  activeSchema?: string | null,
  catalog?: string | null,
): TableRef | null {
  if (parts.length === 0) return null;
  if (engine === "Presto") {
    if (parts.length >= 3) {
      return { catalog: parts[0], schema: parts[1], table: parts[2] };
    }
    if (parts.length === 2) {
      return { catalog: truthy(catalog), schema: parts[0], table: parts[1] };
    }
    return { catalog: truthy(catalog), schema: truthy(activeSchema), table: parts[0] };
  }
  if (parts.length >= 2) {
    return { catalog: null, schema: parts[parts.length - 2], table: parts[parts.length - 1] };
  }
  return { catalog: null, schema: truthy(activeSchema), table: parts[0] };
}

export function aliasMapFor(
  sql: string,
  engine: string,
  activeSchema?: string | null,
  catalog?: string | null,
): Map<string, TableRef> {
  const aliases = new Map<string, TableRef>();
  for (const relation of relationRefsFor(sql, engine, activeSchema, catalog)) {
    if (!equalsName(relation.qualifier, relation.ref.table)) {
      aliases.set(relation.qualifier.toLowerCase(), relation.ref);
    }
  }
  return aliases;
}

export function relationRefsFor(
  sql: string,
  engine: string,
  activeSchema?: string | null,
  catalog?: string | null,
): NamedTableRef[] {
  const relations: NamedTableRef[] = [];
  const cleaned = stripCommentsAndStrings(sql);
  const reservedAliasPattern = Array.from(RESERVED_AFTER_RELATION).join("|");
  const relationRe = new RegExp(
    String.raw`\b(?:from|join)\s+(${QUALIFIED_PATTERN})(?:\s+(?:as\s+)?((?!(?:${reservedAliasPattern})\b)${IDENT_PATTERN}))?`,
    "giu",
  );
  let match: RegExpExecArray | null;
  while ((match = relationRe.exec(cleaned))) {
    const parts = splitSqlQualifiedName(match[1]);
    const ref = tableRefFromParts(parts, engine, activeSchema, catalog);
    if (!ref) continue;
    const alias = match[2] ? unquoteIdent(match[2]) : null;
    const qualifier = alias && !RESERVED_AFTER_RELATION.has(alias.toLowerCase())
      ? alias
      : ref.table;
    relations.push({ ref, qualifier });
  }
  return relations;
}
