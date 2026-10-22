import { EditorSelection } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { useAppStore } from "../../../../../../stores/appStore";
import { selectCodeWorkspaceUi, useCodeWorkspaceStore } from "../../../../../../stores/codeWorkspaceStore";
import type { CodeWorkspaceTabInfo } from "../../../../../../types";
import { CodeWorkspaceTab } from "../../../../CodeWorkspaceTab";
import type { WorkspaceCommandRegistration } from "../../../workspaceCommands";
import { type registerFilesCasesFixture } from "../../files.cases";

export interface registerfilesClipboard2CasesContext {
  workspaceTestHarness: registerFilesCasesFixture;
}

export function registerfilesClipboard2Cases(caseContext: registerfilesClipboard2CasesContext) {
  it("cancels a multi-file code-action preview with zero edits and zero history", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-actions-cancel",
      workspaceInstanceId: "instance-actions-cancel",
      name: "Actions cancel",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/main.ts" },
    };
    caseContext.workspaceTestHarness.workspaceMocks.workspaceListDir.mockImplementation(async (_root: string, path: string) => (
      path === "src"
        ? [caseContext.workspaceTestHarness.entry("main.ts", "src/main.ts"), caseContext.workspaceTestHarness.entry("other.ts", "src/other.ts")]
        : [caseContext.workspaceTestHarness.entry("src", "src", "dir")]
    ));
    caseContext.workspaceTestHarness.workspaceMocks.workspaceReadFile.mockImplementation(async (_root: string, path: string) => (
      path === "src/other.ts" ? caseContext.workspaceTestHarness.file(path, "y=2") : caseContext.workspaceTestHarness.file(path, "x=1")
    ));
    const status = caseContext.workspaceTestHarness.documentStatus({
      path: "/repo/app/src/main.ts",
      uri: "file:///repo/app/src/main.ts",
      available: true,
      active: true,
      capabilities: caseContext.workspaceTestHarness.defaultCapabilities({ codeAction: true }),
    });
    caseContext.workspaceTestHarness.lspMocks.lspOpenDocument.mockResolvedValue(status);
    caseContext.workspaceTestHarness.lspMocks.lspCodeActions.mockResolvedValue({
      status,
      actions: [{
        title: "Update two files",
        kind: "quickfix",
        isPreferred: true,
        edit: {
          documentEdits: [
            {
              uri: "file:///repo/app/src/main.ts",
              path: "/repo/app/src/main.ts",
              edits: [{
                range: { start: { line: 0, character: 1 }, end: { line: 0, character: 1 } },
                newText: " ",
              }],
            },
            {
              uri: "file:///repo/app/src/other.ts",
              path: "/repo/app/src/other.ts",
              edits: [{
                range: { start: { line: 0, character: 1 }, end: { line: 0, character: 1 } },
                newText: " ",
              }],
            },
          ],
        },
        command: null,
        commandArguments: null,
        raw: { title: "Update two files", kind: "quickfix" },
      }],
    });
    const registrationRef: { current: WorkspaceCommandRegistration | null; } = { current: null };
    const onCommandsChange = vi.fn((_tabId: string, next: WorkspaceCommandRegistration | null) => {
      if (next) registrationRef.current = next;
    });

    caseContext.workspaceTestHarness.renderWorkspace(workspace, { onCommandsChange });
    await screen.findByTitle("app / src/main.ts");
    await waitFor(() => expect(screen.queryByText("LSP idle")).not.toBeInTheDocument());
    fireEvent.keyDown(window, { key: "Enter", altKey: true });
    fireEvent.click(await screen.findByRole("button", { name: "Update two files" }));
    const preview = await screen.findByTestId("refactoring-preview-dialog");
    expect(within(preview).getByText("/repo/app/src/main.ts")).toBeInTheDocument();
    expect(within(preview).getByText("/repo/app/src/other.ts")).toBeInTheDocument();
    fireEvent.click(within(preview).getByTestId("refactoring-preview-cancel"));

    await waitFor(() => expect(useAppStore.getState().statusMessage).toContain("Code action cancelled"));
    expect(selectCodeWorkspaceUi(
      useCodeWorkspaceStore.getState(),
      "instance-actions-cancel",
    ).openFiles["root:app:src/main.ts"]?.text).toBe("x=1");
    expect(caseContext.workspaceTestHarness.workspaceMocks.workspaceWriteFileEncoded).not.toHaveBeenCalled();
    expect(
      registrationRef.current?.items.find((item) => item.id === "workspace.undoWorkspaceEdit")?.enabled,
    ).toBe(false);
  });
  it("never generates or suggests Java import quick fixes in TypeScript files", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-ts-no-java-import",
      workspaceInstanceId: "instance-ts-no-java-import",
      name: "TS No Java Import",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/app.ts" },
    };
    caseContext.workspaceTestHarness.workspaceMocks.workspaceListDir.mockResolvedValue([caseContext.workspaceTestHarness.entry("src", "src", "dir")]);
    caseContext.workspaceTestHarness.workspaceMocks.workspaceReadFile.mockResolvedValue(caseContext.workspaceTestHarness.file(
      "src/app.ts",
      "const items: List = [];",
    ));
    caseContext.workspaceTestHarness.lspMocks.lspOpenDocument.mockResolvedValue(caseContext.workspaceTestHarness.documentStatus({
      path: "/repo/app/src/app.ts",
      available: true,
      active: true,
      capabilities: caseContext.workspaceTestHarness.defaultCapabilities({
        completion: true,
        codeAction: true,
      }),
    }));
    caseContext.workspaceTestHarness.lspMocks.lspCodeActions.mockResolvedValue({
      status: caseContext.workspaceTestHarness.documentStatus({ available: true, active: true }),
      actions: [],
    });

    caseContext.workspaceTestHarness.renderWorkspace(workspace);
    await screen.findByTitle("app / src/app.ts");
    await waitFor(() => expect(screen.queryByText("LSP idle")).not.toBeInTheDocument());

    // Trigger Alt+Enter on TypeScript file where LSP has no actions
    fireEvent.keyDown(window, { key: "Enter", altKey: true });

    // AC-ALT-02: no provider action stays visible instead of silently no-op.
    await waitFor(() => expect(useAppStore.getState().statusMessage).toContain(
      "No code actions provided by the language server",
    ));

    // Assert no Java import quick fix is suggested
    expect(screen.queryByRole("button", { name: /import 'List' \(java\.util\.List\)/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /java\.util/i })).not.toBeInTheDocument();
  });
  it("keeps format executable before the provider reports capabilities", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-format-unknown-capabilities",
      workspaceInstanceId: "instance-format-unknown-capabilities",
      name: "Format unknown capabilities",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/main.ts" },
    };
    caseContext.workspaceTestHarness.workspaceMocks.workspaceListDir.mockResolvedValue([caseContext.workspaceTestHarness.entry("src", "src", "dir")]);
    caseContext.workspaceTestHarness.workspaceMocks.workspaceReadFile.mockResolvedValue(caseContext.workspaceTestHarness.file("src/main.ts", "const x=1"));
    // The open request stays pending: capability state is genuinely unknown.
    caseContext.workspaceTestHarness.lspMocks.lspOpenDocument.mockReturnValue(new Promise(() => { }));
    caseContext.workspaceTestHarness.lspMocks.lspFormatting.mockResolvedValue({
      status: caseContext.workspaceTestHarness.documentStatus({ active: true, available: true }),
      edits: [{
        range: { start: { line: 0, character: 7 }, end: { line: 0, character: 7 } },
        newText: " ",
      }],
    });

    caseContext.workspaceTestHarness.renderWorkspace(workspace);
    await screen.findByTitle("app / src/main.ts");
    await waitFor(() => expect(caseContext.workspaceTestHarness.lspMocks.lspOpenDocument).toHaveBeenCalled());

    fireEvent.keyDown(window, { key: "l", ctrlKey: true, altKey: true });

    // AC-FMT-03: an unreported capability does not disable the command; the
    // provider call decides and the format still applies.
    await waitFor(() => expect(caseContext.workspaceTestHarness.lspMocks.lspFormatting).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(selectCodeWorkspaceUi(
      useCodeWorkspaceStore.getState(),
      "instance-format-unknown-capabilities",
    ).openFiles["root:app:src/main.ts"]?.text).toBe("const x =1"));
  });
  it("refuses selection formatting when the provider only supports whole-file scope", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-format-range-unsupported",
      workspaceInstanceId: "instance-format-range-unsupported",
      name: "Format range unsupported",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/main.ts" },
    };
    caseContext.workspaceTestHarness.workspaceMocks.workspaceListDir.mockResolvedValue([caseContext.workspaceTestHarness.entry("src", "src", "dir")]);
    caseContext.workspaceTestHarness.workspaceMocks.workspaceReadFile.mockResolvedValue(caseContext.workspaceTestHarness.file("src/main.ts", "const x=1"));
    caseContext.workspaceTestHarness.lspMocks.lspOpenDocument.mockResolvedValue(caseContext.workspaceTestHarness.documentStatus({
      path: "/repo/app/src/main.ts",
      uri: "file:///repo/app/src/main.ts",
      presetId: "typescript-javascript",
      languageId: "typescript",
      displayName: "TypeScript / JavaScript",
      available: true,
      active: true,
      capabilities: caseContext.workspaceTestHarness.defaultCapabilities({ formatting: true, rangeFormatting: false }),
    }));
    caseContext.workspaceTestHarness.lspMocks.lspFormatting.mockResolvedValue({
      status: caseContext.workspaceTestHarness.documentStatus({ active: true, available: true }),
      edits: [],
    });

    const rendered = caseContext.workspaceTestHarness.renderWorkspace(workspace);
    await screen.findByTitle("app / src/main.ts");
    await waitFor(() => expect(screen.queryByText("LSP idle")).not.toBeInTheDocument());
    const content = rendered.container.querySelector<HTMLElement>(".cm-content");
    const view = EditorView.findFromDOM(content!);
    expect(view).not.toBeNull();
    act(() => {
      view!.dispatch({ selection: EditorSelection.range(0, 5) });
    });
    // Flush the debounced selection publish so editorSelectionRef sees the
    // non-empty range before the shortcut is evaluated.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });

    fireEvent.keyDown(window, { key: "l", ctrlKey: true, altKey: true });

    await waitFor(() => expect(useAppStore.getState().statusMessage).toContain("range formatting"));
    expect(caseContext.workspaceTestHarness.lspMocks.lspFormatting).not.toHaveBeenCalled();
    expect(caseContext.workspaceTestHarness.lspMocks.lspRangeFormatting).not.toHaveBeenCalled();
    expect(selectCodeWorkspaceUi(
      useCodeWorkspaceStore.getState(),
      "instance-format-range-unsupported",
    ).openFiles["root:app:src/main.ts"]?.text).toBe("const x=1");
  });
  it("offers tree context menu actions: copy path and scoped search", async () => {
    caseContext.workspaceTestHarness.clipboardMocks.writeText.mockClear();
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-menu",
      workspaceInstanceId: "instance-menu",
      name: "Menu",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
    };
    caseContext.workspaceTestHarness.workspaceMocks.workspaceListDir.mockResolvedValue([
      caseContext.workspaceTestHarness.entry("src", "src", "dir"),
      caseContext.workspaceTestHarness.entry("README.md", "README.md"),
    ]);
    caseContext.workspaceTestHarness.workspaceMocks.workspaceDetectGitRoots.mockResolvedValue([{
      id: "git-app",
      name: "app",
      path: "/repo/app",
      repoRoot: "/repo/app",
      rootIds: ["app"],
    }]);

    caseContext.workspaceTestHarness.renderWorkspace(workspace);

    const fileRow = await screen.findByTestId("code-workspace-tree-file");
    fireEvent.contextMenu(fileRow);
    fireEvent.click(await screen.findByRole("button", { name: "Copy Relative Path" }));
    await waitFor(() => expect(caseContext.workspaceTestHarness.clipboardMocks.writeText).toHaveBeenCalledWith("README.md"));

    fireEvent.contextMenu(fileRow);
    fireEvent.click(await screen.findByRole("button", { name: "Copy Path" }));
    await waitFor(() => expect(caseContext.workspaceTestHarness.clipboardMocks.writeText).toHaveBeenCalledWith("/repo/app/README.md"));

    fireEvent.contextMenu(fileRow);
    fireEvent.click(await screen.findByRole("button", { name: "Add to .gitignore" }));
    await waitFor(() => expect(caseContext.workspaceTestHarness.gitMocks.gitIgnorePath).toHaveBeenCalledWith(
      "/repo/app",
      "README.md",
      false,
    ));

    const dirRow = await screen.findByTestId("code-workspace-tree-dir");
    fireEvent.contextMenu(dirRow);
    fireEvent.click(await screen.findByRole("button", { name: "Find in Directory..." }));
    expect(screen.getByRole("tab", { name: /Search/, selected: true })).toBeInTheDocument();
    expect(screen.getByLabelText("Include globs")).toHaveValue("src/**");

    fireEvent.contextMenu(fileRow);
    fireEvent.click(await screen.findByRole("button", { name: "Open in Terminal" }));
    expect(screen.getByRole("tab", { name: /Terminal/, selected: true })).toBeInTheDocument();
    expect(await screen.findByTestId("mock-workspace-terminal")).toHaveAttribute("data-initial-cwd", "/repo/app");
  });
  it("releases a workspace's store instance when the tab is rebound to another", async () => {
    // The StrictMode-safe teardown defers disposal by a macrotask so a remount
    // can cancel it. Only a remount of the SAME workspace may cancel: rebinding
    // the tab to a different workspace must still release the old instance, or
    // its entry (open files, editor groups, LSP state) leaks for the session.
    const first: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/one",
      workspaceId: "ws-rebind-1",
      workspaceInstanceId: "instance-rebind-1",
      name: "One",
      roots: [{ id: "one", name: "one", path: "/repo/one", kind: "git" }],
      looseFiles: [],
    };
    const second: CodeWorkspaceTabInfo = {
      ...first,
      repoRoot: "/repo/two",
      workspaceId: "ws-rebind-2",
      workspaceInstanceId: "instance-rebind-2",
      name: "Two",
      roots: [{ id: "two", name: "two", path: "/repo/two", kind: "git" }],
    };
    caseContext.workspaceTestHarness.workspaceMocks.workspaceListDir.mockResolvedValue([]);

    const view = render(<CodeWorkspaceTab tabId="tab-code" workspace={first} visible />);
    await waitFor(() => expect(
      useCodeWorkspaceStore.getState().byInstanceId["instance-rebind-1"],
    ).toBeTruthy());

    view.rerender(<CodeWorkspaceTab tabId="tab-code" workspace={second} visible />);
    await waitFor(() => expect(
      useCodeWorkspaceStore.getState().byInstanceId["instance-rebind-1"],
    ).toBeUndefined());
    expect(useCodeWorkspaceStore.getState().byInstanceId["instance-rebind-2"]).toBeTruthy();
  });
  it("closes the active editor tab with Ctrl+F4", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-close-tab",
      workspaceInstanceId: "instance-close-tab",
      name: "Close Tab",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/main.ts" },
    };
    caseContext.workspaceTestHarness.workspaceMocks.workspaceReadFile.mockResolvedValue(caseContext.workspaceTestHarness.file("src/main.ts", "export const value = 1;"));

    caseContext.workspaceTestHarness.renderWorkspace(workspace);
    await screen.findByTitle("app / src/main.ts");
    fireEvent.keyDown(window, { key: "F4", ctrlKey: true });

    await waitFor(() => expect(
      selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "instance-close-tab")
        .editorGroups.primary.openOrder,
    ).toHaveLength(0));
  });
  it("ED-TREE-001 moves selection without opening files or toggling directories", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app", workspaceId: "ws-tree-nav", workspaceInstanceId: "instance-tree-nav",
      name: "Tree navigation", roots: [{ id: "app", name: "app", path: "/repo/app", kind: "folder" }], looseFiles: [],
    };
    caseContext.workspaceTestHarness.workspaceMocks.workspaceListDir.mockImplementation(async (_root: string, path: string) => path === "src"
      ? [caseContext.workspaceTestHarness.entry("example.txt", "src/example.txt")]
      : [caseContext.workspaceTestHarness.entry("src", "src", "dir"), caseContext.workspaceTestHarness.entry("README.md", "README.md"), caseContext.workspaceTestHarness.entry("notes.txt", "notes.txt")]);
    caseContext.workspaceTestHarness.workspaceMocks.workspaceReadFile.mockImplementation(async (_root: string, path: string) => caseContext.workspaceTestHarness.file(path, `Keep ${path}`));
    caseContext.workspaceTestHarness.renderWorkspace(workspace);
    const readme = (await screen.findAllByTestId("code-workspace-tree-file")).find((row) => row.dataset.path === "README.md")!;
    fireEvent.doubleClick(readme);
    await screen.findByTitle("app / README.md");
    const before = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "instance-tree-nav");
    const pane = screen.getByTestId("code-workspace-tree-pane");
    fireEvent.keyDown(pane, { key: "ArrowDown" });
    expect(selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "instance-tree-nav").treeSelection)
      .toEqual({ kind: "file", ref: { kind: "root", rootId: "app", path: "notes.txt" } });
    expect(caseContext.workspaceTestHarness.workspaceMocks.workspaceReadFile).not.toHaveBeenCalledWith("/repo/app", "notes.txt");
    fireEvent.keyDown(pane, { key: "ArrowUp" });
    fireEvent.keyDown(pane, { key: "ArrowUp" });
    expect(screen.queryByTitle("app / src/example.txt")).toBeNull();
    expect(caseContext.workspaceTestHarness.workspaceMocks.workspaceListDir).not.toHaveBeenCalledWith("/repo/app", "src");
    const after = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "instance-tree-nav");
    expect(after.editorGroups.primary).toEqual(before.editorGroups.primary);
    expect(after.openFiles).toEqual(before.openFiles);
    fireEvent.keyDown(screen.getByTestId("code-workspace-tree-new"), { key: "ArrowDown" });
    fireEvent.keyDown(screen.getByTestId("code-workspace-tree-view-selector"), { key: "ArrowDown" });
    expect(selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "instance-tree-nav").treeSelection).toEqual(after.treeSelection);
  });
  it("ED-TREE-001 expands, enters children, returns to parent and collapses directionally", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app", workspaceId: "ws-tree-direction", workspaceInstanceId: "instance-tree-direction",
      name: "Tree direction", roots: [{ id: "app", name: "app", path: "/repo/app", kind: "folder" }], looseFiles: [],
    };
    caseContext.workspaceTestHarness.workspaceMocks.workspaceListDir.mockImplementation(async (_root: string, path: string) => path === "src"
      ? [caseContext.workspaceTestHarness.entry("example.txt", "src/example.txt")]
      : [caseContext.workspaceTestHarness.entry("src", "src", "dir")]);
    caseContext.workspaceTestHarness.workspaceMocks.workspaceReadFile.mockResolvedValue(caseContext.workspaceTestHarness.file("src/example.txt", "Keep tree navigation"));
    caseContext.workspaceTestHarness.renderWorkspace(workspace);
    const dir = await screen.findByTestId("code-workspace-tree-dir");
    // Select via the existing context action so this setup does not depend on
    // directory click expansion, which may be redesigned separately.
    fireEvent.contextMenu(dir);
    fireEvent.keyDown(document, { key: "Escape" });
    const pane = screen.getByTestId("code-workspace-tree-pane");
    fireEvent.keyDown(pane, { key: "ArrowRight" });
    const child = await screen.findByTestId("code-workspace-tree-file");
    fireEvent.keyDown(pane, { key: "ArrowRight" });
    expect(child).toHaveAttribute("data-selected", "true");
    expect(caseContext.workspaceTestHarness.workspaceMocks.workspaceReadFile).not.toHaveBeenCalled();
    fireEvent.keyDown(pane, { key: "ArrowLeft" });
    expect(dir).toHaveAttribute("data-selected", "true");
    expect(child).toBeInTheDocument();
    fireEvent.keyDown(pane, { key: "ArrowLeft" });
    expect(screen.queryByTestId("code-workspace-tree-file")).toBeNull();
    fireEvent.keyDown(pane, { key: "ArrowLeft" });
    expect(screen.getByTestId("code-workspace-tree-root")).toHaveAttribute("data-selected", "true");
    fireEvent.keyDown(pane, { key: "ArrowRight" });
    expect(dir).toHaveAttribute("data-selected", "true");
    fireEvent.keyDown(pane, { key: "ArrowRight" });
    await screen.findByTestId("code-workspace-tree-file");
    fireEvent.keyDown(pane, { key: "ArrowDown" });
    fireEvent.keyDown(pane, { key: "Enter" });
    await waitFor(() => expect(caseContext.workspaceTestHarness.workspaceMocks.workspaceReadFile).toHaveBeenCalledWith("/repo/app", "src/example.txt"));
    expect(screen.getByRole("treeitem", { name: /example.txt/ })).toHaveAttribute("aria-selected", "true");
  });
  it("ED-TREEOPEN-001: Enter on tree file formally opens and grants focus to editor without editor click", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-tree-open-focus",
      workspaceInstanceId: "instance-tree-open-focus",
      name: "Tree Open Focus",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "folder" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "README.md" },
    };
    caseContext.workspaceTestHarness.workspaceMocks.workspaceListDir.mockImplementation(async (_root: string, path: string) => path === "src"
      ? [caseContext.workspaceTestHarness.entry("example.txt", "src/example.txt")]
      : [caseContext.workspaceTestHarness.entry("src", "src", "dir"), caseContext.workspaceTestHarness.entry("README.md", "README.md")]);
    const originalText = "hello tree open focus parity\n";
    caseContext.workspaceTestHarness.workspaceMocks.workspaceReadFile.mockImplementation(async (_root: string, path: string) =>
      caseContext.workspaceTestHarness.file(path, path === "README.md" ? "# Readme\n" : originalText));

    caseContext.workspaceTestHarness.renderWorkspace(workspace);
    await screen.findByTitle("app / README.md");

    const pane = screen.getByTestId("code-workspace-tree-pane");
    const dir = await screen.findByTestId("code-workspace-tree-dir");

    // Expand dir by double clicking
    fireEvent.doubleClick(dir);
    const exampleFile = await screen.findByRole("treeitem", { name: /example.txt/ });
    expect(exampleFile).toBeInTheDocument();

    // Select example.txt and press Enter
    fireEvent.click(exampleFile);
    fireEvent.keyDown(pane, { key: "Enter" });

    // Verify example.txt tab is opened and active
    await screen.findByTitle("app / src/example.txt");
    await waitFor(() => {
      const activeElement = document.activeElement;
      expect(activeElement?.classList.contains("cm-content")).toBe(true);
    });

    const cmContent = document.querySelector<HTMLElement>(".cm-content")!;
    expect(document.activeElement).toBe(cmContent);

    // Direct input without clicking editor
    const view = EditorView.findFromDOM(document.querySelector<HTMLElement>(".cm-editor")!)!;
    expect(view.state.doc.toString()).toBe(originalText);
    view.dispatch({ changes: { from: 0, to: 0, insert: "typed-input;" } });
    expect(view.state.doc.toString()).toBe("typed-input;" + originalText);

    // Undo reverts back to original text
    fireEvent.keyDown(cmContent, { key: "z", ctrlKey: true });
    await waitFor(() => expect(view.state.doc.toString()).toBe(originalText));

    // Return to tree and right-click -> Esc restores selection and focus without mutating text
    fireEvent.contextMenu(exampleFile);
    expect(await screen.findByRole("button", { name: "Open" })).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("button", { name: "Open" })).not.toBeInTheDocument());
    expect(document.activeElement).toBe(exampleFile);
    expect(view.state.doc.toString()).toBe(originalText);
  });
}
