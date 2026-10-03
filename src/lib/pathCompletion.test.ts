import { describe, expect, it } from "vitest";
import { commonPathPrefix, pathCompletionQuery, pathSuggestions, resolvePathInput } from "./pathCompletion";
import type { FileEntry } from "./sftp";

function entry(name: string, overrides: Partial<FileEntry> = {}): FileEntry {
  return { name, path: `/work/${name}`, size: 0, mtime: 0, mode: 0, fileType: "dir", isHidden: name.startsWith("."), ...overrides };
}

describe("path completion queries", () => {
  it.each([
    ["/var/lo", "/work", "/var/", "lo"],
    ["/", "/work", "/", ""],
    ["", "/work", "/work", ""],
    ["pro", "/work", "/work/", "pro"],
    ["../pro", "/work", "/work/../", "pro"],
    ["'/var/logs with spaces/'", "/work", "/var/logs with spaces/", ""],
    ["~/Doc", "/work", "/home/me/", "Doc"],
    ["~", "/work", "/home/me/", ""],
  ])("finds the parent and prefix of %s", (value, currentPath, directory, prefix) => {
    expect(pathCompletionQuery(value, currentPath, "/home/me")).toMatchObject({ directory, prefix, windows: false });
  });

  it.each([
    ["C:\\Us", "C:\\work", "C:\\", "Us", "\\"],
    ["C:/Us", "C:/work", "C:/", "Us", "/"],
    ["C:", "C:\\work", "C:\\", "", "\\"],
    ["\\\\server\\share\\Do", "C:\\work", "\\\\server\\share\\", "Do", "\\"],
    ["\\\\", "C:\\work", "\\\\", "", "\\"],
    ["doc", "C:\\work", "C:\\work\\", "doc", "\\"],
    ["/Users/Me/Do", "C:\\work", "C:/Users/Me/", "Do", "/"],
  ])("supports drive, UNC and relative Windows paths: %s", (value, currentPath, directory, prefix, separator) => {
    expect(pathCompletionQuery(value, currentPath)).toEqual({ directory, prefix, separator, windows: true });
  });

  it("keeps a Windows-hosted SFTP path in the remote POSIX namespace", () => {
    expect(pathCompletionQuery("/C:/Users/te", "/C:/work", null, false)).toEqual({ directory: "/C:/Users/", prefix: "te", separator: "/", windows: false });
    expect(pathCompletionQuery("C:/Users/te", "/C:/work", null, false)).toEqual({ directory: "/C:/Users/", prefix: "te", separator: "/", windows: false });
    expect(pathCompletionQuery("C:\\Users\\te", "/C:/work", null, false)).toEqual({ directory: "/C:/Users/", prefix: "te", separator: "/", windows: false });
    expect(pathCompletionQuery("C:/Users/te", "/", "/C:/Users/qa", false)).toEqual({ directory: "/C:/Users/", prefix: "te", separator: "/", windows: false });
  });

  it("resolves relative navigation against the pane and preserves filesystem dot/symlink semantics", () => {
    expect(resolvePathInput("../docs", "/work/link")).toBe("/work/link/../docs");
    expect(resolvePathInput(" '~/Documents' ", "C:\\work", "C:\\Users\\me", true)).toBe("C:\\Users\\me/Documents");
  });
});

describe("path suggestions", () => {
  it("offers directories and directory symlinks, with explicit hidden-prefix discovery", () => {
    const entries = [entry("Project"), entry("Projects"), entry(".private"), entry("Projects.txt", { fileType: "file" }),
      entry("Portal", { fileType: "symlink", targetFileType: "dir" }), entry("Pipe", { fileType: "symlink" })];
    expect(pathSuggestions(entries, pathCompletionQuery("P", "/work")).map((item) => item.name)).toEqual(["Portal", "Project", "Projects"]);
    expect(pathSuggestions(entries, pathCompletionQuery(".", "/work")).map((item) => item.name)).toEqual([".private"]);
    expect(pathSuggestions(entries, pathCompletionQuery("/work/", "/work"), true)).toHaveLength(4);
  });

  it("matches Windows case-insensitively and preserves the entered separator", () => {
    const entries = [entry("Documents", { path: "C:\\Users\\me\\Documents" })];
    expect(pathSuggestions(entries, pathCompletionQuery("C:/Users/me/doc", "C:\\"))).toEqual([{ name: "Documents", value: "C:/Users/me/Documents/" }]);
    expect(pathSuggestions(entries, pathCompletionQuery("/work/doc", "/work"))).toEqual([]);
  });

  it("uses the provider's directory path for drives and appends exactly one separator", () => {
    expect(pathSuggestions([entry("C: (System)", { path: "C:\\" })], pathCompletionQuery("\\\\", "C:\\"))).toEqual([{ name: "C: (System)", value: "C:\\" }]);
    expect(pathSuggestions([entry("photos", { path: "/bucket/photos/" })], pathCompletionQuery("/bucket/ph", "/"))[0].value).toBe("/bucket/photos/");
  });

  it("finds the common path before choosing an ambiguous directory", () => {
    expect(commonPathPrefix([{ name: "Projects", value: "/work/Projects/" }, { name: "Project notes", value: "/work/Project notes/" }])).toBe("/work/Project");
  });
});
