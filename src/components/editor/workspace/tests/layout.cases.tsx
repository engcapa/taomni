import { EditorSelection } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { act,fireEvent,screen,waitFor,within } from "@testing-library/react";
import { describe,expect,it,vi } from "vitest";
import { confirmAppDialog } from "../../../../lib/appDialogs";
import { useAppStore } from "../../../../stores/appStore";
import { selectCodeWorkspaceUi,useCodeWorkspaceStore } from "../../../../stores/codeWorkspaceStore";
import type { CodeWorkspaceTabInfo } from "../../../../types";
import { CodeWorkspaceTab } from "../../CodeWorkspaceTab";
import type { WorkspaceTestFixture } from "../../CodeWorkspaceTab.test";
import type { WorkspaceCommandRegistration } from "../workspaceCommands";
import { textIdentityFromString } from "../workspaceLayoutPersistence";

export type registerLayoutCasesFixture = Pick<WorkspaceTestFixture, "workspaceMocks" | "entry" | "file" | "renderWorkspace" | "lspMocks" | "csharpStatus" | "documentStatus" | "toolbarControl">;

export function registerLayoutCases(workspaceTestHarness: registerLayoutCasesFixture) {
it("persists and renders the flat file view with language src groups only", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-flat",
      name: "Flat",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: null,
    };
    workspaceTestHarness.workspaceMocks.workspaceListDir.mockResolvedValue([workspaceTestHarness.entry("src", "src", "dir")]);
    workspaceTestHarness.workspaceMocks.workspaceListFilesRecursive.mockResolvedValue([
      workspaceTestHarness.entry("README.md", "README.md"),
      workspaceTestHarness.entry("App.tsx", "src/App.tsx"),
      workspaceTestHarness.entry("lib.rs", "src-tauri/src/lib.rs"),
      workspaceTestHarness.entry("guide.md", "docs/guide.md"),
      workspaceTestHarness.entry("foo.rs", "target/debug/foo.rs"),
    ]);
    workspaceTestHarness.workspaceMocks.workspaceReadFile.mockResolvedValue(workspaceTestHarness.file("src/App.tsx", "export function App() {}"));

    workspaceTestHarness.renderWorkspace(workspace);

    expect(await screen.findByText("Code · Flat")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("code-workspace-tree-view-selector"));
    fireEvent.click(screen.getByTestId("code-workspace-tree-view-project-files"));

    expect(window.localStorage.getItem("taomni.codeWorkspace.treeViewMode.v1")).toBe("flat");
    expect(await screen.findByText("src")).toBeInTheDocument();
    expect(await screen.findByText("src-tauri/src")).toBeInTheDocument();
    expect(screen.queryByText("README.md")).not.toBeInTheDocument();
    expect(screen.queryByText("guide.md")).not.toBeInTheDocument();
    expect(screen.queryByText("(root)")).not.toBeInTheDocument();
    expect(screen.getAllByTestId("code-workspace-flat-file")).toHaveLength(2);
    expect(screen.getByText("App.tsx")).toBeInTheDocument();
    expect(screen.getByText("lib.rs")).toBeInTheDocument();

    fireEvent.doubleClick(screen.getByText("App.tsx"));
    await waitFor(() => {
      expect(workspaceTestHarness.workspaceMocks.workspaceReadFile).toHaveBeenCalledWith("/repo/app", "src/App.tsx");
    });
  });
it("renders its left tool window bar into the collapsed sidebar rail (ED-PARITY-027)", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-rail",
      workspaceInstanceId: "instance-rail",
      name: "Rail",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
    };
    workspaceTestHarness.workspaceMocks.workspaceListDir.mockResolvedValue([workspaceTestHarness.entry("src", "src", "dir")]);
    const host = document.createElement("div");
    document.body.appendChild(host);
    const { useMainRailHostStore } = await import("../../../../stores/mainRailHostStore");
    useMainRailHostStore.setState({ host });
    useAppStore.setState({ mergeToolWindowRail: true, sidebarCollapsed: true });
    try {
      const { rerender } = workspaceTestHarness.renderWorkspace(workspace);
      await waitFor(() => expect(host.querySelector('[data-testid="code-workspace-tool-rail-left"]')).not.toBeNull());
      expect(host.querySelector('[data-testid="code-workspace-tool-rail-left"]')).toHaveAttribute("data-embedded", "true");
      expect(host.querySelector('[data-tool-window-id="project"]')).not.toBeNull();
      // The right bar stays inside the workspace.
      expect(host.querySelector('[data-testid="code-workspace-tool-rail-right"]')).toBeNull();
      // Expanding the sidebar returns the bar to the workspace.
      act(() => useAppStore.setState({ sidebarCollapsed: false }));
      await waitFor(() => expect(host.querySelector('[data-testid="code-workspace-tool-rail-left"]')).toBeNull());
      expect(screen.getByTestId("code-workspace-tool-rail-left")).not.toHaveAttribute("data-embedded");
      // An inactive workspace never claims the rail.
      act(() => useAppStore.setState({ sidebarCollapsed: true }));
      rerender(<CodeWorkspaceTab tabId="tab-code" workspace={workspace} visible={false} />);
      expect(host.querySelector('[data-testid="code-workspace-tool-rail-left"]')).toBeNull();
    } finally {
      useMainRailHostStore.setState({ host: null });
      useAppStore.setState({ sidebarCollapsed: false });
      host.remove();
    }
  });
it("retains a same-file split buffer until the final view closes, then releases it once", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-split",
      workspaceInstanceId: "instance-split",
      name: "Split",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/Program.cs" },
    };
    workspaceTestHarness.workspaceMocks.workspaceReadFile.mockResolvedValue(workspaceTestHarness.file("src/Program.cs", "class Program {}"));
    workspaceTestHarness.lspMocks.lspDetectServers.mockResolvedValue([workspaceTestHarness.csharpStatus({ available: true, active: true })]);
    workspaceTestHarness.lspMocks.lspOpenDocument.mockResolvedValue(workspaceTestHarness.documentStatus({ available: true, active: true }));

    workspaceTestHarness.renderWorkspace(workspace);
    await screen.findAllByText("Program.cs");
    await waitFor(() => expect(workspaceTestHarness.lspMocks.lspOpenDocument).toHaveBeenCalledTimes(1));
    fireEvent.click(workspaceTestHarness.toolbarControl("code-workspace-split-right"));

    await waitFor(() => expect(
      selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "instance-split").splitOrientation,
    ).toBe("vertical"));
    expect(await screen.findByTestId("code-workspace-editor-split")).toBeInTheDocument();
    expect(screen.getAllByTestId("code-workspace-editor-pane")).toHaveLength(2);
    // §8.16.4 N6.6: a split materializes two recursive leaves sharing one buffer.
    const ui = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "instance-split");
    const tree = ui.layoutTreeV2;
    expect(tree?.type).toBe("split");
    if (tree?.type === "split") {
      const leafActiveKeys = tree.children
        .filter((child) => child.type === "leaf")
        .map((child) => child.activeKey);
      expect(leafActiveKeys).toHaveLength(2);
      expect(leafActiveKeys[0]).toBe(leafActiveKeys[1]);
    }
    expect(Object.keys(ui.openFiles)).toHaveLength(1);

    const fileKey = "root:app:src/Program.cs";
    fireEvent.click(within(screen.getAllByTestId("code-workspace-editor-pane")[0]).getByTitle("Close"));
    await waitFor(() => expect(Object.values(
      selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "instance-split").editorGroups,
    ).filter((group) => group.openOrder.includes(fileKey))).toHaveLength(1));
    expect(workspaceTestHarness.lspMocks.lspCloseDocument).not.toHaveBeenCalled();
    expect(selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "instance-split").openFiles[fileKey]).toBeDefined();

    const remainingPane = screen.getAllByTestId("code-workspace-editor-pane").find(
      (pane) => within(pane).queryByTitle("Close") !== null,
    );
    expect(remainingPane).toBeDefined();
    fireEvent.click(within(remainingPane!).getByTitle("Close"));
    await waitFor(() => expect(workspaceTestHarness.lspMocks.lspCloseDocument).toHaveBeenCalledTimes(1));
    expect(selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "instance-split").openFiles[fileKey]).toBeUndefined();
  });
