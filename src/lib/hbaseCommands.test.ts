import { describe, expect, it } from "vitest";
import {
  HBASE_COMMANDS,
  classifyStatement,
  isWriteCommand,
  isDestructiveCommand,
  commandVerb,
  commandSupported,
  shellQuote,
  scanStatement,
  getStatement,
  putStatement,
  deleteStatement,
  deleteAllStatement,
  describeStatement,
  countStatement,
  existsStatement,
  dropStatement,
  enableStatement,
  disableStatement,
  createTemplate,
  alterTemplate,
  hbaseResultToGrid,
} from "./hbaseCommands";
import type { HBaseShellResult } from "./ipc";

describe("commandVerb", () => {
  it("extracts the leading verb, lowercased", () => {
    expect(commandVerb("SCAN 'tbl'")).toBe("scan");
    expect(commandVerb("  put 'tbl', 'r', 'cf:q', 'v'")).toBe("put");
    expect(commandVerb("list")).toBe("list");
    expect(commandVerb("")).toBe("");
  });
});

describe("classifyStatement", () => {
  it("flags write verbs", () => {
    for (const verb of ["create", "drop", "put", "delete", "deleteall", "alter", "enable", "disable", "truncate"]) {
      expect(isWriteCommand(`${verb} 'tbl'`)).toBe(true);
      expect(classifyStatement(`${verb} 'tbl'`).isWrite).toBe(true);
    }
  });

  it("does not flag read/meta verbs as writes", () => {
    for (const verb of ["list", "describe", "scan", "get", "count", "exists", "status", "version", "help"]) {
      expect(isWriteCommand(`${verb} 'tbl'`)).toBe(false);
    }
  });

  it("flags destructive verbs", () => {
    for (const verb of ["drop", "delete", "deleteall", "disable", "truncate"]) {
      expect(isDestructiveCommand(`${verb} 'tbl'`)).toBe(true);
    }
    // writes that are not destructive
    for (const verb of ["create", "put", "enable", "alter"]) {
      expect(isDestructiveCommand(`${verb} 'tbl'`)).toBe(false);
      expect(isWriteCommand(`${verb} 'tbl'`)).toBe(true);
    }
  });
});

describe("commandSupported", () => {
  it("gates admin ops off the REST transport", () => {
    for (const verb of ["enable", "disable", "alter"]) {
      expect(commandSupported(verb, "rest")).toBe(false);
      expect(commandSupported(verb, "native")).toBe(true);
      expect(commandSupported(verb, "thrift")).toBe(true);
    }
  });

  it("allows core verbs on every transport", () => {
    for (const verb of ["list", "scan", "get", "put", "delete", "deleteall", "create", "drop", "count", "exists"]) {
      expect(commandSupported(verb, "rest")).toBe(true);
      expect(commandSupported(verb, "native")).toBe(true);
      expect(commandSupported(verb, "thrift")).toBe(true);
    }
  });

  it("allows unknown verbs (no spec)", () => {
    expect(commandSupported("whoami", "rest")).toBe(true);
  });
});

describe("shellQuote", () => {
  it("wraps and escapes", () => {
    expect(shellQuote("tbl")).toBe("'tbl'");
    expect(shellQuote("a'b")).toBe("'a\\'b'");
    expect(shellQuote("a\\b")).toBe("'a\\\\b'");
  });
});

describe("statement builders", () => {
  it("scanStatement with and without options", () => {
    expect(scanStatement("tbl")).toBe("scan 'tbl'");
    expect(scanStatement("tbl", { limit: 50 })).toBe("scan 'tbl', {LIMIT => 50}");
    expect(scanStatement("tbl", { limit: 10, startRow: "r1", columns: ["cf:q"] })).toBe(
      "scan 'tbl', {LIMIT => 10, STARTROW => 'r1', COLUMNS => ['cf:q']}",
    );
    expect(scanStatement("tbl", { columns: ["cf"] })).toBe("scan 'tbl', {COLUMNS => ['cf']}");
  });

  it("row builders", () => {
    expect(getStatement("tbl", "r1")).toBe("get 'tbl', 'r1'");
    expect(getStatement("tbl", "r1", "cf:q")).toBe("get 'tbl', 'r1', 'cf:q'");
    expect(putStatement("tbl", "r1", "cf:q", "v")).toBe("put 'tbl', 'r1', 'cf:q', 'v'");
    expect(deleteStatement("tbl", "r1", "cf:q")).toBe("delete 'tbl', 'r1', 'cf:q'");
    expect(deleteAllStatement("tbl", "r1")).toBe("deleteall 'tbl', 'r1'");
  });

  it("table builders", () => {
    expect(describeStatement("tbl")).toBe("describe 'tbl'");
    expect(countStatement("tbl")).toBe("count 'tbl'");
    expect(existsStatement("tbl")).toBe("exists 'tbl'");
    expect(dropStatement("tbl")).toBe("drop 'tbl'");
    expect(enableStatement("tbl")).toBe("enable 'tbl'");
    expect(disableStatement("tbl")).toBe("disable 'tbl'");
    expect(createTemplate("tbl", "cf1")).toBe("create 'tbl', 'cf1'");
    expect(alterTemplate("tbl", "cf1")).toBe("alter 'tbl', {NAME => 'cf1', VERSIONS => 1}");
  });
});

describe("HBASE_COMMANDS catalogue", () => {
  it("has unique verbs and consistent write flags", () => {
    const verbs = HBASE_COMMANDS.map((c) => c.verb);
    expect(new Set(verbs).size).toBe(verbs.length);
    for (const spec of HBASE_COMMANDS) {
      if (spec.destructive) expect(spec.isWrite).toBe(true);
      if (spec.category === "meta" || spec.category === "read") expect(spec.isWrite).toBe(false);
    }
  });
});

describe("hbaseResultToGrid", () => {
  it("maps columns/rows and reports text type", () => {
    const result: HBaseShellResult = {
      command: "scan 'tbl'",
      message: "2 cell(s)",
      columns: ["ROW", "COLUMN", "VALUE"],
      rows: [
        ["r1", "cf:q", "v1"],
        ["r2", "cf:q", "v2"],
      ],
      warnings: ["w"],
      durationMs: 12,
    };
    expect(hbaseResultToGrid(result)).toEqual({
      columns: [
        { name: "ROW", type: "text" },
        { name: "COLUMN", type: "text" },
        { name: "VALUE", type: "text" },
      ],
      rows: [
        ["r1", "cf:q", "v1"],
        ["r2", "cf:q", "v2"],
      ],
      rowsAffected: 0,
      durationMs: 12,
      warnings: ["w"],
    });
  });

  it("tolerates a missing warnings array", () => {
    const result = {
      command: "list",
      message: "0 table(s)",
      columns: [],
      rows: [],
      durationMs: 3,
    } as unknown as HBaseShellResult;
    expect(hbaseResultToGrid(result).warnings).toEqual([]);
  });
});
