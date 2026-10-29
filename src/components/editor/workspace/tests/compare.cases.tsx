import { findEditorByTitle } from "./editorReadiness";
import { EditorSelection } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { confirmAppDialog } from "../../../../lib/appDialogs";
import { useAppStore } from "../../../../stores/appStore";
import { selectCodeWorkspaceUi, useCodeWorkspaceStore } from "../../../../stores/codeWorkspaceStore";
import type { CodeWorkspaceTabInfo } from "../../../../types";
import type { WorkspaceCommandRegistration } from "../workspaceCommands";
import { type registerInteractionCasesFixture } from "./interaction.cases";

export function registerCompareCases(workspaceTestHarness: registerInteractionCasesFixture) {
describe("ED-COMPARE-001 editor compare workflow", () => {
    const compareWorkspace = (instanceId: string): CodeWorkspaceTabInfo => ({
      repoRoot: "/repo/app",
      workspaceId: `ws-${instanceId}`,
      workspaceInstanceId: instanceId,
      name: "Compare Workflow",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/main.ts" },
    });

    const captureCommands = () => {
      const registrationRef: { current: WorkspaceCommandRegistration | null } = { current: null };
      const onCommandsChange = vi.fn((_tabId: string, next: WorkspaceCommandRegistration | null) => {
        if (next) registrationRef.current = next;
      });
      return { registrationRef, onCommandsChange };
    };

    it("reads the selected file and mounts the shared compare surface", async () => {
      const workspace = compareWorkspace("instance-compare-file");
      workspaceTestHarness.workspaceMocks.workspaceReadFile.mockImplementation(async (_root: string, path: string) => (
        path === "reference.ts"
          ? workspaceTestHarness.file(path, "const value = 2;\n", { encoding: "UTF-16LE", bom: true })
          : workspaceTestHarness.file(path, "const value = 1;\n")
      ));
      workspaceTestHarness.ipcMocks.selectFilePath.mockResolvedValue("/repo/app/reference.ts");
      const { registrationRef, onCommandsChange } = captureCommands();

      workspaceTestHarness.renderWorkspace(workspace, { onCommandsChange });
      await findEditorByTitle("app / src/main.ts");
      await waitFor(() => expect(registrationRef.current).not.toBeNull());

      await act(async () => {
        expect((await registrationRef.current!.executeAction("workspace.compareWithFile"))?.kind)
          .toBe("applied");
      });

      expect(workspaceTestHarness.ipcMocks.selectFilePath).toHaveBeenCalledTimes(1);
      expect(workspaceTestHarness.workspaceMocks.workspaceReadFile.mock.calls.slice(-1)[0]).toEqual([
        "/repo/app",
        "reference.ts",
        expect.any(Number),
      ]);
      const dialog = await screen.findByTestId("code-workspace-compare-dialog");
      expect(dialog).toHaveAttribute("aria-label", 'Compare "reference.ts" ↔ "main.ts"');
      expect(screen.getByTestId("compare-session-metadata")).toHaveTextContent("file");
      expect(screen.getByLabelText("reference.ts comparison side")).toHaveTextContent("UTF-16LE");
      expect(screen.getByTestId("compare-left-line-0")).toHaveTextContent("const value = 2;");
      expect(screen.getByTestId("compare-right-line-0")).toHaveTextContent("const value = 1;");
    });

    it("routes Local History tab action into the same compare dialog", async () => {
      const workspace = compareWorkspace("instance-compare-history-dialog");
      const historyEntry = {
        id: 42,
        path: "/repo/app/src/main.ts",
        contentHash: "snapshot-hash",
        createdAt: 1_788_888_800,
        reason: "save",
        byteLen: 17,
      };
      workspaceTestHarness.workspaceMocks.workspaceReadFile.mockResolvedValue(workspaceTestHarness.file("src/main.ts", "const value = 1;\n"));
      workspaceTestHarness.localHistoryMocks.historyList.mockResolvedValue([historyEntry]);
      workspaceTestHarness.localHistoryMocks.historyRead.mockResolvedValue("const value = 0;\n");

      workspaceTestHarness.renderWorkspace(workspace);
      await findEditorByTitle("app / src/main.ts");
      const tab = document.querySelector<HTMLElement>(
        '[data-editor-tab-key="root:app:src/main.ts"] button[title="app / src/main.ts"]',
      );
      expect(tab).not.toBeNull();
      fireEvent.contextMenu(tab!);
      fireEvent.click(await screen.findByRole("button", { name: /^Local History/ }));

      await screen.findByTestId("code-workspace-local-history-dialog");
      await waitFor(() => expect(workspaceTestHarness.localHistoryMocks.historyRead).toHaveBeenCalledWith(42));
      const compareButton = await screen.findByTestId("code-workspace-local-history-compare");
      expect(compareButton).not.toBeDisabled();
      fireEvent.click(compareButton);

      const dialog = await screen.findByTestId("code-workspace-compare-dialog");
      expect(dialog).toHaveAttribute("aria-label", 'Compare "main.ts @ save #42" ↔ "main.ts"');
      expect(screen.getByTestId("compare-left-line-0")).toHaveTextContent("const value = 0;");
    });

    it("applies a clipboard comparison to a selected range", async () => {
      const workspace = compareWorkspace("instance-compare-selection");
      const initialText = "const one = 1;\nconst two = 2;\n";
      workspaceTestHarness.workspaceMocks.workspaceReadFile.mockResolvedValue(workspaceTestHarness.file("src/main.ts", initialText));
      workspaceTestHarness.clipboardMocks.readTextResult.mockResolvedValue({ ok: true, text: "const two = 3;" });
      const { registrationRef, onCommandsChange } = captureCommands();

      const rendered = workspaceTestHarness.renderWorkspace(workspace, { onCommandsChange });
      await findEditorByTitle("app / src/main.ts");
      const content = rendered.container.querySelector<HTMLElement>(".cm-content");
      const view = EditorView.findFromDOM(content!);
      expect(view).not.toBeNull();
      const selectionStart = initialText.indexOf("const two");
      const selectionEnd = selectionStart + "const two = 2;".length;
      act(() => {
        view!.dispatch({ selection: EditorSelection.range(selectionStart, selectionEnd) });
      });
      await waitFor(() => expect(registrationRef.current).not.toBeNull());

      await act(async () => {
        await registrationRef.current!.executeAction("workspace.compareWithClipboard");
      });
      expect(await screen.findByTestId("compare-right-line-0")).toHaveTextContent("const two = 2;");
      fireEvent.click(screen.getByTestId("compare-apply-left-to-right"));

      await waitFor(() => expect(
        selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "instance-compare-selection")
          .openFiles["root:app:src/main.ts"]?.text,
      ).toBe("const one = 1;\nconst two = 3;\n"));
      expect(screen.queryByTestId("code-workspace-compare-dialog")).not.toBeInTheDocument();
      expect(useAppStore.getState().statusMessage).toContain("undo is available");
    });

    it("keeps the compare dialog and makes no apply effect when the target is stale", async () => {
      const workspace = compareWorkspace("instance-compare-stale");
      workspaceTestHarness.workspaceMocks.workspaceReadFile.mockResolvedValue(workspaceTestHarness.file("src/main.ts", "const value = 1;\n"));
      workspaceTestHarness.clipboardMocks.readTextResult.mockResolvedValue({ ok: true, text: "const value = 2;\n" });
      const { registrationRef, onCommandsChange } = captureCommands();

      const rendered = workspaceTestHarness.renderWorkspace(workspace, { onCommandsChange });
      await findEditorByTitle("app / src/main.ts");
      await waitFor(() => expect(registrationRef.current).not.toBeNull());
      await act(async () => {
        await registrationRef.current!.executeAction("workspace.compareWithClipboard");
      });

      const content = rendered.container.querySelector<HTMLElement>(".cm-content");
      expect(content).not.toBeNull();
      const view = EditorView.findFromDOM(content!);
      act(() => {
        view!.dispatch({
          changes: { from: 0, to: view!.state.doc.length, insert: "const changed = true;\n" },
          userEvent: "input.type",
        });
      });
      await waitFor(() => expect(
        selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "instance-compare-stale")
          .openFiles["root:app:src/main.ts"]?.text,
      ).toBe("const changed = true;\n"));

      fireEvent.click(screen.getByTestId("compare-apply-left-to-right"));
      const error = await screen.findByTestId("compare-apply-error");
      expect(error).toHaveTextContent("Comparison target is stale");
      expect(screen.getByTestId("code-workspace-compare-dialog")).toBeInTheDocument();
      expect(selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "instance-compare-stale")
        .openFiles["root:app:src/main.ts"]?.text).toBe("const changed = true;\n");
    });

    it("asks before replacing dirty text and preserves it when cancelled", async () => {
      const workspace = compareWorkspace("instance-compare-dirty-cancel");
      workspaceTestHarness.workspaceMocks.workspaceReadFile.mockResolvedValue(workspaceTestHarness.file("src/main.ts", "const value = 1;\n"));
      workspaceTestHarness.clipboardMocks.readTextResult.mockResolvedValue({ ok: true, text: "const value = 3;\n" });
      vi.mocked(confirmAppDialog).mockResolvedValueOnce(false);
      const { registrationRef, onCommandsChange } = captureCommands();

      const rendered = workspaceTestHarness.renderWorkspace(workspace, { onCommandsChange });
      await findEditorByTitle("app / src/main.ts");
      const content = rendered.container.querySelector<HTMLElement>(".cm-content");
      expect(content).not.toBeNull();
      const view = EditorView.findFromDOM(content!);
      act(() => {
        view!.dispatch({
          changes: { from: 0, to: view!.state.doc.length, insert: "const dirty = true;\n" },
          userEvent: "input.type",
        });
      });
      await waitFor(() => expect(
        selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "instance-compare-dirty-cancel")
          .openFiles["root:app:src/main.ts"]?.dirty,
      ).toBe(true));
      await waitFor(() => expect(registrationRef.current).not.toBeNull());
      await act(async () => {
        await registrationRef.current!.executeAction("workspace.compareWithClipboard");
      });

      fireEvent.click(screen.getByTestId("compare-apply-left-to-right"));
      await waitFor(() => expect(confirmAppDialog).toHaveBeenCalledWith(expect.objectContaining({
        title: "Apply comparison",
      })));
      expect(screen.getByTestId("code-workspace-compare-dialog")).toBeInTheDocument();
      expect(selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "instance-compare-dirty-cancel")
        .openFiles["root:app:src/main.ts"]?.text).toBe("const dirty = true;\n");
      expect(useAppStore.getState().statusMessage).toContain("unsaved changes were kept");
    });

    it("records one comparison transaction that supports undo and redo", async () => {
      const workspace = compareWorkspace("instance-compare-history");
      workspaceTestHarness.workspaceMocks.workspaceReadFile.mockResolvedValue(workspaceTestHarness.file("src/main.ts", "const value = 1;\n"));
      workspaceTestHarness.clipboardMocks.readTextResult.mockResolvedValue({ ok: true, text: "const value = 2;\n" });
      const { registrationRef, onCommandsChange } = captureCommands();
      const rendered = workspaceTestHarness.renderWorkspace(workspace, { onCommandsChange });
      await findEditorByTitle("app / src/main.ts");
      await waitFor(() => expect(registrationRef.current).not.toBeNull());
      await act(async () => {
        await registrationRef.current!.executeAction("workspace.compareWithClipboard");
      });
      fireEvent.click(screen.getByTestId("compare-apply-left-to-right"));
      await waitFor(() => expect(
        selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "instance-compare-history")
          .openFiles["root:app:src/main.ts"]?.text,
      ).toBe("const value = 2;\n"));

      // ED-AUDIT-008: the journal action is focus-gated off the editor surface
      // (the shared document undo claims the stroke there), so the comparison
      // undo/redo is driven from non-editor focus (window target).
      await waitFor(() => expect(
        registrationRef.current?.items.find((item) => item.id === "workspace.undoWorkspaceEdit")?.enabled,
      ).toBe(false));
      await act(async () => {
        fireEvent.keyDown(window, { key: "z", ctrlKey: true });
      });
      await workspaceTestHarness.confirmWorkspaceUndo();
      await waitFor(() => expect(
        selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "instance-compare-history")
          .openFiles["root:app:src/main.ts"]?.text,
      ).toBe("const value = 1;\n"));

      await act(async () => {
        fireEvent.keyDown(window, { key: "z", ctrlKey: true, shiftKey: true });
      });
      await waitFor(() => expect(
        selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "instance-compare-history")
          .openFiles["root:app:src/main.ts"]?.text,
      ).toBe("const value = 2;\n"));
      expect(rendered.container.querySelector(".cm-content")?.textContent).toContain("const value = 2;");
    });

    it("ED-PARITY-006 Ctrl+Z in Search query does not undo the workspace edit", async () => {
      const workspace = compareWorkspace("instance-parity-006-input-undo");
      workspaceTestHarness.workspaceMocks.workspaceReadFile.mockResolvedValue(workspaceTestHarness.file("src/main.ts", "const value = 1;\n"));
      workspaceTestHarness.clipboardMocks.readTextResult.mockResolvedValue({ ok: true, text: "const value = 2;\n" });
      const { registrationRef, onCommandsChange } = captureCommands();
      workspaceTestHarness.renderWorkspace(workspace, { onCommandsChange });
      await findEditorByTitle("app / src/main.ts");
      await waitFor(() => expect(registrationRef.current).not.toBeNull());
      await act(async () => {
        await registrationRef.current!.executeAction("workspace.compareWithClipboard");
      });
      fireEvent.click(screen.getByTestId("compare-apply-left-to-right"));
      await waitFor(() => expect(
        selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), workspace.workspaceInstanceId!)
          .openFiles["root:app:src/main.ts"]?.text,
      ).toBe("const value = 2;\n"));

      await act(async () => {
        await registrationRef.current!.executeAction("workspace.findInFiles");
      });
      const query = await screen.findByLabelText("Search query");
      query.focus();
      fireEvent.keyDown(query, { key: "z", code: "KeyZ", ctrlKey: true });

      expect(selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), workspace.workspaceInstanceId!)
        .openFiles["root:app:src/main.ts"]?.text).toBe("const value = 2;\n");
    });
  });
}