it("keeps keyboard history routed to the survivor when the active split leaf closes", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-active-split-close",
      workspaceInstanceId: "instance-active-split-close",
      name: "Active split close",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "folder" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/main.ts" },
    };
    workspaceTestHarness.workspaceMocks.workspaceReadFile.mockResolvedValue(workspaceTestHarness.file("src/main.ts", "alpha\nbeta\n"));
    workspaceTestHarness.lspMocks.lspDetectServers.mockResolvedValue([workspaceTestHarness.csharpStatus({ available: false, active: false })]);

    workspaceTestHarness.renderWorkspace(workspace);
    await screen.findByTitle("app / src/main.ts");
    fireEvent.click(workspaceTestHarness.toolbarControl("code-workspace-split-right"));
    await waitFor(() => expect(screen.getAllByTestId("code-workspace-editor-pane")).toHaveLength(2));

    const panes = screen.getAllByTestId("code-workspace-editor-pane");
    const primaryPane = panes.find((pane) => pane.getAttribute("data-editor-group-id") === "primary")!;
    const activeSplitPane = panes.find((pane) => pane.getAttribute("data-editor-group-id") !== "primary")!;
    const primaryView = EditorView.findFromDOM(primaryPane.querySelector<HTMLElement>(".cm-editor")!)!;
    primaryView.dispatch({ changes: { from: 0, to: 0, insert: "HEAD;" } });
    await waitFor(() => expect(
      EditorView.findFromDOM(activeSplitPane.querySelector<HTMLElement>(".cm-editor")!)!.state.doc.toString(),
    ).toBe("HEAD;alpha\nbeta\n"));
    expect(selectCodeWorkspaceUi(
      useCodeWorkspaceStore.getState(),
      "instance-active-split-close",
    ).activeEditorGroupId).not.toBe("primary");

    // The split created above is the active group. Closing its only tab must
    // transfer action ownership to the surviving primary leaf even when the
    // next key is delivered directly to that leaf without a pane mousedown.
    fireEvent.click(within(activeSplitPane).getByTitle("Close"));
    await waitFor(() => expect(
      selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "instance-active-split-close").activeEditorGroupId,
    ).toBe("primary"));
    await waitFor(() => expect(screen.getAllByTestId("code-workspace-editor-pane")).toHaveLength(2));

    const primaryContent = primaryPane.querySelector<HTMLElement>(".cm-content")!;
    fireEvent.keyDown(primaryContent, { key: "z", code: "KeyZ", ctrlKey: true });
    await waitFor(() => expect(primaryView.state.doc.toString()).toBe("alpha\nbeta\n"));
  });
it("ED-AUDIT-009: same-file split leaves share one edit/undo history in real time", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-audit009-split",
      workspaceInstanceId: "instance-audit009-split",
      name: "Audit009 Split",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "folder" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/main.ts" },
    };
    workspaceTestHarness.workspaceMocks.workspaceReadFile.mockImplementation(async (_root: string, _path: string) => (
      workspaceTestHarness.file("src/main.ts", "alpha\nbeta\n")
    ));
    workspaceTestHarness.lspMocks.lspDetectServers.mockResolvedValue([workspaceTestHarness.csharpStatus({ available: false, active: false })]);
    window.localStorage.setItem("taomni.codeWorkspace.layout.v1.instance-audit009-split", JSON.stringify({
      version: 1,
      splitOrientation: "vertical",
      activeEditorGroupId: "primary",
      editorGroups: {
        primary: {
          openOrder: ["root:app:src/main.ts"],
          activeKey: "root:app:src/main.ts",
          previewKey: null,
          pinnedKeys: [],
        },
        secondary: {
          openOrder: ["root:app:src/main.ts"],
          activeKey: "root:app:src/main.ts",
          previewKey: null,
          pinnedKeys: [],
        },
      },
    }));

    workspaceTestHarness.renderWorkspace(workspace);
    await screen.findAllByTitle("app / src/main.ts");

    const panes = screen.getAllByTestId("code-workspace-editor-pane");
    const primaryPane = panes.find((pane) => pane.getAttribute("data-editor-group-id") === "primary")!;
    const secondaryPane = panes.find((pane) => pane.getAttribute("data-editor-group-id") === "secondary")!;
    const primaryView = EditorView.findFromDOM(primaryPane.querySelector<HTMLElement>(".cm-editor")!)!;
    const secondaryView = EditorView.findFromDOM(secondaryPane.querySelector<HTMLElement>(".cm-editor")!)!;
    // History strokes target the editor surface (.cm-content): a pane-div
    // target resolves as workspace focus, so the requiresEditor history
    // actions are rejected before the shared owner is ever consulted.
    const primaryContent = primaryPane.querySelector<HTMLElement>(".cm-content")!;
    const secondaryContent = secondaryPane.querySelector<HTMLElement>(".cm-content")!;

    // Edit in the primary leaf: the secondary leaf shows it in real time.
    primaryView.dispatch({ changes: { from: 0, to: 0, insert: "HEAD;" } });
    await waitFor(() => expect(secondaryView.state.doc.toString()).toBe("HEAD;alpha\nbeta\n"));
    expect(primaryView.state.doc.toString()).toBe("HEAD;alpha\nbeta\n");

    // Park the primary caret mid-document and scroll it away from the top;
    // the secondary leaf's edit must not clobber either.
    primaryView.dispatch({ selection: EditorSelection.cursor(5) });
    const primaryScroller = primaryPane.querySelector<HTMLElement>(".cm-scroller")!;
    primaryScroller.scrollTop = 40;
    secondaryView.dispatch({
      changes: { from: "HEAD;alpha\nbeta\n".length, to: "HEAD;alpha\nbeta\n".length, insert: "TAIL;" },
    });
    await waitFor(() => expect(primaryView.state.doc.toString()).toBe("HEAD;alpha\nbeta\nTAIL;"));
    expect(secondaryView.state.doc.toString()).toBe("HEAD;alpha\nbeta\nTAIL;");
    expect(primaryView.state.selection.main.head).toBe(5);
    expect(primaryScroller.scrollTop).toBe(40);

    // One Ctrl+Z in the SECONDARY leaf reverts the shared history in BOTH leaves.
    fireEvent.keyDown(secondaryContent, { key: "z", ctrlKey: true });
    await waitFor(() => expect(primaryView.state.doc.toString()).toBe("HEAD;alpha\nbeta\n"));
    expect(secondaryView.state.doc.toString()).toBe("HEAD;alpha\nbeta\n");

    // One redo from the PRIMARY leaf re-applies the same shared entry in both.
    fireEvent.keyDown(primaryContent, { key: "z", ctrlKey: true, shiftKey: true });
    await waitFor(() => expect(primaryView.state.doc.toString()).toBe("HEAD;alpha\nbeta\nTAIL;"));
    expect(secondaryView.state.doc.toString()).toBe("HEAD;alpha\nbeta\nTAIL;");
  });
