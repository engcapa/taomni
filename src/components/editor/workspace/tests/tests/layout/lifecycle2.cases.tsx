import { EditorSelection } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useAppStore } from "../../../../../../stores/appStore";
import { selectCodeWorkspaceUi, useCodeWorkspaceStore } from "../../../../../../stores/codeWorkspaceStore";
import type { CodeWorkspaceTabInfo } from "../../../../../../types";
import type { WorkspaceCommandRegistration } from "../../../workspaceCommands";
import { type registerLayoutCasesFixture } from "../../layout.cases";

export interface registerlayoutLifecycle2CasesContext {
  workspaceTestHarness: registerLayoutCasesFixture;
}

export function registerlayoutLifecycle2Cases(caseContext: registerlayoutLifecycle2CasesContext) {
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
    caseContext.workspaceTestHarness.workspaceMocks.workspaceReadFile.mockResolvedValue(caseContext.workspaceTestHarness.file("src/main.ts", "const value = 1;\n"));

    caseContext.workspaceTestHarness.renderWorkspace(workspace);
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
    caseContext.workspaceTestHarness.workspaceMocks.workspaceReadFile.mockImplementation(async (_root: string, path: string) => (
      path === "src/util.ts"
        ? caseContext.workspaceTestHarness.file("src/util.ts", "export const util = 1;")
        : path === "src/other.ts"
          ? caseContext.workspaceTestHarness.file("src/other.ts", "export const other = 1;")
          : caseContext.workspaceTestHarness.file("src/main.ts", "export const main = 1;")
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

    caseContext.workspaceTestHarness.renderWorkspace(workspace, {}, { strict: true });

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
    expect(caseContext.workspaceTestHarness.workspaceMocks.workspaceReadFile).toHaveBeenCalledWith("/repo/app", "src/main.ts");
    expect(caseContext.workspaceTestHarness.workspaceMocks.workspaceReadFile).toHaveBeenCalledWith("/repo/app", "src/util.ts");
    expect(caseContext.workspaceTestHarness.workspaceMocks.workspaceReadFile).toHaveBeenCalledWith("/repo/app", "src/other.ts");
    expect(caseContext.workspaceTestHarness.workspaceMocks.workspaceReadFile).toHaveBeenCalledTimes(3);
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

    caseContext.workspaceTestHarness.workspaceMocks.workspaceReadFile.mockImplementation(async (_root: string, rel: string) => {
      if (rel === "coverage/lcov.info") {
        return caseContext.workspaceTestHarness.file("coverage/lcov.info", lcovContent);
      }
      return caseContext.workspaceTestHarness.file("src/Program.cs", "class Program {\n  void Main() {}\n}\n");
    });

    const registrationRef: { current: WorkspaceCommandRegistration | null; } = { current: null };
    const onCommandsChange = vi.fn((_tabId: string, next: WorkspaceCommandRegistration | null) => {
      if (next) registrationRef.current = next;
    });

    caseContext.workspaceTestHarness.renderWorkspace(workspace, { onCommandsChange });
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
    caseContext.workspaceTestHarness.workspaceMocks.workspaceReadFile.mockResolvedValue(caseContext.workspaceTestHarness.file("src/Program.cs", "line1\nline2\nline3\nline4\nline5\n"));

    const registrationRef: { current: WorkspaceCommandRegistration | null; } = { current: null };
    const onCommandsChange = vi.fn((_tabId: string, next: WorkspaceCommandRegistration | null) => {
      if (next) registrationRef.current = next;
    });

    caseContext.workspaceTestHarness.renderWorkspace(workspace, { onCommandsChange });
    await screen.findByTitle("app / src/Program.cs");

    // Split editor right
    const splitRightBtn = caseContext.workspaceTestHarness.toolbarControl("code-workspace-split-right");
    fireEvent.click(splitRightBtn);

    // Sync scroll button should appear
    caseContext.workspaceTestHarness.toolbarControl("code-workspace-split-sync-scroll");
    expect(caseContext.workspaceTestHarness.toolbarControl("code-workspace-split-sync-scroll")).toBeInTheDocument();
    expect(caseContext.workspaceTestHarness.toolbarControl("code-workspace-split-sync-scroll")).toHaveAttribute("aria-pressed", "false");

    // Click to enable synchronized scrolling
    fireEvent.click(caseContext.workspaceTestHarness.toolbarControl("code-workspace-split-sync-scroll"));
    expect(caseContext.workspaceTestHarness.toolbarControl("code-workspace-split-sync-scroll")).toHaveAttribute("aria-pressed", "true");
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
      mainSelection: { anchor: number; head: number; };
    }>> {
      const raw = window.localStorage.getItem(`taomni.codeWorkspace.layout.v2.${instance}`);
      if (!raw) return {};
      return JSON.parse(raw).viewStates ?? {};
    }

    it("pushes per-leaf caret state into the layout snapshot after the debounce", async () => {
      caseContext.workspaceTestHarness.workspaceMocks.workspaceListDir.mockResolvedValue([caseContext.workspaceTestHarness.entry("src", "src", "dir")]);
      caseContext.workspaceTestHarness.workspaceMocks.workspaceReadFile.mockResolvedValue(caseContext.workspaceTestHarness.file("src/Long.java", LONG_DOC, { hash: "hash-long" }));
      caseContext.workspaceTestHarness.lspMocks.lspOpenDocument.mockResolvedValue(caseContext.workspaceTestHarness.documentStatus({ available: true, active: false }));

      caseContext.workspaceTestHarness.renderWorkspace(viewWorkspace("instance-improve007-persist"));
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
      caseContext.workspaceTestHarness.workspaceMocks.workspaceListDir.mockResolvedValue([caseContext.workspaceTestHarness.entry("src", "src", "dir")]);
      caseContext.workspaceTestHarness.workspaceMocks.workspaceReadFile.mockResolvedValue(caseContext.workspaceTestHarness.file("src/Long.java", LONG_DOC, { hash: "hash-long" }));
      caseContext.workspaceTestHarness.lspMocks.lspOpenDocument.mockResolvedValue(caseContext.workspaceTestHarness.documentStatus({ available: true, active: false }));

      caseContext.workspaceTestHarness.renderWorkspace(viewWorkspace("instance-improve007-split"));
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

      fireEvent.click(caseContext.workspaceTestHarness.toolbarControl("code-workspace-split-right"));
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
}
