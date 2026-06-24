import { describe, it, expect } from "vitest";
import {
  asSqlEngine,
  quoteIdent,
  qualifiedName,
  sqlLiteral,
  setDefaultSchemaSql,
  categoriesForEngine,
  supportsInlineEdit,
  supportsIndexes,
  actionMode,
  selectStatement,
  insertStatement,
  updateStatement,
  deleteStatement,
  truncateStatement,
  renameTableStatement,
  dropStatement,
  dropColumnStatement,
  alterColumnStatement,
  dropIndexStatement,
  dropDatabaseStatement,
  renameDatabaseStatement,
  dropTriggerStatement,
  disableTriggerStatement,
  callStatement,
  functionCallStatement,
  createTemplate,
} from "./sqlDialect";

describe("sqlDialect identifiers", () => {
  it("quotes per engine and escapes the quote char", () => {
    expect(quoteIdent("MySQL", "a`b")).toBe("`a``b`");
    expect(quoteIdent("ClickHouse", "x")).toBe("`x`");
    expect(quoteIdent("PostgreSQL", 'a"b')).toBe('"a""b"');
    expect(quoteIdent("Presto", "x")).toBe('"x"');
    expect(quoteIdent("SQLServer", "a]b")).toBe("[a]]b]");
  });

  it("builds qualified names, including Presto catalog", () => {
    expect(qualifiedName("MySQL", { schema: "db", name: "t" })).toBe("`db`.`t`");
    expect(qualifiedName("MySQL", { name: "t" })).toBe("`t`");
    expect(qualifiedName("Presto", { catalog: "c", schema: "s", name: "t" })).toBe(
      '"c"."s"."t"',
    );
    expect(qualifiedName("Presto", { schema: "s", name: "t" })).toBe('"s"."t"');
    expect(qualifiedName("SQLServer", { schema: "dbo", name: "orders" })).toBe(
      "[dbo].[orders]",
    );
  });

  it("escapes string literals and passes NULL through", () => {
    expect(sqlLiteral("a'b")).toBe("'a''b'");
    expect(sqlLiteral(null)).toBe("NULL");
  });

  it("narrows engine strings", () => {
    expect(asSqlEngine("PostgreSQL")).toBe("PostgreSQL");
    expect(asSqlEngine("SQLServer")).toBe("SQLServer");
    expect(asSqlEngine("nonsense")).toBe("MySQL");
  });

  it("emits the right set-default statement", () => {
    expect(setDefaultSchemaSql("PostgreSQL", "s")).toBe('SET search_path TO "s"');
    expect(setDefaultSchemaSql("Presto", "s", "c")).toBe('USE "c"."s"');
    expect(setDefaultSchemaSql("MySQL", "s")).toBe("USE `s`");
    expect(setDefaultSchemaSql("SQLServer", "dbo")).toContain("[dbo].[table_name]");
  });
});

describe("sqlDialect capabilities", () => {
  it("exposes per-engine folder categories", () => {
    expect(categoriesForEngine("MySQL")).toContain("trigger");
    expect(categoriesForEngine("PostgreSQL")).toContain("sequence");
    expect(categoriesForEngine("SQLServer")).toContain("procedure");
    expect(categoriesForEngine("ClickHouse")).toContain("dictionary");
    expect(categoriesForEngine("Presto")).toEqual(["table", "view"]);
  });

  it("gates inline edit / indexes to row stores", () => {
    expect(supportsInlineEdit("MySQL")).toBe(true);
    expect(supportsInlineEdit("SQLServer")).toBe(true);
    expect(supportsInlineEdit("ClickHouse")).toBe(false);
    expect(supportsIndexes("PostgreSQL")).toBe(true);
    expect(supportsIndexes("SQLServer")).toBe(true);
    expect(supportsIndexes("Presto")).toBe(false);
  });

  it("routes destructive actions correctly", () => {
    expect(actionMode("MySQL", "drop")).toBe("execute");
    expect(actionMode("MySQL", "renameDatabase")).toBe("disabled");
    expect(actionMode("PostgreSQL", "renameDatabase")).toBe("execute");
    expect(actionMode("PostgreSQL", "disableTrigger")).toBe("execute");
    expect(actionMode("SQLServer", "disableTrigger")).toBe("execute");
    expect(actionMode("SQLServer", "renameDatabase")).toBe("disabled");
    expect(actionMode("MySQL", "disableTrigger")).toBe("disabled");
    expect(actionMode("Presto", "drop")).toBe("editor");
    expect(actionMode("Presto", "disableTrigger")).toBe("disabled");
  });
});