it("ED-PARITY-003: preview formalize, split, independent selection, shared edit, single undo, close non-last keeps alive", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-parity003",
      workspaceInstanceId: "instance-parity003",
      name: "Parity003",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "folder" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/main/example.txt" },
    };
    const initialText = "Project tree example\nThe editor buffer should survive tree navigation.\n";
    workspaceTestHarness.workspaceMocks.workspaceReadFile.mockImplementation(async (_root: string, _path: string) => (
      workspaceTestHarness.file("src/main/example.txt", initialText)
    ));
    workspaceTestHarness.lspMocks.lspDetectServers.mockResolvedValue([workspaceTestHarness.csharpStatus({ available: true, active: true })]);
    workspaceTestHarness.lspMocks.lspOpenDocument.mockResolvedValue(workspaceTestHarness.documentStatus({ available: true, active: true }));

    workspaceTestHarness.renderWorkspace(workspace);
    const fileKey = "root:app:src/main/example.txt";
    await screen.findByTitle("app / src/main/example.txt");
    // Plain-text example.txt has no active LSP session, so no open is
    // expected; the didClose assertions below observe zero additional calls.

    // S0: establish preview through the production group state (same state
    // openFile preview:true writes) and observe italic + data-preview.
    const { updateEditorGroup } = useCodeWorkspaceStore.getState();
    updateEditorGroup("instance-parity003", "primary", (group) => ({
      ...group,
      previewKey: fileKey,
    }));
    await waitFor(() => expect(
      selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "instance-parity003")
        .editorGroups.primary.previewKey,
    ).toBe(fileKey));
    const tabStrip = screen.getByTestId("code-workspace-editor-tab-strip");
    const previewTabButton = within(tabStrip).getByTitle("app / src/main/example.txt");
    expect(previewTabButton.closest("[data-editor-tab-key]")).toHaveAttribute("data-preview", "true");
    expect(within(tabStrip).getByText("example.txt")).toHaveClass("italic");

    // S1a: double-click promotes to a formal tab without editing.
    fireEvent.doubleClick(previewTabButton);
    await waitFor(() => expect(
      selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "instance-parity003")
        .editorGroups.primary.previewKey,
    ).toBeNull());
    expect(within(screen.getByTestId("code-workspace-editor-tab-strip")).getByText("example.txt")).not.toHaveClass("italic");
    expect(previewTabButton.closest("[data-editor-tab-key]")).not.toHaveAttribute("data-preview");

    // S1b: re-enter preview, then typing promotes and marks dirty.
    updateEditorGroup("instance-parity003", "primary", (group) => ({
      ...group,
      previewKey: fileKey,
    }));
    await waitFor(() => expect(within(screen.getByTestId("code-workspace-editor-tab-strip")).getByText("example.txt")).toHaveClass("italic"));
    const singlePane = screen.getByTestId("code-workspace-editor-pane");
    const singleView = EditorView.findFromDOM(singlePane.querySelector<HTMLElement>(".cm-editor")!)!;
    singleView.dispatch({ changes: { from: 0, to: 0, insert: "X" } });
    await waitFor(() => expect(
      selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "instance-parity003")
        .editorGroups.primary.previewKey,
    ).toBeNull());
    await waitFor(() => expect(
      selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "instance-parity003")
        .openFiles[fileKey]?.dirty,
    ).toBe(true));
    expect(within(screen.getByTestId("code-workspace-editor-tab-strip")).getByText("example.txt")).not.toHaveClass("italic");
    const afterTypingText = `X${initialText}`;
    await waitFor(() => expect(singleView.state.doc.toString()).toBe(afterTypingText));

    // S2: Open in Split Right from the tab context menu; both panes share the
    // file and the new (right) leaf becomes active.
    const tabButton = within(screen.getByTestId("code-workspace-editor-tab-strip")).getByTitle("app / src/main/example.txt");
    fireEvent.contextMenu(tabButton, { clientX: 10, clientY: 10 });
    fireEvent.click(await screen.findByRole("button", { name: "Split Right" }));
    await waitFor(() => expect(screen.getAllByTestId("code-workspace-editor-pane")).toHaveLength(2));
    const panes = screen.getAllByTestId("code-workspace-editor-pane");
    const leftPane = panes.find((pane) => pane.getAttribute("data-editor-group-id") === "primary")!;
    const rightPane = panes.find((pane) => pane.getAttribute("data-editor-group-id") !== "primary")!;
    const afterSplitUi = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "instance-parity003");
    expect(afterSplitUi.activeEditorGroupId).not.toBe("primary");
    expect(afterSplitUi.editorGroups.primary.openOrder).toContain(fileKey);
    const rightGroupId = rightPane.getAttribute("data-editor-group-id")!;
    expect(afterSplitUi.editorGroups[rightGroupId]?.openOrder).toContain(fileKey);
    const leftView = EditorView.findFromDOM(leftPane.querySelector<HTMLElement>(".cm-editor")!)!;
    const rightView = EditorView.findFromDOM(rightPane.querySelector<HTMLElement>(".cm-editor")!)!;
    expect(leftView.state.doc.toString()).toBe(afterTypingText);
    expect(rightView.state.doc.toString()).toBe(afterTypingText);

    // S3: independent cursors/selections across the two views.
    rightView.dispatch({ selection: EditorSelection.cursor(rightView.state.doc.length) });
    leftView.dispatch({ selection: EditorSelection.range(0, "Project tree example".length + 1) });
    expect(leftView.state.selection.main.empty).toBe(false);
    expect(leftView.state.selection.main.from).toBe(0);
    expect(rightView.state.selection.main.empty).toBe(true);
    expect(rightView.state.selection.main.head).toBe(rightView.state.doc.length);

    // S4: shared edit in the left pane syncs to the right in real time.
    const sharedMarker = "// SHARED-SYNC-OK";
    leftView.dispatch({
      changes: { from: leftView.state.doc.length, to: leftView.state.doc.length, insert: sharedMarker },
    });
    const afterSharedText = `${afterTypingText}${sharedMarker}`;
    await waitFor(() => expect(rightView.state.doc.toString()).toBe(afterSharedText));
    expect(leftView.state.doc.toString()).toBe(afterSharedText);
    await waitFor(() => expect(
      selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "instance-parity003")
        .openFiles[fileKey]?.dirty,
    ).toBe(true));

    // S5: one Ctrl+Z reverts the shared marker in both panes.
    const leftContent = leftPane.querySelector<HTMLElement>(".cm-content")!;
    fireEvent.keyDown(leftContent, { key: "z", ctrlKey: true });
    await waitFor(() => expect(leftView.state.doc.toString()).toBe(afterTypingText));
    expect(rightView.state.doc.toString()).toBe(afterTypingText);

    // S6: close the non-last (right) view; the emptied leaf keeps rendering
    // (it loses only its tab strip entry) while the survivor keeps the buffer,
    // history and dirty state with no didClose, no buffer drop and no confirm.
    // NOTE: IDEA R6 removes the empty pane to a single pane; Taomni keeps the
    // empty leaf (two panes, one empty). Functional retention matches IDEA;
    // the pane-count delta is recorded in the idea-comparison, not as an AC
    // failure (A1 requires only lease/buffer/dirty retention).
    const closeCallsBefore = vi.mocked(workspaceTestHarness.lspMocks.lspCloseDocument).mock.calls.length;
    const confirmCallsBefore = vi.mocked(confirmAppDialog).mock.calls.length;
    fireEvent.click(within(rightPane).getByTitle("Close"));
    await waitFor(() => expect(
      within(rightPane).queryByTitle("app / src/main/example.txt"),
    ).not.toBeInTheDocument());
    expect(screen.getAllByTestId("code-workspace-editor-pane")).toHaveLength(2);
    const survivorPane = screen.getAllByTestId("code-workspace-editor-pane").find(
      (pane) => within(pane).queryByTitle("app / src/main/example.txt") !== null,
    )!;
    const survivorView = EditorView.findFromDOM(survivorPane.querySelector<HTMLElement>(".cm-editor")!)!;
    expect(survivorView.state.doc.toString()).toBe(afterTypingText);
    expect(selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "instance-parity003").layoutTreeV2.type).toBe("split");
    expect(selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "instance-parity003").openFiles[fileKey]).toBeDefined();
    expect(vi.mocked(workspaceTestHarness.lspMocks.lspCloseDocument).mock.calls.length).toBe(closeCallsBefore);
    expect(vi.mocked(confirmAppDialog).mock.calls.length).toBe(confirmCallsBefore);
    expect(workspaceTestHarness.workspaceMocks.workspaceWriteFile).not.toHaveBeenCalled();

    // S7: closing the last dirty view with Cancel is zero effect.
    vi.mocked(confirmAppDialog).mockImplementationOnce(async () => false);
    fireEvent.click(within(survivorPane).getByTitle("Close"));
    await waitFor(() => expect(vi.mocked(confirmAppDialog)).toHaveBeenCalledTimes(confirmCallsBefore + 1));
    expect(within(survivorPane).getByTitle("app / src/main/example.txt")).toBeInTheDocument();
    expect(survivorView.state.doc.toString()).toBe(afterTypingText);
    expect(workspaceTestHarness.workspaceMocks.workspaceWriteFile).not.toHaveBeenCalled();
  });
