import "./tests/dbClientTab/harness";
import { cleanup, configure } from "@testing-library/react";
import { afterEach, describe, vi } from "vitest";
import { registerDbClientTabBehavior1Cases } from "./tests/dbClientTab/behavior1.cases";
import { registerDbClientTabEditing2Cases } from "./tests/dbClientTab/editing2.cases";
import { contextMenuShow, dbChildProps } from "./tests/dbClientTab/harness";
import { registerDbClientTabHistory3Cases } from "./tests/dbClientTab/history3.cases";

// Full DbClientTab mounts are heavy; the 1s default flakes when workers are busy.
configure({ asyncUtilTimeout: 5000 });

describe("DbClientTab connection lifecycle", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.clearAllMocks();
    localStorage.clear();
    dbChildProps.schemaTree = null;
    dbChildProps.sqlEditor = null;
    dbChildProps.editorInitialDocFallback = "select 1";
    dbChildProps.generatedSql = "select 1\nORDER BY \"one\" DESC;";
    dbChildProps.generatedRequest = null;
    contextMenuShow.mockClear();
  });
  registerDbClientTabEditing2Cases();
  registerDbClientTabHistory3Cases();
});

registerDbClientTabBehavior1Cases();
