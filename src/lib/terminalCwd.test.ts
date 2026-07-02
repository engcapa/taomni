import { describe, expect, it } from "vitest";
import { normalizeLocalStartCwd } from "./terminalCwd";

describe("normalizeLocalStartCwd", () => {
  it("strips the leading slash before a Windows drive and uses backslashes", () => {
    expect(normalizeLocalStartCwd("/D:/code/person/taomni", "windows")).toBe(
      "D:\\code\\person\\taomni",
    );
  });

  it("rebuilds a Windows drive path from an MSYS / Git Bash path", () => {
    expect(normalizeLocalStartCwd("/d/code/app", "windows")).toBe("D:\\code\\app");
    expect(normalizeLocalStartCwd("/c", "windows")).toBe("C:\\");
  });

  it("handles spaces in the path", () => {
    expect(normalizeLocalStartCwd("/C:/Users/Jo Bloggs/dev", "windows")).toBe(
      "C:\\Users\\Jo Bloggs\\dev",
    );
  });

  it("preserves native Windows paths passed directly by local shortcuts", () => {
    expect(normalizeLocalStartCwd("C:\\Users\\Jo Bloggs\\dev", "windows")).toBe(
      "C:\\Users\\Jo Bloggs\\dev",
    );
    expect(normalizeLocalStartCwd("\\\\server\\share\\repo", "windows")).toBe(
      "\\\\server\\share\\repo",
    );
  });

  it("returns null for MSYS/WSL paths with no Windows drive", () => {
    expect(normalizeLocalStartCwd("/home/user", "windows")).toBeNull();
    expect(normalizeLocalStartCwd("/usr/local/bin", "windows")).toBeNull();
  });

  it("leaves POSIX paths untouched on non-Windows platforms", () => {
    expect(normalizeLocalStartCwd("/home/user/project", "linux")).toBe("/home/user/project");
    expect(normalizeLocalStartCwd("/Users/me/project", "macos")).toBe("/Users/me/project");
  });

  it("returns null for empty input", () => {
    expect(normalizeLocalStartCwd("", "windows")).toBeNull();
    expect(normalizeLocalStartCwd("", "linux")).toBeNull();
  });
});
