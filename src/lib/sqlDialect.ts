/**
 * SQL dialect + capability layer shared by the database client UI.
 *
 * Centralizes identifier quoting, qualified-name construction, statement
 * templates, and a per-engine capability map so the schema tree, context
 * menus, and the query editor all agree on how to talk to each engine.
 */

export type SqlEngine = "MySQL" | "PostgreSQL" | "SQLServer" | "StarRocks" | "ClickHouse" | "Presto";

/** Canonical object kinds surfaced as tree folders / context menus. */
export type ObjectKind =
  | "table"
  | "view"
  | "materialized_view"
  | "procedure"
  | "function"
  | "trigger"
  | "event"
  | "sequence"
  | "dictionary";

/** A fully-addressable object target. */
export interface ObjectTarget {
  catalog?: string | null;
  schema?: string | null;
  name: string;
}

/** How a potentially-destructive / DDL action is handled for an engine. */
export type ActionMode = "execute" | "editor" | "disabled";

/** Destructive / DDL actions whose handling varies per engine. */
export type DialectAction =
  | "truncate"
  | "drop"
  | "rename"
  | "alterColumn"
  | "dropColumn"
  | "dropIndex"
  | "dropDatabase"
  | "renameDatabase"
  | "disableTrigger";

const DOUBLE_QUOTE_ENGINES: SqlEngine[] = ["PostgreSQL", "Presto"];

/** Narrow an arbitrary engine string to a known `SqlEngine` (else MySQL). */
export function asSqlEngine(engine: string): SqlEngine {
  return engine === "PostgreSQL" || engine === "SQLServer" || engine === "StarRocks" || engine === "ClickHouse" || engine === "Presto"
    ? engine
    : "MySQL";
}

/** Quote a single identifier for `engine`, escaping the quote char. */
export function quoteIdent(engine: SqlEngine, ident: string): string {
  if (engine === "SQLServer") {
    return `[${ident.replace(/]/g, "]]")}]`;
  }
  if (DOUBLE_QUOTE_ENGINES.includes(engine)) {
    return `"${ident.replace(/"/g, '""')}"`;
  }
  return `\`${ident.replace(/`/g, "``")}\``;
}

/** Build a qualified name (catalog.schema.name as the engine requires). */
export function qualifiedName(engine: SqlEngine, target: ObjectTarget): string {
  const parts: string[] = [];
  if (engine === "Presto" && target.catalog && target.schema) {
    parts.push(quoteIdent(engine, target.catalog));
  }
  if (target.schema) parts.push(quoteIdent(engine, target.schema));
  parts.push(quoteIdent(engine, target.name));
  return parts.join(".");
}

/** Single-quoted SQL string literal (NULL passthrough). */
export function sqlLiteral(value: string | null): string {
  if (value === null) return "NULL";
  return `'${value.replace(/'/g, "''")}'`;
}

/** SQL that makes `schema` the active/default schema for the session. */
export function setDefaultSchemaSql(
  engine: SqlEngine,
  schema: string,
  catalog?: string | null,
): string {
  if (engine === "PostgreSQL") return `SET search_path TO ${quoteIdent(engine, schema)}`;
  if (engine === "SQLServer") return `-- SQL Server schemas are selected by using two-part names such as ${quoteIdent(engine, schema)}.${quoteIdent(engine, "table_name")}`;
  if (engine === "Presto" && catalog) {
    return `USE ${quoteIdent(engine, catalog)}.${quoteIdent(engine, schema)}`;
  }
  return `USE ${quoteIdent(engine, schema)}`;
}

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

const ENGINE_CATEGORIES: Record<SqlEngine, ObjectKind[]> = {
  MySQL: ["table", "view", "procedure", "function", "trigger", "event"],
  PostgreSQL: ["table", "view", "materialized_view", "function", "sequence"],
  SQLServer: ["table", "view", "procedure", "function", "trigger", "sequence"],
  StarRocks: ["table", "view"],
  ClickHouse: ["table", "view", "materialized_view", "dictionary"],
  Presto: ["table", "view"],
};

/** Object-category folders shown under each database for `engine`. */
export function categoriesForEngine(engine: SqlEngine): ObjectKind[] {
  return ENGINE_CATEGORIES[engine] ?? ["table", "view"];
}

