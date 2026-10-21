import { describe, expect, it } from "vitest";
import { debugCurrentLineForFile, extractContextSnippet } from "../../CodeWorkspaceTab";

export function registerCodeWorkspaceTabCompletion1Cases() {

  describe("extractContextSnippet", () => {
    it("extracts the first line and its following context at offset zero", () => {
      expect(extractContextSnippet("first\nsecond\nthird", 0, 0)).toEqual({
        lineText: "first",
        contextSnippet: "first\nsecond",
      });
    });

    it("preserves an empty first line when the caret is on the second line", () => {
      expect(extractContextSnippet("\nsecond\nthird", 1, 1)).toEqual({
        lineText: "second",
        contextSnippet: "\nsecond\nthird",
      });
    });

    it("returns only the adjacent three-line window for a middle line", () => {
      const text = "zero\none\ntwo\nthree\nfour";
      expect(extractContextSnippet(text, 2, text.indexOf("two"))).toEqual({
        lineText: "two",
        contextSnippet: "one\ntwo\nthree",
      });
    });

    it("extracts the final line and its predecessor at end of file", () => {
      const text = "zero\none\ntwo";
      expect(extractContextSnippet(text, 2, text.length)).toEqual({
        lineText: "two",
        contextSnippet: "one\ntwo",
      });
    });
  });

  describe("debugCurrentLineForFile", () => {
    it("matches a stopped source frame by source name when path is omitted", () => {
      expect(debugCurrentLineForFile(
        null,
        [{ id: 7, path: null, line: 17, sourceName: "PersisG2Application.java" }],
        7,
        "/repo/persis-g2-server/src/main/java/com/deepzero/ads/persis/PersisG2Application.java",
        true,
      )).toBe(17);
    });

    it("prefers an exact source path and rejects a different source name", () => {
      expect(debugCurrentLineForFile(
        { path: "/repo/src/App.java", line: 9 },
        [{ id: 1, path: null, line: 17, sourceName: "Other.java" }],
        1,
        "/repo/src/App.java",
        true,
      )).toBe(9);
      expect(debugCurrentLineForFile(
        null,
        [{ id: 1, path: null, line: 17, sourceName: "Other.java" }],
        1,
        "/repo/src/App.java",
        true,
      )).toBeNull();
    });
  });
}