it("opens the selected tree file in a split with Ctrl+Enter", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-tree-split",
      workspaceInstanceId: "instance-tree-split",
      name: "Tree Split",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
    };
    workspaceTestHarness.workspaceMocks.workspaceListDir.mockResolvedValue([workspaceTestHarness.entry("README.md", "README.md")]);
    workspaceTestHarness.workspaceMocks.workspaceReadFile.mockResolvedValue(workspaceTestHarness.file("README.md", "# Readme"));

    workspaceTestHarness.renderWorkspace(workspace);
    const row = await screen.findByTestId("code-workspace-tree-file");
    fireEvent.click(row);
    fireEvent.keyDown(screen.getByTestId("code-workspace-tree-pane"), {
      key: "Enter",
      ctrlKey: true,
    });

    expect(await screen.findByTestId("code-workspace-editor-split")).toBeInTheDocument();
    // §8.16.4 N6.6: Ctrl+Enter opens the tree file in a new recursive leaf.
    const ui = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "instance-tree-split");
    const tree = ui.layoutTreeV2;
    expect(tree?.type).toBe("split");
    const leafKeys = tree?.type === "split"
      ? tree.children.flatMap((child) => (child.type === "leaf" ? [child.activeKey] : []))
      : [];
    expect(leafKeys).toContain("root:app:README.md");
  });
it("renames bookmark groups with Enter or Escape and returns focus to the group action", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-bookmark-group-focus",
      workspaceInstanceId: "instance-bookmark-group-focus",
      name: "Bookmark group focus",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/main.ts" },
    };
    workspaceTestHarness.workspaceMocks.workspaceReadFile.mockResolvedValue(workspaceTestHarness.file("src/main.ts", "const value = 1;\n"));

    workspaceTestHarness.renderWorkspace(workspace);
    const editor = await screen.findByTestId("code-workspace-editor-pane");
    fireEvent.keyDown(editor, { key: "F11", code: "F11" });
    await screen.findByTestId("code-workspace-bookmark-group");

    const rename = screen.getByTestId("code-workspace-bookmark-group-rename");
    fireEvent.click(rename);
    const input = await screen.findByTestId("code-workspace-bookmark-group-input");
    expect(document.activeElement).toBe(input);
    fireEvent.change(input, { target: { value: "Review" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(screen.getByTestId("code-workspace-bookmark-group"))
      .toHaveAttribute("data-group-name", "Review"));
    expect(document.activeElement).toBe(screen.getByTestId("code-workspace-bookmark-group-rename"));
    expect(window.localStorage.getItem("taomni.codeWorkspace.bookmarks.v1.instance-bookmark-group-focus"))
      .toContain("Review");

    const renamed = screen.getByTestId("code-workspace-bookmark-group-rename");
    fireEvent.click(renamed);
    const secondInput = await screen.findByTestId("code-workspace-bookmark-group-input");
    fireEvent.change(secondInput, { target: { value: "Canceled" } });
    fireEvent.keyDown(secondInput, { key: "Escape" });

    await waitFor(() => expect(screen.getByTestId("code-workspace-bookmark-group"))
      .toHaveAttribute("data-group-name", "Review"));
    expect(document.activeElement).toBe(screen.getByTestId("code-workspace-bookmark-group-rename"));
    expect(window.localStorage.getItem("taomni.codeWorkspace.bookmarks.v1.instance-bookmark-group-focus"))
      .not.toContain("Canceled");
  });
it("restores open editor tabs and dock chrome from the layout snapshot", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-layout-restore",
      workspaceInstanceId: "instance-layout-restore",
      name: "Layout Restore",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/main.ts" },
    };
    workspaceTestHarness.workspaceMocks.workspaceReadFile.mockImplementation(async (_root: string, path: string) => (
      path === "src/util.ts"
        ? workspaceTestHarness.file("src/util.ts", "export const util = 1;")
        : path === "src/other.ts"
          ? workspaceTestHarness.file("src/other.ts", "export const other = 1;")
        : workspaceTestHarness.file("src/main.ts", "export const main = 1;")
    ));
    window.localStorage.setItem("taomni.codeWorkspace.layout.v1.instance-layout-restore", JSON.stringify({
      version: 1,
      bottomDockOpen: false,
      bottomDockTab: "search",
      rightPaneOpen: true,
      rightPaneTab: "outline",
      languagePanelOpen: false,
      splitOrientation: "vertical",
      activeEditorGroupId: "primary",
      expandedRootIds: ["app"],
      expandedDirKeys: ["app:"],
      editorGroups: {
        primary: {
          openOrder: ["root:app:src/main.ts", "root:app:src/other.ts"],
          activeKey: "root:app:src/main.ts",
          previewKey: null,
          pinnedKeys: ["root:app:src/main.ts"],
        },
        secondary: {
          openOrder: ["root:app:src/util.ts"],
          activeKey: "root:app:src/util.ts",
          previewKey: null,
          pinnedKeys: [],
        },
      },
    }));

    workspaceTestHarness.renderWorkspace(workspace, {}, { strict: true });

    await screen.findByTitle("app / src/main.ts");
    await screen.findByTitle("app / src/util.ts");
    await screen.findByTitle("app / src/other.ts");
    await waitFor(() => {
      const ui = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "instance-layout-restore");
      expect(ui.bottomDockOpen).toBe(false);
      expect(ui.bottomDockTab).toBe("search");
      expect(ui.rightPaneOpen).toBe(true);
      expect(ui.languagePanelOpen).toBe(false);
      expect(ui.splitOrientation).toBe("vertical");
      expect(ui.editorGroups.primary.openOrder).toContain("root:app:src/main.ts");
      expect(ui.editorGroups.secondary.openOrder).toContain("root:app:src/util.ts");
      expect(ui.editorGroups.primary.activeKey).toBe("root:app:src/main.ts");
      expect(ui.editorGroups.secondary.activeKey).toBe("root:app:src/util.ts");
    });
    // ED-PARITY-010: the Project stripe button replaces the collapsed rail.
    expect(screen.getByTestId("code-workspace-tool-rail-project")).toHaveAttribute("aria-pressed", "false");
    expect(workspaceTestHarness.workspaceMocks.workspaceReadFile).toHaveBeenCalledWith("/repo/app", "src/main.ts");
    expect(workspaceTestHarness.workspaceMocks.workspaceReadFile).toHaveBeenCalledWith("/repo/app", "src/util.ts");
    expect(workspaceTestHarness.workspaceMocks.workspaceReadFile).toHaveBeenCalledWith("/repo/app", "src/other.ts");
    expect(workspaceTestHarness.workspaceMocks.workspaceReadFile).toHaveBeenCalledTimes(3);
  });
