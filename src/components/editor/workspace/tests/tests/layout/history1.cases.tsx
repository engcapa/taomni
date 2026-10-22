import { EditorSelection } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { confirmAppDialog } from "../../../../../../lib/appDialogs";
import { useAppStore } from "../../../../../../stores/appStore";
import { selectCodeWorkspaceUi, useCodeWorkspaceStore } from "../../../../../../stores/codeWorkspaceStore";
import type { CodeWorkspaceTabInfo } from "../../../../../../types";
import { CodeWorkspaceTab } from "../../../../CodeWorkspaceTab";
import { type registerLayoutCasesFixture } from "../../layout.cases";

export interface registerlayoutHistory1CasesContext {
  workspaceTestHarness: registerLayoutCasesFixture;
}

export function registerlayoutHistory1Cases(caseContext: registerlayoutHistory1CasesContext) {
  it("persists and renders the flat file view with language src groups only", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-flat",
      name: "Flat",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: null,
    };
    caseContext.workspaceTestHarness.workspaceMocks.workspaceListDir.mockResolvedValue([caseContext.workspaceTestHarness.entry("src", "src", "dir")]);
    caseContext.workspaceTestHarness.workspaceMocks.workspaceListFilesRecursive.mockResolvedValue([
      caseContext.workspaceTestHarness.entry("README.md", "README.md"),
      caseContext.workspaceTestHarness.entry("App.tsx", "src/App.tsx"),
      caseContext.workspaceTestHarness.entry("lib.rs", "src-tauri/src/lib.rs"),
      caseContext.workspaceTestHarness.entry("guide.md", "docs/guide.md"),
      caseContext.workspaceTestHarness.entry("foo.rs", "target/debug/foo.rs"),
    ]);
    caseContext.workspaceTestHarness.workspaceMocks.workspaceReadFile.mockResolvedValue(caseContext.workspaceTestHarness.file("src/App.tsx", "export function App() {}"));

    caseContext.workspaceTestHarness.renderWorkspace(workspace);

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
      expect(caseContext.workspaceTestHarness.workspaceMocks.workspaceReadFile).toHaveBeenCalledWith("/repo/app", "src/App.tsx");
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
    caseContext.workspaceTestHarness.workspaceMocks.workspaceListDir.mockResolvedValue([caseContext.workspaceTestHarness.entry("src", "src", "dir")]);
    const host = document.createElement("div");
    document.body.appendChild(host);
    const { useMainRailHostStore } = await import("../../../../../../stores/mainRailHostStore");
    useMainRailHostStore.setState({ host });
    useAppStore.setState({ mergeToolWindowRail: true, sidebarCollapsed: true });
    try {
      const { rerender } = caseContext.workspaceTestHarness.renderWorkspace(workspace);
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
    caseContext.workspaceTestHarness.workspaceMocks.workspaceReadFile.mockResolvedValue(caseContext.workspaceTestHarness.file("src/Program.cs", "class Program {}"));
    caseContext.workspaceTestHarness.lspMocks.lspDetectServers.mockResolvedValue([caseContext.workspaceTestHarness.csharpStatus({ available: true, active: true })]);
    caseContext.workspaceTestHarness.lspMocks.lspOpenDocument.mockResolvedValue(caseContext.workspaceTestHarness.documentStatus({ available: true, active: true }));

    caseContext.workspaceTestHarness.renderWorkspace(workspace);
    await screen.findAllByText("Program.cs");
    await waitFor(() => expect(caseContext.workspaceTestHarness.lspMocks.lspOpenDocument).toHaveBeenCalledTimes(1));
    fireEvent.click(caseContext.workspaceTestHarness.toolbarControl("code-workspace-split-right"));

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
    expect(caseContext.workspaceTestHarness.lspMocks.lspCloseDocument).not.toHaveBeenCalled();
    expect(selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "instance-split").openFiles[fileKey]).toBeDefined();

    const remainingPane = screen.getAllByTestId("code-workspace-editor-pane").find(
      (pane) => within(pane).queryByTitle("Close") !== null,
    );
    expect(remainingPane).toBeDefined();
    fireEvent.click(within(remainingPane!).getByTitle("Close"));
    await waitFor(() => expect(caseContext.workspaceTestHarness.lspMocks.lspCloseDocument).toHaveBeenCalledTimes(1));
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
    caseContext.workspaceTestHarness.workspaceMocks.workspaceReadFile.mockResolvedValue(caseContext.workspaceTestHarness.file("src/main.ts", "alpha\nbeta\n"));
    caseContext.workspaceTestHarness.lspMocks.lspDetectServers.mockResolvedValue([caseContext.workspaceTestHarness.csharpStatus({ available: false, active: false })]);

    caseContext.workspaceTestHarness.renderWorkspace(workspace);
    await screen.findByTitle("app / src/main.ts");
    fireEvent.click(caseContext.workspaceTestHarness.toolbarControl("code-workspace-split-right"));
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
    caseContext.workspaceTestHarness.workspaceMocks.workspaceReadFile.mockImplementation(async (_root: string, _path: string) => (
      caseContext.workspaceTestHarness.file("src/main.ts", "alpha\nbeta\n")
    ));
    caseContext.workspaceTestHarness.lspMocks.lspDetectServers.mockResolvedValue([caseContext.workspaceTestHarness.csharpStatus({ available: false, active: false })]);
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

    caseContext.workspaceTestHarness.renderWorkspace(workspace);
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
    caseContext.workspaceTestHarness.workspaceMocks.workspaceReadFile.mockImplementation(async (_root: string, _path: string) => (
      caseContext.workspaceTestHarness.file("src/main/example.txt", initialText)
    ));
    caseContext.workspaceTestHarness.lspMocks.lspDetectServers.mockResolvedValue([caseContext.workspaceTestHarness.csharpStatus({ available: true, active: true })]);
    caseContext.workspaceTestHarness.lspMocks.lspOpenDocument.mockResolvedValue(caseContext.workspaceTestHarness.documentStatus({ available: true, active: true }));

    caseContext.workspaceTestHarness.renderWorkspace(workspace);
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
    const closeCallsBefore = vi.mocked(caseContext.workspaceTestHarness.lspMocks.lspCloseDocument).mock.calls.length;
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
    expect(vi.mocked(caseContext.workspaceTestHarness.lspMocks.lspCloseDocument).mock.calls.length).toBe(closeCallsBefore);
    expect(vi.mocked(confirmAppDialog).mock.calls.length).toBe(confirmCallsBefore);
    expect(caseContext.workspaceTestHarness.workspaceMocks.workspaceWriteFile).not.toHaveBeenCalled();

    // S7: closing the last dirty view with Cancel is zero effect.
    vi.mocked(confirmAppDialog).mockImplementationOnce(async () => false);
    fireEvent.click(within(survivorPane).getByTitle("Close"));
    await waitFor(() => expect(vi.mocked(confirmAppDialog)).toHaveBeenCalledTimes(confirmCallsBefore + 1));
    expect(within(survivorPane).getByTitle("app / src/main/example.txt")).toBeInTheDocument();
    expect(survivorView.state.doc.toString()).toBe(afterTypingText);
    expect(caseContext.workspaceTestHarness.workspaceMocks.workspaceWriteFile).not.toHaveBeenCalled();
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
    caseContext.workspaceTestHarness.workspaceMocks.workspaceListDir.mockResolvedValue([caseContext.workspaceTestHarness.entry("README.md", "README.md")]);
    caseContext.workspaceTestHarness.workspaceMocks.workspaceReadFile.mockResolvedValue(caseContext.workspaceTestHarness.file("README.md", "# Readme"));

    caseContext.workspaceTestHarness.renderWorkspace(workspace);
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
}
