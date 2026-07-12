import { beforeEach, describe, expect, it } from "vitest";
import {
  defaultWorkspaceLayoutSnapshot,
  fileRefFromFileKey,
  normalizeWorkspaceLayoutSnapshot,
  pushWorkspaceSearchHistory,
  readWorkspaceLayoutSnapshot,
  readWorkspaceSearchHistory,
  uniqueOrderedKeys,
  writeWorkspaceLayoutSnapshot,
} from "./workspaceLayoutPersistence";

describe("workspaceLayoutPersistence", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("normalizes and round-trips layout snapshots", () => {
    writeWorkspaceLayoutSnapshot("ws", {
      version: 1,
      bottomDockOpen: false,
      bottomDockTab: "search",
      rightPaneOpen: true,
      rightPaneTab: "documentation",
      languagePanelOpen: false,
      splitOrientation: "vertical",
      activeEditorGroupId: "secondary",
      expandedRootIds: ["app"],
      expandedDirKeys: ["app:src"],
      editorGroups: {
        primary: {
          openOrder: ["root:app:src/main.ts", "root:app:src/lib.ts"],
          activeKey: "root:app:src/main.ts",
          previewKey: "root:app:src/lib.ts",
          pinnedKeys: ["root:app:src/main.ts"],
        },
        secondary: {
          openOrder: ["root:app:README.md"],
          activeKey: "root:app:README.md",
          previewKey: null,
          pinnedKeys: [],
        },
      },
    });

    const restored = readWorkspaceLayoutSnapshot("ws");
    expect(restored?.bottomDockOpen).toBe(false);
    expect(restored?.bottomDockTab).toBe("search");
    expect(restored?.rightPaneOpen).toBe(true);
    expect(restored?.splitOrientation).toBe("vertical");
    expect(restored?.editorGroups.primary.openOrder).toEqual([
      "root:app:src/main.ts",
      "root:app:src/lib.ts",
    ]);
    expect(restored?.editorGroups.secondary.activeKey).toBe("root:app:README.md");
  });

  it("falls back safely for invalid payloads", () => {
    const snapshot = normalizeWorkspaceLayoutSnapshot({
      bottomDockTab: "nope",
      splitOrientation: "diagonal",
      editorGroups: { primary: { openOrder: [1, "root:app:a.ts"], activeKey: "missing" } },
    });
    expect(snapshot.bottomDockTab).toBe(defaultWorkspaceLayoutSnapshot().bottomDockTab);
    expect(snapshot.splitOrientation).toBeNull();
    expect(snapshot.editorGroups.primary.openOrder).toEqual(["root:app:a.ts"]);
    expect(snapshot.editorGroups.primary.activeKey).toBe("root:app:a.ts");
  });

  it("parses file keys and dedupes restored open order", () => {
    expect(fileRefFromFileKey("root:app:src/main.ts")).toEqual({
      kind: "root",
      rootId: "app",
      path: "src/main.ts",
    });
    expect(fileRefFromFileKey("loose:file-1", [{
      id: "file-1",
      name: "notes.md",
      path: "/tmp/notes.md",
    }])).toEqual({
      kind: "loose",
      id: "file-1",
      path: "/tmp/notes.md",
    });
    expect(fileRefFromFileKey("loose:missing")).toBeNull();
    expect(uniqueOrderedKeys({
      primary: {
        openOrder: ["root:app:a.ts", "root:app:b.ts"],
        activeKey: "root:app:a.ts",
        previewKey: null,
        pinnedKeys: [],
      },
      secondary: {
        openOrder: ["root:app:b.ts", "root:app:c.ts"],
        activeKey: "root:app:c.ts",
        previewKey: null,
        pinnedKeys: [],
      },
    })).toEqual(["root:app:a.ts", "root:app:b.ts", "root:app:c.ts"]);
  });

  it("keeps the latest 20 search queries with newest first", () => {
    const first = pushWorkspaceSearchHistory("ws", "foo");
    const second = pushWorkspaceSearchHistory("ws", "bar", first);
    const third = pushWorkspaceSearchHistory("ws", "foo", second);
    expect(third[0]).toBe("foo");
    expect(third).toEqual(["foo", "bar"]);
    expect(readWorkspaceSearchHistory("ws")).toEqual(["foo", "bar"]);

    let history: string[] = [];
    for (let index = 0; index < 25; index += 1) {
      history = pushWorkspaceSearchHistory("ws", `q${index}`, history);
    }
    expect(history).toHaveLength(20);
    expect(history[0]).toBe("q24");
    expect(history[19]).toBe("q5");
  });
});
