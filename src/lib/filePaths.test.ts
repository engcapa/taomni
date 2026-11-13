import { describe, expect, it } from "vitest";
import { basename, joinPath, parentPath } from "./filePaths";
import { explorerCrumbs, sameExplorerPath } from "../components/explorer/explorerPaths";
import { normalizeExplorerInput } from "../components/explorer/explorerPathInput";

describe("Explorer local path roots", () => {
  it.each([
    ["/", "/"], ["/home/qa", "/home"], ["/file\\name", "/"],
    ["C:\\", "C:\\"], ["C:\\Users", "C:\\"], ["C:/Users/qa", "C:/Users"], ["C:/Users", "C:/"],
    ["\\\\server\\share", "\\\\server\\share"], ["\\\\server\\share\\folder", "\\\\server\\share"],
    ["//server/share/", "//server/share"], ["//server/share/folder/child", "//server/share/folder"],
  ])("parent %s -> %s", (path, expected) => expect(parentPath(path)).toBe(expected));
  it.each([
    ["/", "file", "/file"], ["C:\\Users", "file", "C:\\Users\\file"],
    ["C:/Users", "file", "C:/Users/file"], ["\\\\server\\share", "file", "\\\\server\\share\\file"],
  ])("joins %s with %s", (path, name, expected) => expect(joinPath(path, name)).toBe(expected));
  it.each([
    ["/home/qa/.././file", "/home/file"], ["/../../", "/"], ["C:\\Users\\..\\Temp", "C:\\Temp"],
    ["\\\\server\\share\\..\\folder", "\\\\server\\share\\folder"], ["//server/share/folder/..", "//server/share"],
  ])("normalizes address %s without escaping its root", (input, expected) => expect(normalizeExplorerInput(input)).toBe(expected));
  it("retains POSIX backslashes and recognizes Windows basenames", () => {
    expect(basename("/path/file\\name")).toBe("file\\name");
    expect(basename("C:\\Users\\file.txt")).toBe("file.txt");
  });
  it("UNC breadcrumbs treat host/share as one root", () => {
    expect(explorerCrumbs("\\\\server\\share\\folder")).toEqual([
      { name: "\\\\server\\share", path: "\\\\server\\share" }, { name: "folder", path: "\\\\server\\share\\folder" },
    ]);
    expect(explorerCrumbs("C:\\Users")).toEqual([{ name: "C:", path: "C:\\" }, { name: "Users", path: "C:\\Users" }]);
  });
  it("uses Windows case-insensitive separators without lowercasing Linux folders", () => {
    expect(sameExplorerPath("C:\\Users\\QA", "c:/users/qa/")).toBe(true);
    expect(sameExplorerPath("/home/QA", "/home/qa")).toBe(false);
  });
});