it("ingests workspace test coverage report and renders coverage dock panel", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-coverage",
      workspaceInstanceId: "instance-coverage",
      name: "Coverage test",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/Program.cs" },
    };

    const lcovContent = `
SF:src/Program.cs
DA:1,3
DA:2,0
LF:2
LH:1
end_of_record
`;

    workspaceTestHarness.workspaceMocks.workspaceReadFile.mockImplementation(async (_root: string, rel: string) => {
      if (rel === "coverage/lcov.info") {
        return workspaceTestHarness.file("coverage/lcov.info", lcovContent);
      }
      return workspaceTestHarness.file("src/Program.cs", "class Program {\n  void Main() {}\n}\n");
    });

    const registrationRef: { current: WorkspaceCommandRegistration | null } = { current: null };
    const onCommandsChange = vi.fn((_tabId: string, next: WorkspaceCommandRegistration | null) => {
      if (next) registrationRef.current = next;
    });

    workspaceTestHarness.renderWorkspace(workspace, { onCommandsChange });
    await screen.findByTitle("app / src/Program.cs");

    // Execute workspace.showCoverage command
    expect(registrationRef.current?.items.find((item) => item.id === "workspace.showCoverage")?.enabled).toBe(true);
    await act(async () => {
      registrationRef.current?.execute("workspace.showCoverage");
    });

    await waitFor(() => {
      expect(screen.getByTestId("coverage-overall-badge")).toBeInTheDocument();
      expect(screen.getByTestId("coverage-overall-badge")).toHaveTextContent("50%");
    });
  });
it("toggles synchronized split scrolling when editor is split", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-split",
      workspaceInstanceId: "instance-split",
      name: "Split test",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/Program.cs" },
    };
    workspaceTestHarness.workspaceMocks.workspaceReadFile.mockResolvedValue(workspaceTestHarness.file("src/Program.cs", "line1\nline2\nline3\nline4\nline5\n"));

    const registrationRef: { current: WorkspaceCommandRegistration | null } = { current: null };
    const onCommandsChange = vi.fn((_tabId: string, next: WorkspaceCommandRegistration | null) => {
      if (next) registrationRef.current = next;
    });

    workspaceTestHarness.renderWorkspace(workspace, { onCommandsChange });
    await screen.findByTitle("app / src/Program.cs");

    // Split editor right
    const splitRightBtn = workspaceTestHarness.toolbarControl("code-workspace-split-right");
    fireEvent.click(splitRightBtn);

    // Sync scroll button should appear
    workspaceTestHarness.toolbarControl("code-workspace-split-sync-scroll");
    expect(workspaceTestHarness.toolbarControl("code-workspace-split-sync-scroll")).toBeInTheDocument();
    expect(workspaceTestHarness.toolbarControl("code-workspace-split-sync-scroll")).toHaveAttribute("aria-pressed", "false");

    // Click to enable synchronized scrolling
    fireEvent.click(workspaceTestHarness.toolbarControl("code-workspace-split-sync-scroll"));
    expect(workspaceTestHarness.toolbarControl("code-workspace-split-sync-scroll")).toHaveAttribute("aria-pressed", "true");
    expect(useAppStore.getState().statusMessage).toBe("Synchronized split scrolling enabled");

    // Toggle via command
    expect(registrationRef.current?.items.find((item) => item.id === "workspace.toggleSyncSplitScroll")?.enabled).toBe(true);
    await act(async () => {
      registrationRef.current?.execute("workspace.toggleSyncSplitScroll");
    });
    expect(useAppStore.getState().statusMessage).toBe("Synchronized split scrolling disabled");
  });
describe("ED-IMPROVE-007 per-leaf/file view snapshots (mounted)", () => {
    const LONG_DOC = Array.from({ length: 60 }, (_, index) => `line ${index}`).join("\n");

    function viewWorkspace(instance: string): CodeWorkspaceTabInfo {
      return {
        repoRoot: "/repo/app",
        workspaceId: "ws-improve007",
        workspaceInstanceId: instance,
        name: "Improve 007",
        roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
        looseFiles: [],
        initialFile: { kind: "root", rootId: "app", path: "src/Long.java" },
      };
    }

    function fileKeyFor(): string {
      return "root:app:src/Long.java";
    }

    function storedViewStates(instance: string): Record<string, Record<string, {
      mainSelection: { anchor: number; head: number };
    }>> {
      const raw = window.localStorage.getItem(`taomni.codeWorkspace.layout.v2.${instance}`);
      if (!raw) return {};
      return JSON.parse(raw).viewStates ?? {};
    }

    it("pushes per-leaf caret state into the layout snapshot after the debounce", async () => {
      workspaceTestHarness.workspaceMocks.workspaceListDir.mockResolvedValue([workspaceTestHarness.entry("src", "src", "dir")]);
      workspaceTestHarness.workspaceMocks.workspaceReadFile.mockResolvedValue(workspaceTestHarness.file("src/Long.java", LONG_DOC, { hash: "hash-long" }));
      workspaceTestHarness.lspMocks.lspOpenDocument.mockResolvedValue(workspaceTestHarness.documentStatus({ available: true, active: false }));

      workspaceTestHarness.renderWorkspace(viewWorkspace("instance-improve007-persist"));
      await screen.findByTitle("app / src/Long.java");
      const pane = screen.getAllByTestId("code-workspace-editor-pane")[0]!;
      const view = EditorView.findFromDOM(pane.querySelector(".cm-editor")!)!;
      act(() => {
        view.dispatch({ selection: EditorSelection.cursor(40) });
      });
      await waitFor(() => expect(
        Object.keys(storedViewStates("instance-improve007-persist")).length,
      ).toBeGreaterThan(0), { timeout: 4000 });
      const states = storedViewStates("instance-improve007-persist");
      const leafIds = Object.keys(states);
      expect(leafIds.length).toBeGreaterThan(0);
      const persisted = leafIds
        .map((leafId) => states[leafId]?.[fileKeyFor()]?.mainSelection.head)
        .filter((head): head is number => typeof head === "number");
      expect(persisted).toContain(40);
    });

    it("keeps independent caret state for the same file in two leaves and restores the right leaf after reopen", async () => {
      workspaceTestHarness.workspaceMocks.workspaceListDir.mockResolvedValue([workspaceTestHarness.entry("src", "src", "dir")]);
      workspaceTestHarness.workspaceMocks.workspaceReadFile.mockResolvedValue(workspaceTestHarness.file("src/Long.java", LONG_DOC, { hash: "hash-long" }));
      workspaceTestHarness.lspMocks.lspOpenDocument.mockResolvedValue(workspaceTestHarness.documentStatus({ available: true, active: false }));

      workspaceTestHarness.renderWorkspace(viewWorkspace("instance-improve007-split"));
      await screen.findByTitle("app / src/Long.java");
      const firstPane = screen.getAllByTestId("code-workspace-editor-pane")[0]!;
      const firstView = EditorView.findFromDOM(firstPane.querySelector(".cm-editor")!)!;
      act(() => {
        firstView.dispatch({ selection: EditorSelection.cursor(40) });
      });
      await waitFor(() => {
        const heads = Object.values(storedViewStates("instance-improve007-split"))
          .map((files) => files[fileKeyFor()]?.mainSelection.head);
        expect(heads).toContain(40);
      }, { timeout: 4000 });

      fireEvent.click(workspaceTestHarness.toolbarControl("code-workspace-split-right"));
      await waitFor(() => expect(screen.getAllByTestId("code-workspace-editor-pane")).toHaveLength(2));
      const panes = screen.getAllByTestId("code-workspace-editor-pane");
      const secondView = EditorView.findFromDOM(panes[1]!.querySelector(".cm-editor")!)!;
      act(() => {
        secondView.dispatch({ selection: EditorSelection.cursor(10) });
      });
      await waitFor(() => {
        const heads = Object.values(storedViewStates("instance-improve007-split"))
          .map((files) => files[fileKeyFor()]?.mainSelection.head);
        expect(heads).toContain(10);
        expect(heads).toContain(40);
      }, { timeout: 4000 });

      const states = storedViewStates("instance-improve007-split");
      const heads = Object.values(states)
        .map((files) => files[fileKeyFor()]?.mainSelection.head)
        .filter((head): head is number => typeof head === "number")
        .sort((a, b) => a - b);
      // Same document, two leaves: each leaf kept its own caret.
      expect(heads).toEqual([10, 40]);

      // Restart/reopen restore is covered by the CodeMirrorHost one-shot
      // apply tests and the native C4-03 reload_window case.
    });
  });
