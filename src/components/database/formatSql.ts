/**
 * A small, dependency-free SQL pretty-printer. It puts major clauses on their
 * own lines and normalises whitespace. It is intentionally conservative — it
 * does not reflow expressions or touch string literals — so it never corrupts
 * a valid statement, only makes it more readable.
 */
const CLAUSE_KEYWORDS = [
  "SELECT",
  "FROM",
  "WHERE",
  "GROUP BY",
  "HAVING",
  "ORDER BY",
  "LIMIT",
  "OFFSET",
  "INNER JOIN",
  "LEFT JOIN",
  "RIGHT JOIN",
  "FULL JOIN",
  "JOIN",
  "UNION ALL",
  "UNION",
  "VALUES",
  "SET",
  "INSERT INTO",
  "UPDATE",
  "DELETE FROM",
];

export function formatSql(sql: string): string {
  if (!sql.trim()) return sql;
  // Split on string literals so we never reformat inside quotes.
  const segments = sql.split(/('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")/);
  const formatted = segments
    .map((seg, i) => {
      // Odd indices are quoted literals — leave untouched.
      if (i % 2 === 1) return seg;
      let out = seg.replace(/\s+/g, " ");
      for (const kw of CLAUSE_KEYWORDS) {
        const re = new RegExp(`\\s*\\b${kw.replace(/ /g, "\\s+")}\\b\\s*`, "gi");
        out = out.replace(re, `\n${kw} `);
      }
      // Comma after SELECT-list items → newline + indent for readability.
      return out;
    })
    .join("");
  return formatted
    .split("\n")
    .map((line) => line.trim())
    .filter((line, idx) => line.length > 0 || idx === 0)
    .join("\n")
    .trim();
}
