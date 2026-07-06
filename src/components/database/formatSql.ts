import { format } from "sql-formatter";

type SqlFormatterOptions = NonNullable<Parameters<typeof format>[1]>;
type SqlFormatterLanguage = NonNullable<SqlFormatterOptions["language"]>;

const ENGINE_LANGUAGE: Record<string, SqlFormatterLanguage> = {
  MySQL: "mysql",
  StarRocks: "mysql",
  PostgreSQL: "postgresql",
  PanWeiDB: "postgresql",
  Oracle: "plsql",
  SQLServer: "transactsql",
  ClickHouse: "clickhouse",
  Presto: "trino",
};

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

function formatterLanguage(engine?: string): SqlFormatterLanguage {
  return engine ? (ENGINE_LANGUAGE[engine] ?? "sql") : "sql";
}

export function formatSql(sql: string, engine?: string): string {
  if (!sql.trim()) return sql;
  try {
    return format(sql, {
      language: formatterLanguage(engine),
      keywordCase: "upper",
      linesBetweenQueries: 1,
    }).trim();
  } catch {
    return fallbackFormatSql(sql);
  }
}

function fallbackFormatSql(sql: string): string {
  const segments = sql.split(/('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")/);
  const formatted = segments
    .map((segment, index) => {
      if (index % 2 === 1) return segment;
      let out = segment.replace(/\s+/g, " ");
      for (const keyword of CLAUSE_KEYWORDS) {
        const re = new RegExp(`\\s*\\b${keyword.replace(/ /g, "\\s+")}\\b\\s*`, "gi");
        out = out.replace(re, `\n${keyword} `);
      }
      return out;
    })
    .join("");
  return formatted
    .split("\n")
    .map((line) => line.trim())
    .filter((line, index) => line.length > 0 || index === 0)
    .join("\n")
    .trim();
}
