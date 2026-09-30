import { describe, expect, it } from "vitest";
import {
  NO_PRIMARY_KEY_WARNING,
  buildGridChangeStatements,
  gridChangeConfirmMessage,
  gridChangePreview,
  type GridRowChange,
} from "./dbGridChanges";

const columns = ["id", "name"];
const changes: GridRowChange[] = [
  { status: "inserted", values: ["3", null], original: null },
  { status: "updated", values: ["1", "b"], original: ["1", "a"] },
  { status: "updated", values: ["2", "x"], original: ["2", "x"] },
  { status: "deleted", values: ["2", "x"], original: ["2", "x"] },
];

describe("buildGridChangeStatements", () => {
  it("matches rows on the primary key", () => {
    const generated = buildGridChangeStatements({ engine: "MySQL", tableName: "`t`", columns, primaryKeys: ["id"], changes });
    expect(generated.statements).toEqual([
      "INSERT INTO `t` (`id`, `name`) VALUES ('3', NULL)",
      "UPDATE `t` SET `name` = 'b' WHERE `id` = '1'",
      "DELETE FROM `t` WHERE `id` = '2'",
    ]);
    expect(generated.whereUsesAllColumns).toBe(false);
    expect(gridChangePreview(generated).warning).toBeNull();
  });

  it("falls back to every column and warns without a primary key", () => {
    const generated = buildGridChangeStatements({
      engine: "PostgreSQL",
      tableName: '"t"',
      columns,
      primaryKeys: ["missing_from_result"],
      changes: [{ status: "deleted", values: ["2", null], original: ["2", null] }],
    });
    expect(generated.statements).toEqual(['DELETE FROM "t" WHERE "id" = \'2\' AND "name" IS NULL']);
    expect(generated.whereUsesAllColumns).toBe(true);
    expect(gridChangePreview(generated).warning).toBe(NO_PRIMARY_KEY_WARNING);
  });

  it("does not warn when only inserts run", () => {
    const generated = buildGridChangeStatements({
      engine: "MySQL",
      tableName: "`t`",
      columns,
      primaryKeys: [],
      changes: [changes[0]],
    });
    expect(generated.whereUsesAllColumns).toBe(false);
  });
});

describe("gridChangeConfirmMessage", () => {
  const counts = { inserted: 1, updated: 1, deleted: 1 };

  it("keeps the count-only message without a preview", () => {
    expect(gridChangeConfirmMessage(counts, null)).toBe(
      "Apply grid changes to the database?\n\nAdded: 1\nModified: 1\nDeleted: 1",
    );
  });

  it("lists the SQL and the warning", () => {
    const message = gridChangeConfirmMessage(counts, { statements: ["DELETE FROM t WHERE a = '1'"], warning: NO_PRIMARY_KEY_WARNING });
    expect(message).toContain(`⚠ ${NO_PRIMARY_KEY_WARNING}`);
    expect(message).toContain("SQL to execute (1):\nDELETE FROM t WHERE a = '1';");
  });

  it("truncates long previews", () => {
    const statements = Array.from({ length: 23 }, (_, index) => `DELETE FROM t WHERE id = ${index}`);
    const message = gridChangeConfirmMessage(counts, { statements, warning: null });
    expect(message).toContain("SQL to execute (23):");
    expect(message).toContain("DELETE FROM t WHERE id = 19;");
    expect(message).not.toContain("DELETE FROM t WHERE id = 20;");
    expect(message).toContain("… and 3 more");
  });
});
