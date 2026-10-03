import { describe, expect, it } from "vitest";
import { dangerousConfirmationMessage, dangerousStatementReason } from "./sqlDangerousStatements";

describe("sqlDangerousStatements", () => {
  it.each([
    ["DROP TABLE t", "drop"],
    ["  drop database qa", "drop"],
    ["TRUNCATE TABLE t", "truncate"],
    ["delete from t", "delete-without-where"],
    ["UPDATE t SET a = 1", "update-without-where"],
    ["/* note */ DROP VIEW v", "drop"],
  ])("flags %s", (sql, reason) => {
    expect(dangerousStatementReason(sql)).toBe(reason);
  });

  it.each([
    "DELETE FROM t WHERE id = 1",
    "update t set a = 1 where id in (select id from u)",
    "SELECT 'drop table x'",
    "-- drop table x\nSELECT 1",
    "select `delete` from t",
    "INSERT INTO t VALUES ('truncate')",
    "",
  ])("does not flag %s", (sql) => {
    expect(dangerousStatementReason(sql)).toBeNull();
  });

  it("ignores WHERE that appears only in a string or comment", () => {
    expect(dangerousStatementReason("DELETE FROM t -- where id = 1")).toBe("delete-without-where");
    expect(dangerousStatementReason("UPDATE t SET note = 'where'")).toBe("update-without-where");
  });

  it("builds a message listing flagged statements with an overflow line", () => {
    expect(dangerousConfirmationMessage(["select 1"])).toBeNull();
    const message = dangerousConfirmationMessage(["select 1", "drop table a", "delete from b"], 1);
    expect(message).toContain("2 statements that can remove data");
    expect(message).toContain("• [DROP] drop table a");
    expect(message).toContain("… and 1 more");
  });
});
