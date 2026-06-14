/**
 * Split a block of HBase shell input into individual statements.
 *
 * The HBase shell client executes one statement per backend call, so a block
 * containing several commands has to be split before dispatch. Statements are
 * separated by newlines or `;` at the top level. Separators inside quotes
 * (`'`/`"`), option maps (`{}`), or column lists (`[]`) are ignored, and a line
 * ending in `,` or `\` continues onto the next line so a multi-line `create`
 * (e.g. `create 't',` / `{NAME => 'cf1'},` / `{NAME => 'cf2'}`) stays one
 * statement. Empty statements are dropped.
 *
 * The quote/brace/bracket/escape handling mirrors the backend `split_top_level`
 * parser (src-tauri/src/hbase/mod.rs) so splitting never breaks a statement the
 * backend would otherwise parse as a unit.
 */
export function splitHBaseStatements(input: string): string[] {
  const statements: string[] = [];
  let current = "";
  let single = false;
  let double = false;
  let brace = 0;
  let bracket = 0;
  let i = 0;

  const push = () => {
    const trimmed = current.trim();
    if (trimmed) statements.push(trimmed);
    current = "";
  };

  while (i < input.length) {
    const ch = input[i];

    // Inside quotes: copy verbatim, honoring backslash escapes, until the
    // matching quote closes. A `\` escape keeps the next character literal so
    // an escaped quote (`\'`) does not end the string.
    if (single || double) {
      if (ch === "\\" && i + 1 < input.length) {
        current += ch + input[i + 1];
        i += 2;
        continue;
      }
      current += ch;
      if (single && ch === "'") single = false;
      else if (double && ch === '"') double = false;
      i += 1;
      continue;
    }

    if (ch === "'") {
      single = true;
      current += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      double = true;
      current += ch;
      i += 1;
      continue;
    }
    if (ch === "{") {
      brace += 1;
      current += ch;
      i += 1;
      continue;
    }
    if (ch === "}") {
      brace = Math.max(0, brace - 1);
      current += ch;
      i += 1;
      continue;
    }
    if (ch === "[") {
      bracket += 1;
      current += ch;
      i += 1;
      continue;
    }
    if (ch === "]") {
      bracket = Math.max(0, bracket - 1);
      current += ch;
      i += 1;
      continue;
    }

    const topLevel = brace === 0 && bracket === 0;

    if (topLevel && (ch === "\n" || ch === "\r")) {
      // Line continuation: a trailing comma or backslash joins the next line.
      // Collapse the join (drop the newline and the next line's indent) to a
      // single space so the reassembled statement reads cleanly.
      const trimmedEnd = current.replace(/[ \t]+$/, "");
      const continuesComma = trimmedEnd.endsWith(",");
      const continuesBackslash = !continuesComma && trimmedEnd.endsWith("\\");
      if (continuesComma || continuesBackslash) {
        current = continuesBackslash
          ? trimmedEnd.slice(0, -1).replace(/[ \t]+$/, "")
          : trimmedEnd;
        i += 1;
        while (i < input.length && (input[i] === " " || input[i] === "\t")) {
          i += 1;
        }
        current += " ";
        continue;
      }
      push();
      i += 1;
      continue;
    }

    if (topLevel && ch === ";") {
      push();
      i += 1;
      continue;
    }

    current += ch;
    i += 1;
  }

  push();
  return statements;
}