/** Inline grid write-back (UPDATE/DELETE/INSERT) is only safe on row stores. */
export function supportsInlineEdit(engine: SqlEngine): boolean {
  return engine === "MySQL" || engine === "PostgreSQL" || engine === "SQLServer";
}

/** Index introspection is only meaningful for the row-store engines. */
export function supportsIndexes(engine: SqlEngine): boolean {
  return engine === "MySQL" || engine === "PostgreSQL" || engine === "SQLServer";
}

/** ClickHouse mutates rows via `ALTER TABLE … UPDATE/DELETE`, not DML. */
export function usesAlterMutations(engine: SqlEngine): boolean {
  return engine === "ClickHouse";
}

/**
 * How a destructive / DDL `action` should be handled for `engine`:
 * `execute` (run behind a confirm), `editor` (emit SQL for review), or
 * `disabled` (engine has no safe equivalent).
 */
export function actionMode(engine: SqlEngine, action: DialectAction): ActionMode {
  if (engine === "StarRocks") {
    if (action === "disableTrigger" || action === "renameDatabase") return "disabled";
    if (action === "rename" || action === "alterColumn" || action === "dropColumn" || action === "dropIndex") {
      return "editor";
    }
  }
  if (engine === "Presto") {
    // Connector write-support is unknown; never auto-execute mutations.
    return action === "disableTrigger" ? "disabled" : "editor";
  }
  switch (action) {
    case "renameDatabase":
      // MySQL and StarRocks have no safe RENAME DATABASE; SQL Server has no direct schema rename.
      return engine === "MySQL" || engine === "StarRocks" || engine === "SQLServer" ? "disabled" : "execute";
    case "disableTrigger":
      // PostgreSQL and SQL Server support per-trigger enable/disable.
      return engine === "PostgreSQL" || engine === "SQLServer" ? "execute" : "disabled";
    default:
      return "execute";
  }
}

// ---------------------------------------------------------------------------
// DML statement templates (inserted into the editor for the user to complete)
// ---------------------------------------------------------------------------

const VALUE_PLACEHOLDER = (col: string) => `<${col}>`;

/** `SELECT <cols> FROM <table> LIMIT n` (cols omitted → `*`). */
export function selectStatement(
  engine: SqlEngine,
  target: ObjectTarget,
  columns: string[],
  limit: number,
): string {
  const cols =
    columns.length > 0 ? columns.map((c) => quoteIdent(engine, c)).join(", ") : "*";
  if (engine === "SQLServer") {
    return `SELECT TOP (${limit}) ${cols}\nFROM ${qualifiedName(engine, target)};`;
  }
  return `SELECT ${cols}\nFROM ${qualifiedName(engine, target)}\nLIMIT ${limit};`;
}

/** `INSERT INTO <table> (cols) VALUES (<placeholders>)`. */
export function insertStatement(
  engine: SqlEngine,
  target: ObjectTarget,
  columns: string[],
): string {
  const cols = columns.map((c) => quoteIdent(engine, c)).join(", ");
  const values = columns.map((c) => VALUE_PLACEHOLDER(c)).join(", ");
  return `INSERT INTO ${qualifiedName(engine, target)}\n  (${cols})\nVALUES\n  (${values});`;
}

/** `UPDATE … SET non-pk = … WHERE pk = …` (ClickHouse → `ALTER … UPDATE`). */
export function updateStatement(
  engine: SqlEngine,
  target: ObjectTarget,
  columns: string[],
  pkColumns: string[],
): string {
  const keys = pkColumns.length > 0 ? pkColumns : columns.slice(0, 1);
  const settable = columns.filter((c) => !keys.includes(c));
  const assigns = (settable.length > 0 ? settable : columns)
    .map((c) => `${quoteIdent(engine, c)} = ${VALUE_PLACEHOLDER(c)}`)
    .join(",\n  ");
  const where = keys
    .map((c) => `${quoteIdent(engine, c)} = ${VALUE_PLACEHOLDER(c)}`)
    .join("\n  AND ");
  const tbl = qualifiedName(engine, target);
  if (usesAlterMutations(engine)) {
    return `ALTER TABLE ${tbl}\nUPDATE ${assigns}\nWHERE ${where};`;
  }
  return `UPDATE ${tbl}\nSET ${assigns}\nWHERE ${where};`;
}

