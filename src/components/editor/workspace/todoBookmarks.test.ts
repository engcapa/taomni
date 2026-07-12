import { beforeEach, describe, expect, it } from "vitest";
import {
  readWorkspaceBookmarks,
  scanTodosInText,
  toggleWorkspaceBookmark,
} from "./todoBookmarks";

describe("todoBookmarks", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("scans TODO/FIXME markers with positions", () => {
    const items = scanTodosInText(
      "root:app:src/main.ts",
      "app / src/main.ts",
      [
        "export function run() {",
        "  // TODO: implement feature",
        "  // FIXME remove hack",
        "  const x = 1; // not a marker",
        "}",
      ].join("\n"),
    );
    expect(items.map((item) => item.kind)).toEqual(["TODO", "FIXME"]);
    expect(items[0].line).toBe(1);
    expect(items[0].text).toContain("implement feature");
    expect(items[1].line).toBe(2);
  });

  it("toggles bookmarks for the same file/line", () => {
    const first = toggleWorkspaceBookmark("ws", {
      fileKey: "root:app:a.ts",
      pathLabel: "app / a.ts",
      line: 3,
      character: 0,
      label: "entry",
    });
    expect(first).toHaveLength(1);
    expect(readWorkspaceBookmarks("ws")).toHaveLength(1);
    const second = toggleWorkspaceBookmark("ws", {
      fileKey: "root:app:a.ts",
      pathLabel: "app / a.ts",
      line: 3,
      character: 0,
      label: "entry",
    }, first);
    expect(second).toHaveLength(0);
  });
});
