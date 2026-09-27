import { javaLanguage } from "@codemirror/lang-java";
import { invoke } from "@tauri-apps/api/core";
import { isTauriRuntime } from "../runtime";
import type { StructuralQuery } from "../../components/editor/workspace/companionCapabilities";

export interface StructuralSearchDocument {
  rootId: string;
  rootName: string;
  rootPath: string;
  path: string;
  text: string;
}

export interface StructuralSearchCapture {
  from: number;
  to: number;
  text: string;
}

export interface StructuralSearchResult {
  rootId: string;
  rootName: string;
  rootPath: string;
  path: string;
  from: number;
  to: number;
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
  preview: string;
  className: string | null;
  methodName: string | null;
  captures: Record<string, StructuralSearchCapture>;
}

export type StructuralSearchResponse =
  | {
    kind: "ready";
    backend: "lezer-java" | "tree-sitter-java";
    results: StructuralSearchResult[];
    filesScanned: number;
  }
  | { kind: "unavailable"; reason: string; backend?: string }
  | { kind: "error"; message: string }
  | { kind: "cancelled" };

export interface StructuralSearchRequest {
  query: StructuralQuery;
  documents: StructuralSearchDocument[];
  requestId: string;
}

const JAVA_PATTERN = "System.out.println($arg$);";

export function defaultStructuralQuery(): StructuralQuery {
  return {
    schemaVersion: 1,
    languageId: "java",
    pattern: JAVA_PATTERN,
    variables: {
      arg: { minCount: 1, maxCount: 1 },
    },
    scope: "workspace",
  };
}

function childByName(node: { firstChild: any }, name: string): any | null {
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.name === name) return child;
  }
  return null;
}

function linePosition(text: string, offset: number): { line: number; column: number } {
  const prefix = text.slice(0, offset);
  const lineBreak = prefix.lastIndexOf("\n");
  return {
    line: 1 + (prefix.match(/\n/g)?.length ?? 0),
    column: offset - (lineBreak === -1 ? 0 : lineBreak + 1),
  };
}

function enclosingName(node: any, text: string, wanted: string): string | null {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (parent.name !== wanted) continue;
    const definition = childByName(parent, "Definition");
    if (definition) return text.slice(definition.from, definition.to);
  }
  return null;
}

function resultForInvocation(
  invocation: any,
  document: StructuralSearchDocument,
  query: StructuralQuery,
): StructuralSearchResult | null {
  const receiver = childByName(invocation, "FieldAccess");
  const methodName = childByName(invocation, "MethodName");
  const argumentList = childByName(invocation, "ArgumentList");
  if (!receiver || !methodName || !argumentList) return null;
  if (document.text.slice(receiver.from, receiver.to) !== "System.out") return null;
  if (document.text.slice(methodName.from, methodName.to) !== "println") return null;

  const open = childByName(argumentList, "(");
  const close = childByName(argumentList, ")");
  if (!open || !close) return null;
  const argumentText = document.text.slice(open.to, close.from).trim();
  const variable = query.variables.arg;
  if (!variable || !argumentText) return null;
  if (variable.text !== undefined && argumentText !== variable.text) return null;

  const expressionStatement = invocation.parent?.name === "ExpressionStatement"
    ? invocation.parent
    : invocation;
  const from = expressionStatement.from;
  const to = expressionStatement.to;
  const argumentFrom = open.to + document.text.slice(open.to, close.from).search(/\S/);
  const argumentTo = argumentFrom + argumentText.length;
  const start = linePosition(document.text, from);
  const end = linePosition(document.text, to);
  return {
    rootId: document.rootId,
    rootName: document.rootName,
    rootPath: document.rootPath,
    path: document.path,
    from,
    to,
    line: start.line,
    column: start.column,
    endLine: end.line,
    endColumn: end.column,
    preview: document.text.slice(from, to).trim(),
    className: enclosingName(invocation, document.text, "ClassDeclaration"),
    methodName: enclosingName(invocation, document.text, "MethodDeclaration"),
    captures: {
      arg: {
        from: argumentFrom,
        to: argumentTo,
        text: argumentText,
      },
    },
  };
}

function collectResults(document: StructuralSearchDocument, query: StructuralQuery): StructuralSearchResult[] {
  const tree = javaLanguage.parser.parse(document.text).topNode;
  const results: StructuralSearchResult[] = [];
  function visit(node: any): void {
    if (node.name === "MethodInvocation") {
      const result = resultForInvocation(node, document, query);
      if (result) results.push(result);
    }
    for (let child = node.firstChild; child; child = child.nextSibling) visit(child);
  }
  visit(tree);
  return results;
}

export function searchJavaDocuments(
  query: StructuralQuery,
  documents: StructuralSearchDocument[],
  signal?: AbortSignal,
): StructuralSearchResponse {
  if (query.languageId !== "java") {
    return { kind: "unavailable", reason: `Java structural search does not support ${query.languageId}`, backend: "lezer-java" };
  }
  if (query.pattern.trim() !== JAVA_PATTERN) {
    return { kind: "unavailable", reason: "Only the Java println template is available in this first adapter", backend: "lezer-java" };
  }
  try {
    const results: StructuralSearchResult[] = [];
    for (const document of documents) {
      if (signal?.aborted) return { kind: "error", message: "Structural search cancelled" };
      if (!document.path.toLowerCase().endsWith(".java")) continue;
      results.push(...collectResults(document, query));
    }
    return { kind: "ready", backend: "lezer-java", results, filesScanned: documents.length };
  } catch (error) {
    return { kind: "error", message: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Native runs cross the real Tauri bridge. The browser preview deliberately
 * uses the same AST contract locally because it has no host filesystem.
 */
export function searchStructuralDocuments(request: StructuralSearchRequest): Promise<StructuralSearchResponse> {
  if (!isTauriRuntime()) {
    return Promise.resolve(searchJavaDocuments(request.query, request.documents));
  }
  return invoke<StructuralSearchResponse>("structural_search_java", {
    requestId: request.requestId,
    query: request.query,
    documents: request.documents,
  });
}

export function cancelStructuralSearch(requestId: string): Promise<boolean> {
  if (!isTauriRuntime()) return Promise.resolve(true);
  return invoke<boolean>("structural_search_cancel", { requestId });
}

export function structuralSearchPattern(): string {
  return JAVA_PATTERN;
}
