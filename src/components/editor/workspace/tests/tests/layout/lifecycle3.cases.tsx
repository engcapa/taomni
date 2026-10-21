import { EditorSelection } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { CodeWorkspaceTabInfo } from "../../../../../../types";
import { textIdentityFromString } from "../../../workspaceLayoutPersistence";
import { type registerLayoutCasesFixture } from "../../layout.cases";

export interface registerlayoutLifecycle3CasesContext {
  workspaceTestHarness: registerLayoutCasesFixture;
}

export function registerlayoutLifecycle3Cases(caseContext: registerlayoutLifecycle3CasesContext) {
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
      caseContext.workspaceTestHarness.workspaceMocks.workspaceListDir.mockResolvedValue([
        caseContext.workspaceTestHarness.entry("src", "src", "dir"),
        caseContext.workspaceTestHarness.entry("src/A.java", "A.java", "file"),
        caseContext.workspaceTestHarness.entry("src/B.java", "B.java", "file"),
      ]);
      caseContext.workspaceTestHarness.workspaceMocks.workspaceReadFile.mockImplementation(async (_root: string, path: string) => {
        if (path.endsWith("A.java")) return caseContext.workspaceTestHarness.file("src/A.java", DOC_A, { hash: "hash-a" });
        return caseContext.workspaceTestHarness.file("src/B.java", DOC_B, { hash: "hash-b" });
      });
      caseContext.workspaceTestHarness.lspMocks.lspOpenDocument.mockResolvedValue(caseContext.workspaceTestHarness.documentStatus({ available: true, active: false }));

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

      caseContext.workspaceTestHarness.renderWorkspace(repairWorkspace("instance-repair009-switch"));
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
      caseContext.workspaceTestHarness.workspaceMocks.workspaceListDir.mockResolvedValue([caseContext.workspaceTestHarness.entry("src", "src", "dir")]);
      caseContext.workspaceTestHarness.workspaceMocks.workspaceReadFile.mockResolvedValue(caseContext.workspaceTestHarness.file("src/A.java", DOC_A, { hash: "hash-a" }));
      caseContext.workspaceTestHarness.lspMocks.lspOpenDocument.mockResolvedValue(caseContext.workspaceTestHarness.documentStatus({ available: true, active: false }));

      const { unmount } = caseContext.workspaceTestHarness.renderWorkspace(repairWorkspace("instance-repair009-unmount"));
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
      caseContext.workspaceTestHarness.workspaceMocks.workspaceListDir.mockResolvedValue([caseContext.workspaceTestHarness.entry("src", "src", "dir")]);
      caseContext.workspaceTestHarness.workspaceMocks.workspaceReadFile.mockResolvedValue(caseContext.workspaceTestHarness.file("src/A.java", DOC_A, { hash: "hash-a" }));
      caseContext.workspaceTestHarness.lspMocks.lspOpenDocument.mockResolvedValue(caseContext.workspaceTestHarness.documentStatus({ available: true, active: false }));

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

      caseContext.workspaceTestHarness.renderWorkspace(repairWorkspace("instance-repair009-inactive"));
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
}
