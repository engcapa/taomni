import { describe, expect, it } from "vitest";
import { formatSql } from "./formatSql";

describe("formatSql", () => {
  it("formats MySQL SQL with uppercase keywords", () => {
    const formatted = formatSql("select id, name from users where id=1 order by name desc", "MySQL");

    expect(formatted).toContain("SELECT");
    expect(formatted).toContain("FROM");
    expect(formatted).toContain("WHERE");
    expect(formatted).toContain("ORDER BY");
    expect(formatted).toContain("id = 1");
  });

  it("uses a SQL Server formatter dialect for bracket identifiers and TOP", () => {
    const formatted = formatSql("select top (10) [id] from [users] where [id]=1", "SQLServer");

    expect(formatted).toContain("TOP (10)");
    expect(formatted).toContain("[id]");
    expect(formatted).toContain("[users]");
  });
});
