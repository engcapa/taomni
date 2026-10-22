import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { promptAppDialog } from "../../../../../../lib/appDialogs";
import { selectCodeWorkspaceUi, useCodeWorkspaceStore } from "../../../../../../stores/codeWorkspaceStore";
import type { CodeWorkspaceTabInfo } from "../../../../../../types";
import type { WorkspaceCommandRegistration } from "../../../workspaceCommands";
import { setKeymapPlatformOverride } from "../../../workspaceKeymapPlatform";
import { type registerFilesCasesFixture } from "../../files.cases";

export interface registerfilesLifecycle3CasesContext {
  workspaceTestHarness: registerFilesCasesFixture;
}

export function registerfilesLifecycle3Cases(caseContext: registerfilesLifecycle3CasesContext) {
  it("ED-TREEOPEN-001 / DEC-TOF-01: single click on tree item only selects without opening or stealing focus", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-single-click",
      workspaceInstanceId: "instance-single-click",
      name: "Single Click",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "folder" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "README.md" },
    };
    caseContext.workspaceTestHarness.workspaceMocks.workspaceListDir.mockResolvedValue([
      caseContext.workspaceTestHarness.entry("README.md", "README.md"),
      caseContext.workspaceTestHarness.entry("other.txt", "other.txt"),
    ]);
    caseContext.workspaceTestHarness.workspaceMocks.workspaceReadFile.mockImplementation(async (_root: string, path: string) =>
      caseContext.workspaceTestHarness.file(path, path === "README.md" ? "# Readme\n" : "other content\n"));

    caseContext.workspaceTestHarness.renderWorkspace(workspace);
    await screen.findByTitle("app / README.md");

    const otherRow = (await screen.findAllByTestId("code-workspace-tree-file")).find((r) => r.dataset.path === "other.txt")!;
    fireEvent.click(otherRow);

    expect(otherRow).toHaveAttribute("data-selected", "true");

    const ui = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "instance-single-click");
    expect(ui.editorGroups.primary.openOrder).toEqual(["root:app:README.md"]);
    expect(caseContext.workspaceTestHarness.workspaceMocks.workspaceReadFile).not.toHaveBeenCalledWith("/repo/app", "other.txt");
  });
  it("ED-TREEOPEN-001 / DEC-TOF-04: context menu Escape closes menu and restores selection/focus to tree item", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-ctx-esc",
      workspaceInstanceId: "instance-ctx-esc",
      name: "Context Escape",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "folder" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "README.md" },
    };
    caseContext.workspaceTestHarness.workspaceMocks.workspaceListDir.mockResolvedValue([
      caseContext.workspaceTestHarness.entry("README.md", "README.md"),
      caseContext.workspaceTestHarness.entry("other.txt", "other.txt"),
    ]);
    caseContext.workspaceTestHarness.workspaceMocks.workspaceReadFile.mockResolvedValue(caseContext.workspaceTestHarness.file("README.md", "# Readme\n"));

    caseContext.workspaceTestHarness.renderWorkspace(workspace);
    await screen.findByTitle("app / README.md");

    const otherRow = (await screen.findAllByTestId("code-workspace-tree-file")).find((r) => r.dataset.path === "other.txt")!;
    fireEvent.contextMenu(otherRow);

    expect(await screen.findByRole("button", { name: "Open" })).toBeInTheDocument();

    fireEvent.keyDown(document, { key: "Escape" });

    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Open" })).not.toBeInTheDocument();
    });

    expect(otherRow).toHaveAttribute("data-selected", "true");
    expect(document.activeElement).toBe(otherRow);
  });
  it("ED-TREEOPEN-001 / DEC-TOF-04: a WebView focus reset after the menu unmounts still returns the tree row", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-ctx-esc-reset",
      workspaceInstanceId: "instance-ctx-esc-reset",
      name: "Context Escape Reset",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "folder" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "README.md" },
    };
    caseContext.workspaceTestHarness.workspaceMocks.workspaceListDir.mockResolvedValue([
      caseContext.workspaceTestHarness.entry("README.md", "README.md"),
      caseContext.workspaceTestHarness.entry("other.txt", "other.txt"),
    ]);
    caseContext.workspaceTestHarness.workspaceMocks.workspaceReadFile.mockResolvedValue(caseContext.workspaceTestHarness.file("README.md", "# Readme\n"));

    caseContext.workspaceTestHarness.renderWorkspace(workspace);
    await screen.findByTitle("app / README.md");

    const otherRow = (await screen.findAllByTestId("code-workspace-tree-file")).find((r) => r.dataset.path === "other.txt")!;
    fireEvent.contextMenu(otherRow);

    expect(await screen.findByRole("button", { name: "Open" })).toBeInTheDocument();

    // Hold the next paint until after the simulated unmount focus reset.
    // Real timers can paint during waitFor's async settlement under load,
    // which would simulate a later, unrelated blur instead of this scenario.
    const frames = new Map<number, FrameRequestCallback>();
    let nextFrameId = 0;
    const requestFrame = vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      const id = ++nextFrameId;
      frames.set(id, callback);
      return id;
    });
    const cancelFrame = vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
      frames.delete(id);
    });
    try {
      fireEvent.keyDown(document, { key: "Escape" });
      await waitFor(() => {
        expect(screen.queryByRole("button", { name: "Open" })).not.toBeInTheDocument();
      });

      // WebView2 resets focus after the focused menu node leaves the DOM.
      (document.activeElement as HTMLElement | null)?.blur();
      expect(document.activeElement).toBe(document.body);
      act(() => {
        const pending = [...frames.values()];
        frames.clear();
        for (const callback of pending) callback(performance.now());
      });
      expect(document.activeElement).toBe(otherRow);
    } finally {
      requestFrame.mockRestore();
      cancelFrame.mockRestore();
    }
  });
  it("ED-TREEOPEN-001 / DEC-TOF-04: context menu Open opens file and grants focus to editor", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-ctx-open",
      workspaceInstanceId: "instance-ctx-open",
      name: "Context Open",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "folder" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "README.md" },
    };
    caseContext.workspaceTestHarness.workspaceMocks.workspaceListDir.mockResolvedValue([
      caseContext.workspaceTestHarness.entry("README.md", "README.md"),
      caseContext.workspaceTestHarness.entry("other.txt", "other.txt"),
    ]);
    caseContext.workspaceTestHarness.workspaceMocks.workspaceReadFile.mockImplementation(async (_root: string, path: string) =>
      caseContext.workspaceTestHarness.file(path, path === "README.md" ? "# Readme\n" : "other content\n"));

    caseContext.workspaceTestHarness.renderWorkspace(workspace);
    await screen.findByTitle("app / README.md");

    const otherRow = (await screen.findAllByTestId("code-workspace-tree-file")).find((r) => r.dataset.path === "other.txt")!;
    fireEvent.contextMenu(otherRow);

    const openButton = await screen.findByRole("button", { name: "Open" });
    fireEvent.click(openButton);

    await screen.findByTitle("app / other.txt");
    await waitFor(() => {
      expect(document.activeElement?.classList.contains("cm-content")).toBe(true);
    });
  });
  it("ED-TREEOPEN-001 / DEC-TOF-05: IME composing Enter does not trigger tree open", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-ime-guard",
      workspaceInstanceId: "instance-ime-guard",
      name: "IME Guard",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "folder" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "README.md" },
    };
    caseContext.workspaceTestHarness.workspaceMocks.workspaceListDir.mockResolvedValue([
      caseContext.workspaceTestHarness.entry("README.md", "README.md"),
      caseContext.workspaceTestHarness.entry("other.txt", "other.txt"),
    ]);
    caseContext.workspaceTestHarness.workspaceMocks.workspaceReadFile.mockResolvedValue(caseContext.workspaceTestHarness.file("README.md", "# Readme\n"));

    caseContext.workspaceTestHarness.renderWorkspace(workspace);
    await screen.findByTitle("app / README.md");

    const pane = screen.getByTestId("code-workspace-tree-pane");
    const otherRow = (await screen.findAllByTestId("code-workspace-tree-file")).find((r) => r.dataset.path === "other.txt")!;
    fireEvent.click(otherRow);

    fireEvent.keyDown(pane, { key: "Enter", isComposing: true });

    const ui = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "instance-ime-guard");
    expect(ui.editorGroups.primary.openOrder).toEqual(["root:app:README.md"]);
    expect(caseContext.workspaceTestHarness.workspaceMocks.workspaceReadFile).not.toHaveBeenCalledWith("/repo/app", "other.txt");
  });
  it("scans open-file TODOs and toggles persistent bookmarks with F11", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-todos",
      workspaceInstanceId: "instance-todos",
      name: "TODOs",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/main.ts" },
    };
    caseContext.workspaceTestHarness.workspaceMocks.workspaceReadFile.mockResolvedValue(caseContext.workspaceTestHarness.file(
      "src/main.ts",
      "const value = 1; // TODO: replace fixture",
    ));

    caseContext.workspaceTestHarness.renderWorkspace(workspace);
    await screen.findByTitle("app / src/main.ts");
    const editor = screen.getByTestId("code-workspace-editor-pane");
    fireEvent.keyDown(editor, { key: "F11", code: "F11" });

    const panel = await screen.findByTestId("code-workspace-todos-panel");
    expect(screen.getByRole("tab", { name: /TODOs/, selected: true })).toBeInTheDocument();
    expect(panel).toHaveTextContent("replace fixture");
    expect(panel).toHaveTextContent("const value = 1");
    expect(window.localStorage.getItem("taomni.codeWorkspace.bookmarks.v1.instance-todos"))
      .toContain("root:app:src/main.ts");

    fireEvent.keyDown(editor, { key: "F11", code: "F11" });
    await waitFor(() => expect(panel).toHaveTextContent("No bookmarks yet"));
  });
  it("keeps a deleted bookmark as missing and restores it when the file is recreated", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-bookmark-resource-lifecycle",
      workspaceInstanceId: "instance-bookmark-resource-lifecycle",
      name: "Bookmark resource lifecycle",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "folder" }],
      looseFiles: [],
    };
    const disk = new Map([["src/bookmark.ts", "const bookmarked = true;\n"]]);
    const listDirectory = (_root: string, path = "") => {
      if (path === "") return [caseContext.workspaceTestHarness.entry("src", "src", "dir")];
      if (path === "src" && disk.has("src/bookmark.ts")) return [caseContext.workspaceTestHarness.entry("bookmark.ts", "src/bookmark.ts")];
      return [];
    };
    caseContext.workspaceTestHarness.workspaceMocks.workspaceListDir.mockImplementation(async (root: string, path = "") => listDirectory(root, path));
    caseContext.workspaceTestHarness.workspaceMocks.workspaceReadFile.mockImplementation(async (_root: string, path: string) => {
      const text = disk.get(path);
      if (text === undefined) throw new Error(`missing fixture ${path}`);
      return caseContext.workspaceTestHarness.file(path, text);
    });
    caseContext.workspaceTestHarness.workspaceMocks.workspaceApplyResourceOperation.mockImplementation(async (
      _root: string,
      operation: { kind: string; path?: string; },
    ) => {
      if (operation.kind === "delete" && operation.path) disk.delete(operation.path);
      return { ignored: false };
    });
    caseContext.workspaceTestHarness.workspaceMocks.workspaceCreateFile.mockImplementation(async (_root: string, path: string) => {
      const text = "const recreated = true;\n";
      disk.set(path, text);
      return caseContext.workspaceTestHarness.file(path, text);
    });

    caseContext.workspaceTestHarness.renderWorkspace(workspace);
    const directory = await screen.findByTestId("code-workspace-tree-dir");
    fireEvent.doubleClick(directory);
    const row = await screen.findByTestId("code-workspace-tree-file");
    fireEvent.doubleClick(row);
    await screen.findByTitle("app / src/bookmark.ts");
    const editor = screen.getByTestId("code-workspace-editor-pane");
    fireEvent.keyDown(editor, { key: "F11", code: "F11" });
    await screen.findByTestId("code-workspace-bookmark-item");

    // The tree pane is the keyboard owner; dispatch against its focus target
    // so the test follows the mounted tree shortcut path used by the app.
    fireEvent.keyDown(screen.getByTestId("code-workspace-tree-pane"), {
      key: "Delete",
      code: "Delete",
    });
    await waitFor(() => expect(caseContext.workspaceTestHarness.workspaceMocks.workspaceApplyResourceOperation).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByTestId("code-workspace-bookmark-item"))
      .toHaveAttribute("data-state", "missing"));
    expect(screen.getByTestId("code-workspace-bookmark-missing")).toHaveTextContent("Missing target");
    expect(disk.has("src/bookmark.ts")).toBe(false);

    vi.mocked(promptAppDialog).mockResolvedValueOnce("src/bookmark.ts");
    fireEvent.click(screen.getByTestId("code-workspace-tree-new"));
    fireEvent.click(screen.getByTestId("code-workspace-tree-new-file"));
    await waitFor(() => expect(screen.getByTestId("code-workspace-bookmark-item"))
      .toHaveAttribute("data-state", "current"));
    expect(disk.has("src/bookmark.ts")).toBe(true);
    expect(screen.getByTestId("code-workspace-bookmark-open")).toBeInTheDocument();
  });
  it("toggles the project tree from the panel-local collapse control and collapsed rail", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-tree-collapse",
      workspaceInstanceId: "instance-tree-collapse",
      name: "Tree Collapse",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
    };
    caseContext.workspaceTestHarness.renderWorkspace(workspace);

    await screen.findByTestId("code-workspace-tree-pane");
    expect(screen.getByTestId("code-workspace-tree-collapse")).toBeInTheDocument();
    expect(screen.getByTestId("code-workspace-project-resize-handle")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("code-workspace-tree-collapse"));
    await waitFor(() => {
      expect(selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "instance-tree-collapse").languagePanelOpen)
        .toBe(false);
    });
    expect(screen.getByTestId("code-workspace-tool-rail-project")).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(screen.getByTestId("code-workspace-tool-rail-project"));
    await waitFor(() => {
      expect(selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "instance-tree-collapse").languagePanelOpen)
        .toBe(true);
    });
    expect(screen.getByTestId("code-workspace-tool-rail-project")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("code-workspace-tree-collapse")).toBeInTheDocument();
  });
  it("routes Ctrl+B (Go to Declaration) directly to definition navigation for Java files", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-java-ctrl-b-definition-reuse",
      workspaceInstanceId: "instance-java-ctrl-b-definition-reuse",
      name: "Java Ctrl+B definition reuse",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/Main.java" },
    };
    const source = "class Main { void target() {} void call() { target(); } }\n";
    const status = caseContext.workspaceTestHarness.documentStatus({
      path: "/repo/app/src/Main.java",
      uri: "file:///repo/app/src/Main.java",
      presetId: "java",
      languageId: "java",
      displayName: "Java",
      available: true,
      active: true,
      capabilities: caseContext.workspaceTestHarness.defaultCapabilities({
        definition: true,
        declaration: false,
      }),
    });
    const target = {
      uri: "file:///repo/app/src/Main.java",
      path: "/repo/app/src/Main.java",
      range: { start: { line: 0, character: 19 }, end: { line: 0, character: 25 } },
    };
    caseContext.workspaceTestHarness.workspaceMocks.workspaceReadFile.mockResolvedValue(caseContext.workspaceTestHarness.file("src/Main.java", source));
    caseContext.workspaceTestHarness.lspMocks.lspOpenDocument.mockResolvedValue(status);
    caseContext.workspaceTestHarness.lspMocks.lspGetDiagnostics.mockResolvedValue({ status, diagnostics: [] });
    caseContext.workspaceTestHarness.lspMocks.lspDefinition.mockResolvedValue({ status, locations: [target] });
    caseContext.workspaceTestHarness.lspMocks.lspDeclaration.mockResolvedValue({ status, locations: [] });

    const registrationRef: { current: WorkspaceCommandRegistration | null; } = { current: null };
    const onCommandsChange = vi.fn((_tabId: string, next: WorkspaceCommandRegistration | null) => {
      if (next) registrationRef.current = next;
    });

    caseContext.workspaceTestHarness.renderWorkspace(workspace, { onCommandsChange });
    await screen.findByTitle("app / src/Main.java");
    const fileKey = "root:app:src/Main.java";
    await waitFor(() => expect(
      selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "instance-java-ctrl-b-definition-reuse")
        .lspFiles[fileKey]?.syncedText,
    ).toBe(source));

    // Even though declaration capability is false, definition capability is true so Go to Declaration stays enabled
    await waitFor(() => expect(registrationRef.current?.items.find(
      (item) => item.id === "workspace.gotoDeclaration",
    )?.enabled).toBe(true));

    caseContext.workspaceTestHarness.lspMocks.lspDefinition.mockClear();
    caseContext.workspaceTestHarness.lspMocks.lspDeclaration.mockClear();

    await act(async () => {
      await registrationRef.current?.executeAction("workspace.gotoDeclaration");
      await Promise.resolve();
    });

    // In Java, Ctrl+B reuses the definition pipeline directly
    await waitFor(() => expect(caseContext.workspaceTestHarness.lspMocks.lspDefinition).toHaveBeenCalled());
    expect(caseContext.workspaceTestHarness.lspMocks.lspDeclaration).not.toHaveBeenCalled();
  });
  it("opens Search Everywhere with Ctrl+N and Ctrl+Shift+N when viewing a Java file", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-shortcuts-test",
      workspaceInstanceId: "instance-shortcuts-test",
      name: "Shortcuts test",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/App.java" },
    };
    caseContext.workspaceTestHarness.workspaceMocks.workspaceReadFile.mockResolvedValue(
      caseContext.workspaceTestHarness.file("src/App.java", "public class App { public static void main(String[] args) {} }"),
    );
    caseContext.workspaceTestHarness.workspaceMocks.workspaceListDir.mockResolvedValue([
      { name: "App.java", path: "src/App.java", fileType: "file", size: 50, mtime: 1 },
    ]);
    caseContext.workspaceTestHarness.workspaceMocks.workspaceListFilesRecursive.mockResolvedValue([
      { name: "App.java", path: "src/App.java", fileType: "file", size: 50, mtime: 1 },
    ]);

    caseContext.workspaceTestHarness.renderWorkspace(workspace, {}, { strict: true });
    await screen.findByTitle("app / src/App.java");

    // 1. Press Ctrl+Shift+N to open Search Everywhere (Files mode)
    await act(async () => {
      fireEvent.keyDown(window, {
        key: "N",
        code: "KeyN",
        ctrlKey: true,
        shiftKey: true,
      });
    });

    const overlay1 = await screen.findByTestId("code-workspace-search-everywhere");
    expect(overlay1).toBeInTheDocument();

    // Close with Escape on the searchbox input
    await act(async () => {
      fireEvent.keyDown(within(overlay1).getByRole("searchbox"), { key: "Escape" });
    });
    await waitFor(() => {
      expect(screen.queryByTestId("code-workspace-search-everywhere")).not.toBeInTheDocument();
    });

    // 2. Press Ctrl+N to open Search Everywhere (Classes mode or fallback)
    await act(async () => {
      fireEvent.keyDown(window, {
        key: "n",
        code: "KeyN",
        ctrlKey: true,
        shiftKey: false,
      });
    });

    const overlay2 = await screen.findByTestId("code-workspace-search-everywhere");
    expect(overlay2).toBeInTheDocument();

    // Close with Escape
    await act(async () => {
      fireEvent.keyDown(within(overlay2).getByRole("searchbox"), { key: "Escape" });
    });
    await waitFor(() => {
      expect(screen.queryByTestId("code-workspace-search-everywhere")).not.toBeInTheDocument();
    });

    // macOS sends the Command chord; it must open the same Files view. Cmd
    // aliases exist only on macOS (ED-PARITY-013 DEC-013-01).
    setKeymapPlatformOverride("mac");
    await act(async () => {
      fireEvent.keyDown(window, {
        key: "N",
        code: "KeyN",
        metaKey: true,
        shiftKey: true,
      });
    });
    const overlay3 = await screen.findByTestId("code-workspace-search-everywhere");
    expect(overlay3).toBeInTheDocument();
    await act(async () => {
      fireEvent.keyDown(within(overlay3).getByRole("searchbox"), { key: "Escape" });
    });
    await waitFor(() => {
      expect(screen.queryByTestId("code-workspace-search-everywhere")).not.toBeInTheDocument();
    });
  });
}