/** `DELETE FROM … WHERE pk = …` (ClickHouse → `ALTER … DELETE WHERE …`). */
export function deleteStatement(
  engine: SqlEngine,
  target: ObjectTarget,
  pkColumns: string[],
  fallbackColumns: string[] = [],
): string {
  const keys =
    pkColumns.length > 0 ? pkColumns : fallbackColumns.slice(0, 1);
  const where =
    keys.length > 0
      ? keys
          .map((c) => `${quoteIdent(engine, c)} = ${VALUE_PLACEHOLDER(c)}`)
          .join("\n  AND ")
      : VALUE_PLACEHOLDER("condition");
  const tbl = qualifiedName(engine, target);
  if (usesAlterMutations(engine)) {
    return `ALTER TABLE ${tbl}\nDELETE WHERE ${where};`;
  }
  return `DELETE FROM ${tbl}\nWHERE ${where};`;
}

/** `<table>.<column>` for inserting a column reference into the editor. */
export function columnReference(engine: SqlEngine, column: string): string {
  return quoteIdent(engine, column);
}

/** `<column> = <placeholder>` condition fragment. */
export function columnCondition(engine: SqlEngine, column: string): string {
  return `${quoteIdent(engine, column)} = ${VALUE_PLACEHOLDER(column)}`;
}

// ---------------------------------------------------------------------------
// Destructive / DDL builders
// ---------------------------------------------------------------------------

export function truncateStatement(engine: SqlEngine, target: ObjectTarget): string {
  return `TRUNCATE TABLE ${qualifiedName(engine, target)};`;
}

export function renameTableStatement(
  engine: SqlEngine,
  target: ObjectTarget,
  newName: string,
): string {
  const oldName = qualifiedName(engine, target);
  if (engine === "MySQL" || engine === "StarRocks" || engine === "ClickHouse") {
    const renamed = qualifiedName(engine, { ...target, name: newName });
    return `RENAME TABLE ${oldName} TO ${renamed};`;
  }
  if (engine === "SQLServer") {
    return `EXEC sp_rename ${sqlLiteral(oldName)}, ${sqlLiteral(newName)};`;
  }
  // PostgreSQL / Presto: rename target is unqualified.
  return `ALTER TABLE ${oldName} RENAME TO ${quoteIdent(engine, newName)};`;
}

/** `DROP <kind> <name>`. Triggers route through `dropTriggerStatement`. */
export function dropStatement(
  engine: SqlEngine,
  kind: ObjectKind,
  target: ObjectTarget,
): string {
  const obj = qualifiedName(engine, target);
  switch (kind) {
    case "view":
      return `DROP VIEW ${obj};`;
    case "materialized_view":
      return engine === "PostgreSQL"
        ? `DROP MATERIALIZED VIEW ${obj};`
        : `DROP VIEW ${obj};`;
    case "procedure":
      return `DROP PROCEDURE ${obj};`;
    case "function":
      return `DROP FUNCTION ${obj};`;
    case "sequence":
      return `DROP SEQUENCE ${obj};`;
    case "dictionary":
      return `DROP DICTIONARY ${obj};`;
    case "event":
      return `DROP EVENT ${obj};`;
    default:
      return `DROP TABLE ${obj};`;
  }
}

export function dropColumnStatement(
  engine: SqlEngine,
  target: ObjectTarget,
  column: string,
): string {
  return `ALTER TABLE ${qualifiedName(engine, target)} DROP COLUMN ${quoteIdent(
    engine,
    column,
  )};`;
}

export interface ColumnChange {
  oldName: string;
  newName?: string;
  type: string;
  nullable?: boolean;
}

