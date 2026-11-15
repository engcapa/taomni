import { describe, expect, it } from "vitest";
import { findFilePathLinks, parseFilePathLink } from "./filePathLinks";

describe("local file path links", () => {
  it.each([
    ["/tmp/中文 report.html:12:3", undefined, { path: "/tmp/中文 report.html", line: 12 }],
    ["file:///C:/My%20Files/report.html#L7", undefined, { path: "C:/My Files/report.html", line: 7 }],
    ["../notes.md", "/work/docs", { path: "/work/notes.md" }],
    ["\"C:\\My Files\\a.svg\"", undefined, { path: "C:/My Files/a.svg" }],
    ["notes.md", "/work", { path: "/work/notes.md" }],
  ])("resolves %s without opening it", (input, cwd, expected) => {
    expect(parseFilePathLink(input, cwd)).toEqual(expected);
  });
  it.each(["https://example.test/a.txt", "javascript:alert(1)", "file://remote/tmp/a.txt", "file:///tmp/a.txt?x=1", "cat /tmp/a.txt", "/folder", "/tmp/a.txt\nrm -rf /", "../../escape.txt"]) ("rejects non-file or unsafe target %s", (value) => {
    expect(parseFilePathLink(value)).toBeNull();
  });
  it("extracts terminal ranges including quoted spaces but ignores URL paths", () => {
    const text = '中文 "/tmp/My report.html:3" and https://example.test/a.txt';
    expect(findFilePathLinks(text)).toEqual([{ path: "/tmp/My report.html", line: 3, start: 3, end: 26, text: '"/tmp/My report.html:3"' }]);
  });
});