describe("sqlDialect DML templates", () => {
  const t = { schema: "db", name: "orders" };

  it("builds SELECT with explicit columns or *", () => {
    expect(selectStatement("MySQL", t, ["id", "total"], 100)).toContain(
      "SELECT `id`, `total`\nFROM `db`.`orders`\nLIMIT 100;",
    );
    expect(selectStatement("MySQL", t, [], 50)).toContain("SELECT *\nFROM `db`.`orders`");
    expect(selectStatement("SQLServer", t, ["id"], 25)).toContain(
      "SELECT TOP (25) [id]\nFROM [db].[orders];",
    );
  });

  it("builds INSERT with placeholders", () => {
    const sql = insertStatement("PostgreSQL", { schema: "s", name: "t" }, ["a", "b"]);
    expect(sql).toContain('INSERT INTO "s"."t"');
    expect(sql).toContain('("a", "b")');
    expect(sql).toContain("(<a>, <b>)");
  });

  it("uses PK columns in UPDATE/DELETE WHERE", () => {
    const upd = updateStatement("MySQL", t, ["id", "total", "status"], ["id"]);
    expect(upd).toContain("SET `total` = <total>,\n  `status` = <status>");
    expect(upd).toContain("WHERE `id` = <id>");
    const del = deleteStatement("MySQL", t, ["id"]);
    expect(del).toBe("DELETE FROM `db`.`orders`\nWHERE `id` = <id>;");
  });

  it("emits ClickHouse ALTER mutations for UPDATE/DELETE", () => {
    const ct = { schema: "db", name: "events" };
    expect(updateStatement("ClickHouse", ct, ["id", "v"], ["id"])).toContain(
      "ALTER TABLE `db`.`events`\nUPDATE `v` = <v>",
    );
    expect(deleteStatement("ClickHouse", ct, ["id"])).toContain(
      "ALTER TABLE `db`.`events`\nDELETE WHERE `id` = <id>;",
    );
  });
});

describe("sqlDialect destructive builders", () => {
  const t = { schema: "db", name: "orders" };

  it("truncate / drop / rename", () => {
    expect(truncateStatement("MySQL", t)).toBe("TRUNCATE TABLE `db`.`orders`;");
    expect(dropStatement("MySQL", "table", t)).toBe("DROP TABLE `db`.`orders`;");
    expect(dropStatement("PostgreSQL", "materialized_view", { schema: "s", name: "v" })).toBe(
      'DROP MATERIALIZED VIEW "s"."v";',
    );
    expect(renameTableStatement("MySQL", t, "orders_2")).toBe(
      "RENAME TABLE `db`.`orders` TO `db`.`orders_2`;",
    );
    expect(renameTableStatement("PostgreSQL", { schema: "s", name: "t" }, "t2")).toBe(
      'ALTER TABLE "s"."t" RENAME TO "t2";',
    );
  });

  it("column + index drops", () => {
    expect(dropColumnStatement("MySQL", t, "note")).toBe(
      "ALTER TABLE `db`.`orders` DROP COLUMN `note`;",
    );
    expect(dropIndexStatement("MySQL", "db", "orders", "idx_a")).toBe(
      "DROP INDEX `idx_a` ON `db`.`orders`;",
    );
    expect(dropIndexStatement("PostgreSQL", "s", "t", "idx_a")).toBe(
      'DROP INDEX "s"."idx_a";',
    );
    expect(dropIndexStatement("ClickHouse", "db", "t", "idx_a")).toBe(
      "ALTER TABLE `db`.`t` DROP INDEX `idx_a`;",
    );
  });

  it("alter column per engine", () => {
    expect(
      alterColumnStatement("MySQL", t, { oldName: "total", type: "DECIMAL(12,2)" }),
    ).toBe("ALTER TABLE `db`.`orders` MODIFY COLUMN `total` DECIMAL(12,2);");
    expect(
      alterColumnStatement("MySQL", t, { oldName: "a", newName: "b", type: "INT" }),
    ).toBe("ALTER TABLE `db`.`orders` CHANGE COLUMN `a` `b` INT;");
    expect(
      alterColumnStatement("PostgreSQL", { schema: "s", name: "t" }, {
        oldName: "a",
        type: "text",
        nullable: false,
      }),
    ).toContain('ALTER TABLE "s"."t" ALTER COLUMN "a" TYPE text;');
  });

  it("database drop/rename and triggers", () => {
    expect(dropDatabaseStatement("MySQL", "db")).toBe("DROP DATABASE `db`;");
    expect(dropDatabaseStatement("PostgreSQL", "s")).toBe('DROP SCHEMA "s";');
    expect(renameDatabaseStatement("ClickHouse", "a", "b")).toBe("RENAME DATABASE `a` TO `b`;");
    expect(renameDatabaseStatement("PostgreSQL", "a", "b")).toBe('ALTER SCHEMA "a" RENAME TO "b";');
    expect(dropTriggerStatement("PostgreSQL", "s", "trg", "t")).toBe(
      'DROP TRIGGER "trg" ON "s"."t";',
    );
    expect(dropTriggerStatement("MySQL", "db", "trg")).toBe("DROP TRIGGER `db`.`trg`;");
    expect(disableTriggerStatement("PostgreSQL", "s", "trg", "t")).toBe(
      'ALTER TABLE "s"."t" DISABLE TRIGGER "trg";',
    );
  });
});

describe("sqlDialect routine invocation + templates", () => {
  it("CALL / function invocation", () => {
    expect(callStatement("MySQL", { schema: "db", name: "p" })).toBe(
      "CALL `db`.`p`(/* params */);",
    );
    expect(functionCallStatement("PostgreSQL", { schema: "s", name: "f" })).toBe(
      'SELECT "s"."f"(/* params */);',
    );
  });

  it("create templates per engine/kind", () => {
    expect(createTemplate("MySQL", "table", "db")).toContain("CREATE TABLE `db`.`new_table`");
    expect(createTemplate("ClickHouse", "table", "db")).toContain("ENGINE = MergeTree()");
    expect(createTemplate("PostgreSQL", "function", "s")).toContain("LANGUAGE plpgsql");
    expect(createTemplate("MySQL", "view", "db")).toContain("CREATE VIEW `db`.`new_view`");
  });
});
