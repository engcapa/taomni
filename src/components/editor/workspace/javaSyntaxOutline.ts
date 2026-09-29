import { javaLanguage } from "@codemirror/lang-java";
import type { LspDocumentSymbol, LspPosition } from "../../../lib/editor/lsp";

// @lezer/common is not a direct dependency; derive its node type from the parser.
type SyntaxNode = ReturnType<typeof javaLanguage.parser.parse>["topNode"];

/** LSP SymbolKind values used by the syntax-only outline. */
const KIND = {
  class: 5,
  method: 6,
  field: 8,
  constructor: 9,
  enum: 10,
  interface: 11,
  enumMember: 22,
} as const;

const TYPE_KINDS: Record<string, number> = {
  ClassDeclaration: KIND.class,
  InterfaceDeclaration: KIND.interface,
  EnumDeclaration: KIND.enum,
};

const MEMBER_BODIES = new Set(["ClassBody", "InterfaceBody", "EnumBody", "EnumBodyDeclarations"]);

function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i += 1) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  return starts;
}

function positionAt(starts: number[], offset: number): LspPosition {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (starts[mid]! <= offset) low = mid;
    else high = mid - 1;
  }
  return { line: low, character: offset - starts[low]! };
}

function firstChild(node: SyntaxNode, name: string): SyntaxNode | null {
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.name === name) return child;
  }
  return null;
}

/**
 * ED-PARITY-014 DEC-014-04: a syntax-only Java outline from the bundled Lezer
 * grammar, for File Structure when no language server answers. It lists types,
 * fields, constructors, methods and enum constants in document order; method
 * bodies are not descended, so locals and lambdas never appear.
 */
export function javaSyntaxOutline(text: string): LspDocumentSymbol[] {
  const tree = javaLanguage.parser.parse(text);
  const starts = lineStarts(text);
  const out: LspDocumentSymbol[] = [];
  const push = (node: SyntaxNode, nameNode: SyntaxNode, kind: number, depth: number, detail: string | null) => {
    out.push({
      name: text.slice(nameNode.from, nameNode.to),
      detail,
      kind,
      depth,
      range: { start: positionAt(starts, node.from), end: positionAt(starts, node.to) },
      selectionRange: { start: positionAt(starts, nameNode.from), end: positionAt(starts, nameNode.to) },
    });
  };
  const visitBody = (body: SyntaxNode, depth: number) => {
    for (let child = body.firstChild; child; child = child.nextSibling) visitMember(child, depth);
  };
  const visitMember = (node: SyntaxNode, depth: number) => {
    const typeKind = TYPE_KINDS[node.name];
    if (typeKind !== undefined) {
      const name = firstChild(node, "Definition");
      if (name) push(node, name, typeKind, depth, null);
      for (let child = node.firstChild; child; child = child.nextSibling) {
        if (MEMBER_BODIES.has(child.name)) visitBody(child, depth + 1);
      }
      return;
    }
    if (node.name === "MethodDeclaration" || node.name === "ConstructorDeclaration") {
      const name = firstChild(node, "Definition");
      const params = firstChild(node, "FormalParameters");
      if (name) {
        push(
          node,
          name,
          node.name === "ConstructorDeclaration" ? KIND.constructor : KIND.method,
          depth,
          params ? text.slice(params.from, params.to).replace(/\s+/g, " ") : null,
        );
      }
      return;
    }
    if (node.name === "FieldDeclaration") {
      for (let child = node.firstChild; child; child = child.nextSibling) {
        if (child.name !== "VariableDeclarator") continue;
        const name = firstChild(child, "Definition");
        if (name) push(child, name, KIND.field, depth, null);
      }
      return;
    }
    if (node.name === "EnumConstant") {
      const name = firstChild(node, "Definition");
      if (name) push(node, name, KIND.enumMember, depth, null);
      return;
    }
    if (MEMBER_BODIES.has(node.name)) visitBody(node, depth);
  };
  for (let child = tree.topNode.firstChild; child; child = child.nextSibling) visitMember(child, 0);
  return out;
}
