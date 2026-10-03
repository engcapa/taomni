/** LSP SymbolKind values used by Search Everywhere class filtering. */
export const CLASS_SYMBOL_KINDS = new Set([
  5, // Class
  10, // Enum
  11, // Interface
  23, // Struct
  26, // TypeParameter
]);

export function isClassSymbolKind(kind: number): boolean {
  return CLASS_SYMBOL_KINDS.has(kind);
}

export function symbolKindLabel(kind: number): string {
  switch (kind) {
    case 5: return "class";
    case 6: return "method";
    case 10: return "enum";
    case 11: return "interface";
    case 12: return "function";
    case 13: return "variable";
    case 23: return "struct";
    case 26: return "type";
    default: return "symbol";
  }
}
