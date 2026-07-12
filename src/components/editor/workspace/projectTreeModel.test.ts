import { describe, expect, it } from "vitest";
import type { GitChange } from "../../../lib/git";
import type { WorkspaceEntry } from "../../../lib/editor/workspace";
import {
  applyEditorEol,
  compactEntryName,
  flatExtensionGroup,
  flatSourceGroup,
  flatSourceRelativePath,
  gitChangeForPath,
  gitDirectoryChangeCount,
  matchesTreeFilter,
  normalizeEditorText,
  shouldHideEntry,
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

  it("flatSourceGroup keeps language/src top-level directories", () => {
    expect(flatSourceGroup("src/http2_connect.rs")).toBe("src");
    expect(flatSourceGroup("src-tauri/src/lib.rs")).toBe("src-tauri");
    expect(flatSourceGroup("README.md")).toBe("(root)");
    expect(flatSourceRelativePath("src/http2_connect.rs")).toBe("http2_connect.rs");
    expect(flatSourceRelativePath("src-tauri/src/lib.rs")).toBe("src/lib.rs");
  });

  it("matchesTreeFilter finds nested path substrings", () => {
    expect(matchesTreeFilter("http2_connect.rs", "src/net/http2_connect.rs", "http")).toBe(true);
    expect(matchesTreeFilter("main.rs", "src/main.rs", "http")).toBe(false);
  });

  it("shouldHideEntry skips dependency and VCS trees", () => {
    expect(shouldHideEntry(entry("node_modules", "node_modules"))).toBe(true);
    expect(shouldHideEntry(entry("pkg", "node_modules/pkg"))).toBe(true);
    expect(shouldHideEntry(entry("lib.rs", "src/lib.rs"))).toBe(false);
  });

  it("normalizeEditorText converts CRLF for the buffer and restores on save", () => {
    const normalized = normalizeEditorText("a\r\nb\r\n");
    expect(normalized).toEqual({ text: "a\nb\n", eol: "CRLF" });
    expect(applyEditorEol(normalized.text, normalized.eol)).toBe("a\r\nb\r\n");
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