/** Build an `ALTER TABLE … (MODIFY|ALTER) COLUMN` for `change`. */
export function alterColumnStatement(
  engine: SqlEngine,
  target: ObjectTarget,
  change: ColumnChange,
): string {
  const tbl = qualifiedName(engine, target);
  const oldCol = quoteIdent(engine, change.oldName);
  const newCol = quoteIdent(engine, change.newName || change.oldName);
  const nullSuffix =
    change.nullable === undefined ? "" : change.nullable ? " NULL" : " NOT NULL";
  if (engine === "PostgreSQL") {
    const lines = [`ALTER TABLE ${tbl} ALTER COLUMN ${oldCol} TYPE ${change.type};`];
    if (change.nullable !== undefined) {
      lines.push(
        `ALTER TABLE ${tbl} ALTER COLUMN ${oldCol} ${
          change.nullable ? "DROP NOT NULL" : "SET NOT NULL"
        };`,
      );
    }
    if (change.newName && change.newName !== change.oldName) {
      lines.push(`ALTER TABLE ${tbl} RENAME COLUMN ${oldCol} TO ${newCol};`);
    }
    return lines.join("\n");
  }
  if (engine === "SQLServer") {
    const lines = [`ALTER TABLE ${tbl} ALTER COLUMN ${oldCol} ${change.type}${nullSuffix};`];
    if (change.newName && change.newName !== change.oldName) {
      lines.push(`EXEC sp_rename ${sqlLiteral(`${tbl}.${change.oldName}`)}, ${sqlLiteral(change.newName)}, 'COLUMN';`);
    }
    return lines.join("\n");
  }
  // MySQL / StarRocks / ClickHouse: CHANGE renames, MODIFY keeps the name.
  if ((engine === "MySQL" || engine === "StarRocks") && change.newName && change.newName !== change.oldName) {
    return `ALTER TABLE ${tbl} CHANGE COLUMN ${oldCol} ${newCol} ${change.type}${nullSuffix};`;
  }
  return `ALTER TABLE ${tbl} MODIFY COLUMN ${oldCol} ${change.type}${nullSuffix};`;
}

export function dropIndexStatement(
  engine: SqlEngine,
  schema: string | null,
  table: string,
  index: string,
): string {
  const tbl = qualifiedName(engine, { schema, name: table });
  if (engine === "MySQL" || engine === "StarRocks") {
    return `DROP INDEX ${quoteIdent(engine, index)} ON ${tbl};`;
  }
  if (engine === "ClickHouse") {
    return `ALTER TABLE ${tbl} DROP INDEX ${quoteIdent(engine, index)};`;
  }
  if (engine === "SQLServer") {
    return `DROP INDEX ${quoteIdent(engine, index)} ON ${tbl};`;
  }
  // PostgreSQL: indexes live in the schema namespace.
  return `DROP INDEX ${qualifiedName(engine, { schema, name: index })};`;
}

export function dropDatabaseStatement(engine: SqlEngine, db: string): string {
  const name = quoteIdent(engine, db);
  return engine === "PostgreSQL" || engine === "Presto" || engine === "SQLServer"
    ? `DROP SCHEMA ${name};`
    : `DROP DATABASE ${name};`;
}

export function renameDatabaseStatement(
  engine: SqlEngine,
  db: string,
  newName: string,
): string {
  const from = quoteIdent(engine, db);
  const to = quoteIdent(engine, newName);
  if (engine === "ClickHouse") return `RENAME DATABASE ${from} TO ${to};`;
  if (engine === "SQLServer") return `-- SQL Server does not support direct schema rename. Create ${to}, transfer objects from ${from}, then drop ${from}.`;
  // PostgreSQL / Presto operate on schemas.
  return `ALTER SCHEMA ${from} RENAME TO ${to};`;
}

export function dropTriggerStatement(
  engine: SqlEngine,
  schema: string | null,
  trigger: string,
  table?: string | null,
): string {
  if (engine === "PostgreSQL" && table) {
    return `DROP TRIGGER ${quoteIdent(engine, trigger)} ON ${qualifiedName(engine, {
      schema,
      name: table,
    })};`;
  }
  if (engine === "SQLServer" && table) {
    return `DROP TRIGGER ${qualifiedName(engine, { schema, name: trigger })};`;
  }
  return `DROP TRIGGER ${qualifiedName(engine, { schema, name: trigger })};`;
}

export function disableTriggerStatement(
  engine: SqlEngine,
  schema: string | null,
  trigger: string,
  table: string,
): string {
  if (engine === "SQLServer") {
    return `DISABLE TRIGGER ${quoteIdent(engine, trigger)} ON ${qualifiedName(engine, { schema, name: table })};`;
  }
  return `ALTER TABLE ${qualifiedName(engine, { schema, name: table })} DISABLE TRIGGER ${quoteIdent(
    engine,
    trigger,
  )};`;
}

// ---------------------------------------------------------------------------
// Routine invocation + CREATE skeletons (always inserted into the editor)
// ---------------------------------------------------------------------------

/** `CALL <proc>(...)` for stored procedures. */
export function callStatement(engine: SqlEngine, target: ObjectTarget): string {
  if (engine === "SQLServer") return `EXEC ${qualifiedName(engine, target)} /* params */;`;
  return `CALL ${qualifiedName(engine, target)}(/* params */);`;
}

