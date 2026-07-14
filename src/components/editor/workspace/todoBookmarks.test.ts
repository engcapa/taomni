import { beforeEach, describe, expect, it } from "vitest";
import {
  createOpenFileTodoScanner,
  readWorkspaceBookmarks,
  scanTodosInText,
  sameWorkspaceTodoItems,
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

  it("caches unchanged open buffers while still updating the edited buffer", () => {
    const scanner = createOpenFileTodoScanner();
    const first = scanner.scan([
      { key: "a", pathLabel: "a.ts", text: "// TODO: first" },
      { key: "b", pathLabel: "b.ts", text: "// FIXME: second" },
    ]);
    const second = scanner.scan([
      { key: "a", pathLabel: "a.ts", text: "// TODO: changed" },
      { key: "b", pathLabel: "b.ts", text: "// FIXME: second" },
    ]);

    expect(second).toHaveLength(2);
    expect(second.find((item) => item.fileKey === "a")?.text).toBe("changed");
    expect(second.find((item) => item.fileKey === "b")).toBe(first.find((item) => item.fileKey === "b"));
    expect(sameWorkspaceTodoItems(first, second)).toBe(false);
    expect(sameWorkspaceTodoItems(second, scanner.scan([
      { key: "a", pathLabel: "a.ts", text: "// TODO: changed" },
      { key: "b", pathLabel: "b.ts", text: "// FIXME: second" },
    ]))).toBe(true);
  });
});
