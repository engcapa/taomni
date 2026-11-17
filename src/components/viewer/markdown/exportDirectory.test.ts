import { beforeEach, expect, it, vi } from "vitest";
import { lastMarkdownExportDirectory, MARKDOWN_EXPORT_DIRECTORY_KEY, rememberMarkdownExportDirectory } from "./exportDirectory";

beforeEach(() => { localStorage.clear(); vi.restoreAllMocks(); });

it.each([
  ["/exports/a.pdf", "/exports/"],
  ["/a.docx", "/"],
  ["C:\\用户\\导出\\a.svg", "C:\\用户\\导出\\"],
  ["C:/exports/a.png", "C:/exports/"],
  ["\\\\server\\share\\a.drawio", "\\\\server\\share\\"],
  ["/exports/a\\b.pdf", "/exports/"],
])("remembers the successful native parent of %s across independent reads", (path, expected) => {
  rememberMarkdownExportDirectory(path);
  expect(lastMarkdownExportDirectory()).toBe(expected);
  expect(JSON.parse(localStorage.getItem(MARKDOWN_EXPORT_DIRECTORY_KEY)!)).toBe(expected);
});

it("uses the chosen folder itself for Markdown bundle exports", () => {
  rememberMarkdownExportDirectory("C:\\输出目录", true);
  expect(lastMarkdownExportDirectory()).toBe("C:\\输出目录\\");
  rememberMarkdownExportDirectory("/output/path\\with-backslash", true);
  expect(lastMarkdownExportDirectory()).toBe("/output/path\\with-backslash/");
});

it.each(["relative/file.pdf", "https://example.test/file.pdf", "bad\npath/file.pdf"])("does not persist an invalid destination %s", (path) => {
  rememberMarkdownExportDirectory(path);
  expect(lastMarkdownExportDirectory()).toBeUndefined();
});

it("ignores old corrupt or relative preferences and does not fail an already saved export when storage is unavailable", () => {
  localStorage.setItem(MARKDOWN_EXPORT_DIRECTORY_KEY, "bad JSON");
  expect(lastMarkdownExportDirectory()).toBeUndefined();
  localStorage.setItem(MARKDOWN_EXPORT_DIRECTORY_KEY, JSON.stringify("relative/"));
  expect(lastMarkdownExportDirectory()).toBeUndefined();
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("quota exceeded"); });
  expect(() => rememberMarkdownExportDirectory("/out/done.pdf")).not.toThrow();
});