/** `SELECT <fn>(...)` to invoke / test a function. */
export function functionCallStatement(engine: SqlEngine, target: ObjectTarget): string {
  return `SELECT ${qualifiedName(engine, target)}(/* params */);`;
}

/** Best-effort `CREATE <kind>` skeleton for the "new object" action. */
export function createTemplate(
  engine: SqlEngine,
  kind: ObjectKind,
  schema: string | null,
): string {
  const q = (name: string) => qualifiedName(engine, { schema, name });
  switch (kind) {
    case "table":
      if (engine === "PostgreSQL") {
        return `CREATE TABLE ${q("new_table")} (\n  "id" serial PRIMARY KEY\n);`;
      }
      if (engine === "ClickHouse") {
        return `CREATE TABLE ${q("new_table")} (\n  \`id\` UInt64\n)\nENGINE = MergeTree()\nORDER BY \`id\`;`;
      }
      if (engine === "Presto") {
        return `CREATE TABLE ${q("new_table")} (\n  "id" bigint\n);`;
      }
      if (engine === "SQLServer") {
        return `CREATE TABLE ${q("new_table")} (\n  [id] int IDENTITY(1,1) NOT NULL PRIMARY KEY\n);`;
      }
      return `CREATE TABLE ${q("new_table")} (\n  \`id\` INT NOT NULL AUTO_INCREMENT,\n  PRIMARY KEY (\`id\`)\n);`;
    case "view":
    case "materialized_view": {
      const kw = kind === "materialized_view" ? "MATERIALIZED VIEW" : "VIEW";
      return `CREATE ${kw} ${q("new_view")} AS\nSELECT 1;`;
    }
    case "procedure":
      if (engine === "PostgreSQL") {
        return `CREATE PROCEDURE ${q("new_procedure")}()\nLANGUAGE plpgsql\nAS $$\nBEGIN\n  -- body\nEND;\n$$;`;
      }
      if (engine === "SQLServer") {
        return `CREATE OR ALTER PROCEDURE ${q("new_procedure")}\nAS\nBEGIN\n  SET NOCOUNT ON;\n  -- body\nEND;`;
      }
      return `DELIMITER //\nCREATE PROCEDURE ${q("new_procedure")}()\nBEGIN\n  -- body\nEND //\nDELIMITER ;`;
    case "function":
      if (engine === "PostgreSQL") {
        return `CREATE FUNCTION ${q("new_function")}()\nRETURNS integer\nLANGUAGE plpgsql\nAS $$\nBEGIN\n  RETURN 0;\nEND;\n$$;`;
      }
      if (engine === "SQLServer") {
        return `CREATE OR ALTER FUNCTION ${q("new_function")}()\nRETURNS int\nAS\nBEGIN\n  RETURN 0;\nEND;`;
      }
      return `DELIMITER //\nCREATE FUNCTION ${q("new_function")}()\nRETURNS INT DETERMINISTIC\nBEGIN\n  RETURN 0;\nEND //\nDELIMITER ;`;
    case "trigger":
      if (engine === "PostgreSQL") {
        return `CREATE TRIGGER new_trigger\nBEFORE INSERT ON ${q("table_name")}\nFOR EACH ROW EXECUTE FUNCTION trigger_function();`;
      }
      if (engine === "SQLServer") {
        return `CREATE OR ALTER TRIGGER ${q("new_trigger")}\nON ${q("table_name")}\nAFTER INSERT\nAS\nBEGIN\n  SET NOCOUNT ON;\n  -- body\nEND;`;
      }
      return `CREATE TRIGGER ${q("new_trigger")}\nBEFORE INSERT ON ${q("table_name")}\nFOR EACH ROW\nBEGIN\n  -- body\nEND;`;
    case "event":
      return `CREATE EVENT ${q("new_event")}\nON SCHEDULE EVERY 1 DAY\nDO\n  -- body\n  SELECT 1;`;
    case "sequence":
      return `CREATE SEQUENCE ${q("new_sequence")};`;
    case "dictionary":
      return `CREATE DICTIONARY ${q("new_dictionary")} (\n  id UInt64\n)\nPRIMARY KEY id\nSOURCE(NULL())\nLAYOUT(FLAT())\nLIFETIME(0);`;
    default:
      return `-- new ${kind}`;
  }
}
