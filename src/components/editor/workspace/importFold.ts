/**
 * IDEA "Code Folding › Imports" default (ED-PARITY-011 DEC-011-06): the
 * leading import block of Java/Kotlin/TS/JS files is folded when a file is
 * opened. The range starts after the first `import ` keyword so the folded
 * line reads `import …`, like IDEA.
 */
const IMPORT_FOLD_EXTENSIONS = new Set(["java", "kt", "kts", "ts", "tsx", "js", "jsx", "mjs", "cjs"]);

export function importFoldRange(path: string, text: string): { from: number; to: number } | null {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  if (!IMPORT_FOLD_EXTENSIONS.has(ext)) return null;
  let offset = 0;
  let first: { lineStart: number; keywordEnd: number } | null = null;
  let lastEnd = -1;
  let count = 0;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    const lineStart = offset;
    offset += line.length + 1;
    if (/^import\s/.test(trimmed)) {
      if (!first) {
        const keyword = line.indexOf("import");
        first = { lineStart, keywordEnd: lineStart + keyword + "import ".length };
      }
      lastEnd = lineStart + line.replace(/\r$/, "").length;
      count += 1;
      continue;
    }
    // Blank lines and comments may sit between imports; anything else ends
    // the block (or, before the first import, package/header lines).
    if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*")) continue;
    if (first) break;
  }
  if (!first || count < 2 || lastEnd <= first.keywordEnd) return null;
  return { from: first.keywordEnd, to: lastEnd };
}
