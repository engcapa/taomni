import { describe, expect, it } from "vitest";
import type { GitChange } from "../../../lib/git";
import type { WorkspaceEntry } from "../../../lib/editor/workspace";
import {
  compactEntryName,
  flatExtensionGroup,
  gitChangeForPath,
  gitDirectoryChangeCount,
} from "./codeWorkspaceModel";

const entry = (name: string, path: string): WorkspaceEntry => ({
  name,
  path,
  fileType: "dir",
  size: 0,
  mtime: 0,
  isHidden: false,
});

describe("project tree model helpers", () => {
  it("compactEntryName folds single-child chain suffixes", () => {
    expect(compactEntryName(entry("src", "src"), undefined)).toBe("src");
    expect(compactEntryName(entry("src", "src"), { path: "src" })).toBe("src");
    expect(compactEntryName(entry("src", "src"), { path: "src/main/java" })).toBe("src/main/java");
  });

  it("flatExtensionGroup keys by lowercase extension", () => {
    expect(flatExtensionGroup("a/b/Foo.TS")).toBe(".ts");
    expect(flatExtensionGroup("Makefile")).toBe("No extension");
    expect(flatExtensionGroup("archive.")).toBe("No extension");
  });

  it("gitChange helpers read the rootId:path map", () => {
    const change: GitChange = {
      path: "src/a.ts",
      oldPath: null,
      status: "modified",
      staged: false,
      unstaged: true,
      conflict: false,
    };
    const map = new Map<string, GitChange>([["root1:src/a.ts", change]]);
    expect(gitChangeForPath(map, "root1", "src/a.ts")).toEqual(change);
    expect(gitChangeForPath(map, "root1", "src/b.ts")).toBeUndefined();
    expect(gitDirectoryChangeCount(map, "root1", "src")).toBe(1);
    expect(gitDirectoryChangeCount(map, "root1", "")).toBe(1);
    expect(gitDirectoryChangeCount(map, "other", "")).toBe(0);
  });
});
