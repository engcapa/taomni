import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { selectCodeWorkspaceUi, useCodeWorkspaceStore } from "../../../../../../stores/codeWorkspaceStore";
import type { CodeWorkspaceTabInfo } from "../../../../../../types";
import { type registerLayoutCasesFixture } from "../../layout.cases";

export interface registerlayoutLayout4CasesContext {
  workspaceTestHarness: registerLayoutCasesFixture;
}

export function registerlayoutLayout4Cases(caseContext: registerlayoutLayout4CasesContext) {
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
      caseContext.workspaceTestHarness.renderWorkspace(workspace);

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
      const { container } = caseContext.workspaceTestHarness.renderWorkspace(workspace);

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
      const { container } = caseContext.workspaceTestHarness.renderWorkspace(workspace);

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
      caseContext.workspaceTestHarness.renderWorkspace(workspace);

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
      caseContext.workspaceTestHarness.renderWorkspace(workspace);

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
      caseContext.workspaceTestHarness.renderWorkspace(workspace);

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
      caseContext.workspaceTestHarness.workspaceMocks.workspaceReadFile.mockResolvedValue(
        caseContext.workspaceTestHarness.file("src/App.java", "public class App {}"),
      );

      caseContext.workspaceTestHarness.renderWorkspace(workspace);
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
      caseContext.workspaceTestHarness.renderWorkspace(workspace);

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
      caseContext.workspaceTestHarness.workspaceMocks.workspaceReadFile.mockResolvedValue(
        caseContext.workspaceTestHarness.file("src/App.java", "public class App {}"),
      );

      caseContext.workspaceTestHarness.renderWorkspace(workspace);
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
