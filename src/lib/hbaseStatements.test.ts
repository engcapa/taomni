import { describe, expect, it } from "vitest";
import { splitHBaseStatements } from "./hbaseStatements";

describe("splitHBaseStatements", () => {
  it("returns a single statement unchanged", () => {
    expect(splitHBaseStatements("list")).toEqual(["list"]);
    expect(
      splitHBaseStatements("put 'tbl', 'row1', 'cf:q', 'value'"),
    ).toEqual(["put 'tbl', 'row1', 'cf:q', 'value'"]);
  });

  it("splits consecutive commands separated by newlines (issue #111)", () => {
    const input = [
      "put 'tbl', 'row1', 'cf:addattr_18431e32c87_1667284893568', 'v1'",
      "put 'tbl', 'row2', 'cf:addattr_18431e32c87_1667284893568', 'v2'",
    ].join("\n");
    expect(splitHBaseStatements(input)).toEqual([
      "put 'tbl', 'row1', 'cf:addattr_18431e32c87_1667284893568', 'v1'",
      "put 'tbl', 'row2', 'cf:addattr_18431e32c87_1667284893568', 'v2'",
    ]);
  });

  it("splits commands separated by semicolons", () => {
    expect(splitHBaseStatements("list; status; version")).toEqual([
      "list",
      "status",
      "version",
    ]);
  });

  it("drops empty statements and trailing separators", () => {
    expect(splitHBaseStatements("list;\n\n;  \nstatus\n")).toEqual([
      "list",
      "status",
    ]);
  });

  it("ignores separators inside single and double quotes", () => {
    expect(
      splitHBaseStatements("put 't', 'r', 'cf:q', 'line1\nline2'"),
    ).toEqual(["put 't', 'r', 'cf:q', 'line1\nline2'"]);
    expect(
      splitHBaseStatements("put 't', 'r', 'cf:q', 'a;b'"),
    ).toEqual(["put 't', 'r', 'cf:q', 'a;b'"]);
  });

  it("does not split inside option maps or column lists", () => {
    expect(
      splitHBaseStatements("scan 'tbl', {LIMIT => 10, COLUMNS => ['cf:a', 'cf:b']}"),
    ).toEqual(["scan 'tbl', {LIMIT => 10, COLUMNS => ['cf:a', 'cf:b']}"]);
  });

  it("keeps a multi-line create as one statement via trailing-comma continuation", () => {
    const input = "create 'tbl',\n  {NAME => 'cf1'},\n  {NAME => 'cf2'}";
    expect(splitHBaseStatements(input)).toEqual([
      "create 'tbl', {NAME => 'cf1'}, {NAME => 'cf2'}",
    ]);
  });

  it("honors backslash line continuation", () => {
    const input = "put 't', 'r', \\\n  'cf:q', 'v'";
    expect(splitHBaseStatements(input)).toEqual(["put 't', 'r', 'cf:q', 'v'"]);
  });

  it("does not toggle quote state on escaped quotes", () => {
    const input = "put 't', 'r', 'cf:q', 'a\\'b'\nlist";
    expect(splitHBaseStatements(input)).toEqual([
      "put 't', 'r', 'cf:q', 'a\\'b'",
      "list",
    ]);
  });

  it("handles CRLF line endings", () => {
    expect(splitHBaseStatements("list\r\nstatus")).toEqual(["list", "status"]);
  });

  it("returns an empty array for blank input", () => {
    expect(splitHBaseStatements("")).toEqual([]);
    expect(splitHBaseStatements("   \n  \n")).toEqual([]);
  });
});