describe("ED-REPAIR-009: view state snapshot consistency (mounted)", () => {
    const DOC_A = "line0\nline1\nline2\nline3\nline4\nline5\nline6\nline7\nline8\nline9";
    const DOC_B = "other0\nother1\nother2\nother3\nother4\nother5";

    function repairWorkspace(instance: string): CodeWorkspaceTabInfo {
      return {
        repoRoot: "/repo/app",
        workspaceId: "ws-repair009",
        workspaceInstanceId: instance,
        name: "Repair 009",
        roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
        looseFiles: [],
        initialFile: { kind: "root", rootId: "app", path: "src/A.java" },
      };
    }

    function storedLayout(instance: string) {
      const raw = window.localStorage.getItem(`taomni.codeWorkspace.layout.v2.${instance}`);
      return raw ? JSON.parse(raw) : null;
    }

    it("restores caret after editing and switching tabs within 1 second (ED-REPAIR-009-A1)", async () => {
      workspaceTestHarness.workspaceMocks.workspaceListDir.mockResolvedValue([
        workspaceTestHarness.entry("src", "src", "dir"),
        workspaceTestHarness.entry("src/A.java", "A.java", "file"),
        workspaceTestHarness.entry("src/B.java", "B.java", "file"),
      ]);
      workspaceTestHarness.workspaceMocks.workspaceReadFile.mockImplementation(async (_root: string, path: string) => {
        if (path.endsWith("A.java")) return workspaceTestHarness.file("src/A.java", DOC_A, { hash: "hash-a" });
        return workspaceTestHarness.file("src/B.java", DOC_B, { hash: "hash-b" });
      });
      workspaceTestHarness.lspMocks.lspOpenDocument.mockResolvedValue(workspaceTestHarness.documentStatus({ available: true, active: false }));

      const seedLayout = {
        version: 2,
        bottomDockOpen: false,
        bottomDockTab: "problems",
        rightPaneOpen: false,
        rightPaneTab: "outline",
        languagePanelOpen: false,
        splitOrientation: "vertical",
        activeEditorGroupId: "primary",
        expandedRootIds: ["app"],
        expandedDirKeys: [],
        layoutTreeV2: {
          type: "leaf",
          id: "primary",
          openFileKeys: ["root:app:src/A.java", "root:app:src/B.java"],
          activeKey: "root:app:src/A.java",
        },
        editorGroups: {
          primary: {
            openOrder: ["root:app:src/A.java", "root:app:src/B.java"],
            activeKey: "root:app:src/A.java",
            previewKey: null,
            pinnedKeys: [],
          },
        },
        viewStates: {},
      };
      window.localStorage.setItem("taomni.codeWorkspace.layout.v2.instance-repair009-switch", JSON.stringify(seedLayout));

      workspaceTestHarness.renderWorkspace(repairWorkspace("instance-repair009-switch"));
      await screen.findByTitle("app / src/A.java");
      await screen.findByTitle("app / src/B.java");

      const pane = screen.getAllByTestId("code-workspace-editor-pane")[0]!;
      const viewA = EditorView.findFromDOM(pane.querySelector(".cm-editor")!)!;

      // Insert text and move cursor to offset 25 within 1 second
      act(() => {
        viewA.dispatch({
          changes: { from: 0, insert: "ZZ" },
          selection: EditorSelection.cursor(25),
        });
      });

      // Switch to B.java before any 1s debounce/throttle has settled
      const tabB = screen.getByTitle("app / src/B.java");
      fireEvent.click(tabB);

      await waitFor(() => {
        const currentPane = screen.getAllByTestId("code-workspace-editor-pane")[0]!;
        const currentView = EditorView.findFromDOM(currentPane.querySelector(".cm-editor")!)!;
        expect(currentView.state.doc.toString()).toBe(DOC_B);
      });

      // Now switch back to A.java
      const tabA = screen.getByTitle("app / src/A.java");
      fireEvent.click(tabA);

      await waitFor(() => {
        const paneBack = screen.getAllByTestId("code-workspace-editor-pane")[0]!;
        const viewABack = EditorView.findFromDOM(paneBack.querySelector(".cm-editor")!)!;
        expect(viewABack.state.doc.toString().startsWith("ZZ")).toBe(true);
        // Caret must be restored to 25!
        expect(viewABack.state.selection.main.head).toBe(25);
      });
    });

    it("flushes tail capture to localStorage on workspace unmount (ED-REPAIR-009-A1, A2)", async () => {
      workspaceTestHarness.workspaceMocks.workspaceListDir.mockResolvedValue([workspaceTestHarness.entry("src", "src", "dir")]);
      workspaceTestHarness.workspaceMocks.workspaceReadFile.mockResolvedValue(workspaceTestHarness.file("src/A.java", DOC_A, { hash: "hash-a" }));
      workspaceTestHarness.lspMocks.lspOpenDocument.mockResolvedValue(workspaceTestHarness.documentStatus({ available: true, active: false }));

      const { unmount } = workspaceTestHarness.renderWorkspace(repairWorkspace("instance-repair009-unmount"));
      await screen.findByTitle("app / src/A.java");
      const pane = screen.getAllByTestId("code-workspace-editor-pane")[0]!;
      const view = EditorView.findFromDOM(pane.querySelector(".cm-editor")!)!;

      act(() => {
        view.dispatch({ selection: EditorSelection.cursor(35) });
      });

      // Immediately unmount (workspace closing / tab closing)
      unmount();

      const layout = storedLayout("instance-repair009-unmount");
      expect(layout).not.toBeNull();
      const primaryState = layout.viewStates?.primary?.["root:app:src/A.java"];
      expect(primaryState?.mainSelection?.head).toBe(35);
      expect(primaryState?.textIdentity).toBe(textIdentityFromString(DOC_A));
    });

    it("inactive leaf snapshot preserves original identity when text changes in active leaf and drops stale position on restore (ED-REPAIR-009-A2)", async () => {
      workspaceTestHarness.workspaceMocks.workspaceListDir.mockResolvedValue([workspaceTestHarness.entry("src", "src", "dir")]);
      workspaceTestHarness.workspaceMocks.workspaceReadFile.mockResolvedValue(workspaceTestHarness.file("src/A.java", DOC_A, { hash: "hash-a" }));
      workspaceTestHarness.lspMocks.lspOpenDocument.mockResolvedValue(workspaceTestHarness.documentStatus({ available: true, active: false }));

      // Seed a layout where secondary leaf has an old snapshot for "abc" with caret 2
      const oldDocIdentity = textIdentityFromString("abc");
      const seedLayout = {
        version: 2,
        bottomDockOpen: false,
        bottomDockTab: "problems",
        rightPaneOpen: false,
        rightPaneTab: "outline",
        languagePanelOpen: false,
        splitOrientation: "vertical",
        activeEditorGroupId: "primary",
        expandedRootIds: ["app"],
        expandedDirKeys: [],
        layoutTreeV2: {
          type: "split",
          id: "split-root",
          orientation: "vertical",
          ratios: [0.5, 0.5],
          children: [
            { type: "leaf", id: "primary", openFileKeys: ["root:app:src/A.java"], activeKey: "root:app:src/A.java" },
            { type: "leaf", id: "secondary", openFileKeys: ["root:app:src/A.java"], activeKey: "root:app:src/A.java" },
          ],
        },
        editorGroups: {
          primary: { openOrder: ["root:app:src/A.java"], activeKey: "root:app:src/A.java", previewKey: null, pinnedKeys: [] },
          secondary: { openOrder: ["root:app:src/A.java"], activeKey: "root:app:src/A.java", previewKey: null, pinnedKeys: [] },
        },
        viewStates: {
          primary: { "root:app:src/A.java": { mainSelection: { anchor: 10, head: 10 }, selections: [], scrollTop: 0, folds: [], textIdentity: textIdentityFromString(DOC_A) } },
          secondary: { "root:app:src/A.java": { mainSelection: { anchor: 2, head: 2 }, selections: [], scrollTop: 0, folds: [], textIdentity: oldDocIdentity } },
        },
      };
      window.localStorage.setItem("taomni.codeWorkspace.layout.v2.instance-repair009-inactive", JSON.stringify(seedLayout));

      workspaceTestHarness.renderWorkspace(repairWorkspace("instance-repair009-inactive"));
      await screen.findAllByTitle("app / src/A.java");
      await waitFor(() => {
        const panes = screen.getAllByTestId("code-workspace-editor-pane");
        expect(panes).toHaveLength(2);
        const primaryCm = panes[0]?.querySelector<HTMLElement>(".cm-editor");
        const secondaryCm = panes[1]?.querySelector<HTMLElement>(".cm-editor");
        expect(primaryCm).toBeTruthy();
        expect(secondaryCm).toBeTruthy();
        const primaryView = EditorView.findFromDOM(primaryCm!)!;
        const secondaryView = EditorView.findFromDOM(secondaryCm!)!;
        // Primary had matching identity for DOC_A -> restored caret at 10
        expect(primaryView.state.selection.main.head).toBe(10);
        // Secondary had identity for "abc" (mismatches DOC_A) -> stale caret 2 was DROPPED, defaults to 0
        expect(secondaryView.state.selection.main.head).toBe(0);
      });
    });
  });
