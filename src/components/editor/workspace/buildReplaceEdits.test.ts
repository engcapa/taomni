import { describe, expect, it } from "vitest";
import { buildReplaceWorkspaceEdit, workspaceSearchMatchKey } from "./buildReplaceEdits";
import type { WorkspaceSearchMatch } from "../../../lib/editor/workspaceSearch";

function match(overrides: Partial<WorkspaceSearchMatch> = {}): WorkspaceSearchMatch {
  return {
    rootId: "app",
    rootName: "app",
    rootPath: "/repo/app",
    path: "src/a.ts",
    lineNumber: 2,
    column: 4,
    matchStart: 4,
    matchEnd: 7,
    lineText: "let foo = 1",
    ...overrides,
  };
}

describe("buildReplaceWorkspaceEdit", () => {
  it("groups selected matches into file edits with absolute paths", () => {
    const a = match();
    const b = match({ path: "src/b.ts", lineNumber: 1, matchStart: 0, matchEnd: 3, lineText: "foo bar" });
    const edit = buildReplaceWorkspaceEdit([a, b], "bar", new Set([workspaceSearchMatchKey(a)]));
    expect(edit.documentEdits).toHaveLength(1);
    expect(edit.documentEdits[0].path).toBe("/repo/app/src/a.ts");
    expect(edit.documentEdits[0].edits[0]).toEqual({
      range: {
        start: { line: 1, character: 4 },
        end: { line: 1, character: 7 },
      },
      newText: "bar",
    });
  });

  it("includes every match when no selection set is provided", () => {
    const edit = buildReplaceWorkspaceEdit([
      match(),
      match({ path: "src/b.ts", lineNumber: 3, matchStart: 1, matchEnd: 2 }),
    ], "x");
    expect(edit.documentEdits).toHaveLength(2);
  });
});