describe("ED-SHELLLAYOUT-001 / WP-SHELL-LAYOUT-01 shell layout parity", () => {
    it("mounts default layout S0 with Project open (452px), bottom dock closed, right pane closed", async () => {
      const workspace: CodeWorkspaceTabInfo = {
        repoRoot: "/repo/app",
        workspaceId: "ws-shell-s0",
        workspaceInstanceId: "instance-shell-s0",
        name: "Shell S0",
        roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
        looseFiles: [],
      };
      workspaceTestHarness.renderWorkspace(workspace);

      await waitFor(() => {
        const ui = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "instance-shell-s0");
        expect(ui.languagePanelOpen).toBe(true);
        expect(ui.bottomDockOpen).toBe(false);
        expect(ui.rightPaneOpen).toBe(false);
        expect(ui.shellChromeState?.projectWidthPx).toBe(452);
        expect(ui.shellChromeState?.bottomHeightByTool?.problems).toBe(449);
        expect(ui.shellChromeState?.bottomHeightByTool?.run).toBe(323);
      });
    });

    it("mounts the project panel at the persisted projectWidthPx instead of the 452px default (ED-SPLITTER-001)", async () => {
      window.localStorage.setItem(
        "taomni.codeWorkspace.layout.v2.instance-shell-splitter-persist",
        JSON.stringify({
          version: 2,
          bottomDockOpen: false,
          bottomDockTab: "problems",
          rightPaneOpen: false,
          rightPaneTab: "outline",
          languagePanelOpen: true,
          splitOrientation: null,
          activeEditorGroupId: "primary",
          expandedRootIds: [],
          expandedDirKeys: [],
          layoutTreeV2: { type: "leaf", id: "primary", openFileKeys: [], activeKey: null },
          editorGroups: {
            primary: { openOrder: [], activeKey: null, previewKey: null, pinnedKeys: [] },
            secondary: { openOrder: [], activeKey: null, previewKey: null, pinnedKeys: [] },
          },
          viewStates: {},
          shellChromeState: { version: 1, projectWidthPx: 318 },
        }),
      );

      const workspace: CodeWorkspaceTabInfo = {
        repoRoot: "/repo/app",
        workspaceId: "ws-shell-splitter-persist",
        workspaceInstanceId: "instance-shell-splitter-persist",
        name: "Shell Splitter Persist",
        roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
        looseFiles: [],
      };
      const { container } = workspaceTestHarness.renderWorkspace(workspace);

      await waitFor(() => {
        expect(container.querySelector('[data-testid="panel"][data-default-size="318px"]')).toBeTruthy();
      });
      expect(container.querySelector('[data-testid="panel"][data-default-size="452px"]')).toBeNull();
    });

    it("keeps the project panel defaultSize static when the persisted width changes mid-session (ED-SPLITTER-001)", async () => {
      const workspace: CodeWorkspaceTabInfo = {
        repoRoot: "/repo/app",
        workspaceId: "ws-shell-splitter-static",
        workspaceInstanceId: "instance-shell-splitter-static",
        name: "Shell Splitter Static",
        roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
        looseFiles: [],
      };
      const { container } = workspaceTestHarness.renderWorkspace(workspace);

      await waitFor(() => {
        expect(container.querySelector('[data-testid="panel"][data-default-size="452px"]')).toBeTruthy();
      });

      act(() => {
        useCodeWorkspaceStore.getState().setShellChromeState("instance-shell-splitter-static", {
          projectWidthPx: 320,
        });
      });

      // A live drag writes the width to the shell store while the pointer is
      // down. The mounted Panel must keep its mount-time defaultSize, otherwise
      // react-resizable-panels re-registers it and the drag session freezes.
      expect(container.querySelector('[data-testid="panel"][data-default-size="452px"]')).toBeTruthy();
      expect(container.querySelector('[data-testid="panel"][data-default-size="320px"]')).toBeNull();
    });

    it("renders the project splitter handle with an explicit id, hot zone and disabled collapse state (ED-SPLITTER-001)", async () => {
      const workspace: CodeWorkspaceTabInfo = {
        repoRoot: "/repo/app",
        workspaceId: "ws-shell-splitter-handle",
        workspaceInstanceId: "instance-shell-splitter-handle",
        name: "Shell Splitter Handle",
        roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
        looseFiles: [],
      };
      workspaceTestHarness.renderWorkspace(workspace);

      const handle = await screen.findByTestId("code-workspace-project-resize-handle");
      expect(handle).toHaveAttribute("id", "code-workspace-project-resize-handle");
      expect(handle).not.toHaveAttribute("aria-disabled");
      expect(handle.className).toContain("cursor-col-resize");
      expect(handle.className).toContain("after:-left-1.5");
      expect(handle.className).toContain("after:-right-1.5");
      expect(handle.className).toContain("active:bg-[var(--taomni-accent)]");

      fireEvent.click(screen.getByTestId("code-workspace-tree-collapse"));
      await waitFor(() => {
        expect(
          selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "instance-shell-splitter-handle").languagePanelOpen,
        ).toBe(false);
      });

      const collapsedHandle = screen.getByTestId("code-workspace-project-resize-handle");
      expect(collapsedHandle).toHaveAttribute("aria-disabled", "true");
      expect(collapsedHandle.className).toContain("hidden");
    });

    it("toggles bottom dock tool windows with Alt+6 (Problems) and Alt+4 (Run)", async () => {
      const workspace: CodeWorkspaceTabInfo = {
        repoRoot: "/repo/app",
        workspaceId: "ws-shell-tools",
        workspaceInstanceId: "instance-shell-tools",
        name: "Shell Tools",
        roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
        looseFiles: [],
      };
      workspaceTestHarness.renderWorkspace(workspace);

      // Initially closed
      let ui = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "instance-shell-tools");
      expect(ui.bottomDockOpen).toBe(false);

      // Alt+6 opens Problems
      fireEvent.keyDown(window, { key: "6", altKey: true });
      await waitFor(() => {
        ui = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "instance-shell-tools");
        expect(ui.bottomDockOpen).toBe(true);
        expect(ui.bottomDockTab).toBe("problems");
      });

      // Alt+4 switches to Run
      fireEvent.keyDown(window, { key: "4", altKey: true });
      await waitFor(() => {
        ui = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "instance-shell-tools");
        expect(ui.bottomDockOpen).toBe(true);
        expect(ui.bottomDockTab).toBe("run");
      });
    });

    it("restores default tool window layout on Shift+F12", async () => {
      const workspace: CodeWorkspaceTabInfo = {
        repoRoot: "/repo/app",
        workspaceId: "ws-shell-restore",
        workspaceInstanceId: "instance-shell-restore",
        name: "Shell Restore",
        roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
        looseFiles: [],
      };
      workspaceTestHarness.renderWorkspace(workspace);

      // Open bottom dock and close project panel
      act(() => {
        useCodeWorkspaceStore.getState().patchInstance("instance-shell-restore", {
          languagePanelOpen: false,
          bottomDockOpen: true,
          bottomDockTab: "run",
          rightPaneOpen: true,
        });
      });

      let ui = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "instance-shell-restore");
      expect(ui.languagePanelOpen).toBe(false);
      expect(ui.bottomDockOpen).toBe(true);
      expect(ui.rightPaneOpen).toBe(true);

      // Shift+F12 triggers workspace.restoreToolWindowLayout
      fireEvent.keyDown(window, { key: "F12", shiftKey: true });

      await waitFor(() => {
        ui = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "instance-shell-restore");
        expect(ui.languagePanelOpen).toBe(true);
        expect(ui.bottomDockOpen).toBe(false);
        expect(ui.rightPaneOpen).toBe(false);
        expect(ui.shellChromeState?.projectWidthPx).toBe(452);
      });
    });

    it("restores default layout on Shift+F12 even when an editor file is open and active (no Shift+F12 conflict)", async () => {
      const workspace: CodeWorkspaceTabInfo = {
        repoRoot: "/repo/app",
        workspaceId: "ws-shell-restore-with-file",
        workspaceInstanceId: "instance-shell-restore-with-file",
        name: "Shell Restore With File",
        roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
        looseFiles: [],
        initialFile: { kind: "root", rootId: "app", path: "src/App.java" },
      };
      workspaceTestHarness.workspaceMocks.workspaceReadFile.mockResolvedValue(
        workspaceTestHarness.file("src/App.java", "public class App {}"),
      );

      workspaceTestHarness.renderWorkspace(workspace);
      await screen.findByTitle("app / src/App.java");

      // Mutate UI: bottom dock open, project panel closed
      act(() => {
        useCodeWorkspaceStore.getState().patchInstance("instance-shell-restore-with-file", {
          languagePanelOpen: false,
          bottomDockOpen: true,
          bottomDockTab: "problems",
          rightPaneOpen: true,
        });
      });

      let ui = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "instance-shell-restore-with-file");
      expect(ui.languagePanelOpen).toBe(false);
      expect(ui.bottomDockOpen).toBe(true);
      expect(ui.rightPaneOpen).toBe(true);

      // Focus editor element
      const editorPane = screen.getByTestId("code-workspace-editor-pane");
      const content = editorPane.querySelector(".cm-content");
      if (content instanceof HTMLElement) {
        content.focus();
      }

      // Press Shift+F12: should restore layout, NOT be rejected as conflict with findReferences
      fireEvent.keyDown(window, { key: "F12", shiftKey: true });

      await waitFor(() => {
        ui = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "instance-shell-restore-with-file");
        expect(ui.languagePanelOpen).toBe(true);
        expect(ui.bottomDockOpen).toBe(false);
        expect(ui.rightPaneOpen).toBe(false);
        expect(ui.shellChromeState?.projectWidthPx).toBe(452);
      });
    });

    it("returns focus to active editor when Escape is pressed from tool window", async () => {
      const workspace: CodeWorkspaceTabInfo = {
        repoRoot: "/repo/app",
        workspaceId: "ws-shell-escape",
        workspaceInstanceId: "instance-shell-escape",
        name: "Shell Escape",
        roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
        looseFiles: [],
      };
      workspaceTestHarness.renderWorkspace(workspace);

      // Open Problems dock via Alt+6
      fireEvent.keyDown(window, { key: "6", altKey: true });
      await waitFor(() => {
        expect(screen.getByTestId("code-workspace-bottom-dock")).toBeInTheDocument();
      });

      // Press Escape from inside dock
      const bottomDock = screen.getByTestId("code-workspace-bottom-dock");
      fireEvent.keyDown(bottomDock, { key: "Escape" });
      // Verify dock still mounted and handled escape without throwing
      expect(bottomDock).toBeInTheDocument();
    });

    it("ignores Escape in tree filter input during IME composition and preserves input focus", async () => {
      const workspace: CodeWorkspaceTabInfo = {
        repoRoot: "/repo/app",
        workspaceId: "ws-shell-tree-ime",
        workspaceInstanceId: "instance-shell-tree-ime",
        name: "Shell Tree IME",
        roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
        looseFiles: [],
        initialFile: { kind: "root", rootId: "app", path: "src/App.java" },
      };
      workspaceTestHarness.workspaceMocks.workspaceReadFile.mockResolvedValue(
        workspaceTestHarness.file("src/App.java", "public class App {}"),
      );

      workspaceTestHarness.renderWorkspace(workspace);
      await screen.findByTitle("app / src/App.java");

      // IDEA speed search: typing in the tree opens the search field.
      fireEvent.keyDown(screen.getByTestId("code-workspace-tree-pane"), { key: "a" });
      const filterInput = screen.getByTestId("code-workspace-tree-filter");
      filterInput.focus();
      expect(document.activeElement).toBe(filterInput);

      // Press Escape with isComposing: true
      fireEvent.keyDown(filterInput, {
        key: "Escape",
        isComposing: true,
        nativeEvent: { isComposing: true },
      });

      // Focus should remain on the filter input, not stolen back to editor
      expect(document.activeElement).toBe(filterInput);
    });
  });
}
