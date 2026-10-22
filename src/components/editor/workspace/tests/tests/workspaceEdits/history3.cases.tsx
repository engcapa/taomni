import { emit, type UnlistenFn } from "@tauri-apps/api/event";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import * as workspaceSearchModule from "../../../../../../lib/editor/workspaceSearch";
import { useAppStore } from "../../../../../../stores/appStore";
import type { CodeWorkspaceTabInfo } from "../../../../../../types";
import type { WorkspaceCommandRegistration } from "../../../workspaceCommands";
import { type registerWorkspaceEditsCasesFixture } from "../../workspaceEdits.cases";

export interface registerworkspaceEditsHistory3CasesContext {
  workspaceTestHarness: registerWorkspaceEditsCasesFixture;
}

export function registerworkspaceEditsHistory3Cases(caseContext: registerworkspaceEditsHistory3CasesContext) {
  describe("ED-PARITY-006: workspace edit undo routing", () => {
    function parityWorkspace(instanceId: string): CodeWorkspaceTabInfo {
      return {
        repoRoot: "/repo/app",
        workspaceId: `ws-${instanceId}`,
        workspaceInstanceId: instanceId,
        name: "Parity 006",
        roots: [{ id: "app", name: "app", path: "/repo/app", kind: "folder" }],
        looseFiles: [],
        initialFile: { kind: "root", rootId: "app", path: "src/a.txt" },
      };
    }

    async function mountReplaceHistoryAndSearch(instanceId: string) {
      const disk: Record<string, string> = {
        "src/a.txt": "alpha token\n",
        "src/b.txt": "beta token\n",
      };
      const workspace = parityWorkspace(instanceId);
      caseContext.workspaceTestHarness.workspaceMocks.workspaceListDir.mockImplementation(async (_root: string, path: string) => (
        path === "src"
          ? Object.keys(disk).map((relative) => caseContext.workspaceTestHarness.entry(relative.split("/").pop()!, relative))
          : [caseContext.workspaceTestHarness.entry("src", "src", "dir")]
      ));
      caseContext.workspaceTestHarness.workspaceMocks.workspaceReadFile.mockImplementation(async (_root: string, path: string) => (
        caseContext.workspaceTestHarness.file(path, disk[path] ?? "", { hash: `hash-${disk[path] ?? ""}` })
      ));
      caseContext.workspaceTestHarness.workspaceMocks.workspaceReadFileWithEncoding.mockImplementation(async (_root: string, path: string) => (
        caseContext.workspaceTestHarness.file(path, disk[path] ?? "", { hash: `hash-${disk[path] ?? ""}` })
      ));
      caseContext.workspaceTestHarness.workspaceMocks.workspaceWriteFileEncoded.mockImplementation(async (
        _root: string,
        path: string,
        text: string,
      ) => {
        disk[path] = text;
        return caseContext.workspaceTestHarness.writeAck(caseContext.workspaceTestHarness.file(path, text, { hash: `hash-${text}` }));
      });

      const registrationRef: { current: WorkspaceCommandRegistration | null; } = { current: null };
      const onCommandsChange = vi.fn((_tabId: string, next: WorkspaceCommandRegistration | null) => {
        if (next) registrationRef.current = next;
      });
      let searchHandler: ((event: workspaceSearchModule.WorkspaceSearchEvent) => void) | null = null;
      vi.spyOn(workspaceSearchModule, "subscribeWorkspaceSearch").mockImplementation(async (_id, handler): Promise<UnlistenFn> => {
        searchHandler = handler;
        return () => undefined;
      });
      vi.spyOn(workspaceSearchModule, "workspaceSearchStart").mockResolvedValue("search-parity-006");

      caseContext.workspaceTestHarness.renderWorkspace(workspace, { onCommandsChange });
      await screen.findByTitle("app / src/a.txt");
      await act(async () => {
        await emit("lsp://workspace-apply-edit", {
          requestId: `parity-006-${instanceId}`,
          workspaceId: workspace.workspaceInstanceId,
          label: "Replace in files",
          edit: {
            documentEdits: [
              {
                uri: "file:///repo/app/src/a.txt",
                path: "/repo/app/src/a.txt",
                edits: [{ range: { start: { line: 0, character: 6 }, end: { line: 0, character: 11 } }, newText: "coin" }],
              },
              {
                uri: "file:///repo/app/src/b.txt",
                path: "/repo/app/src/b.txt",
                edits: [{ range: { start: { line: 0, character: 5 }, end: { line: 0, character: 10 } }, newText: "coin" }],
              },
            ],
          },
        });
      });
      const editPreview = await screen.findByTestId("refactoring-preview-dialog");
      fireEvent.click(within(editPreview).getByTestId("refactoring-preview-apply"));
      await waitFor(() => {
        expect(disk["src/a.txt"]).toBe("alpha coin\n");
        expect(disk["src/b.txt"]).toBe("beta coin\n");
      });

      await act(async () => {
        await registrationRef.current?.executeAction("workspace.findInFiles");
      });
      const query = await screen.findByLabelText("Search query");
      fireEvent.change(query, { target: { value: "coin" } });
      fireEvent.keyDown(query, { key: "Enter" });
      await waitFor(() => expect(searchHandler).not.toBeNull());
      await act(async () => {
        searchHandler?.({
          searchId: "search-parity-006",
          kind: "batch",
          matches: [{
            rootId: "scope-0",
            rootName: "src",
            rootPath: "/repo/app/src",
            path: "a.txt",
            lineNumber: 1,
            column: 7,
            matchStart: 6,
            matchEnd: 10,
            lineText: "alpha coin",
          }],
          truncated: false,
          cancelled: false,
          filesScanned: 2,
          totalMatches: 1,
          error: null,
        });
        searchHandler?.({
          searchId: "search-parity-006",
          kind: "done",
          matches: [],
          truncated: false,
          cancelled: false,
          filesScanned: 2,
          totalMatches: 1,
          error: null,
        });
      });
      return { disk, workspace, registrationRef };
    }

    it("ED-PARITY-006 Ctrl+Z on a result row asks before undoing", async () => {
      const { disk } = await mountReplaceHistoryAndSearch("instance-parity-006-row-confirm");
      const row = await screen.findByTestId("code-workspace-find-match-row");
      row.focus();
      fireEvent.keyDown(row, { key: "z", code: "KeyZ", ctrlKey: true });
      const dialog = await screen.findByTestId("code-workspace-undo-confirm");
      expect(dialog).toHaveTextContent("Undo Replace in files?");
      await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId("code-workspace-undo-confirm-ok")));
      expect(disk["src/a.txt"]).toBe("alpha coin\n");
    });

    it("ED-PARITY-006 traps Undo confirmation keys and restores its result-row entry", async () => {
      const { disk } = await mountReplaceHistoryAndSearch("instance-parity-006-undo-focus");
      const row = await screen.findByTestId("code-workspace-find-match-row");
      row.focus();
      fireEvent.keyDown(row, { key: "z", code: "KeyZ", ctrlKey: true });
      const dialog = await screen.findByRole("dialog", { name: "Undo" });
      expect(dialog).toHaveAttribute("aria-modal", "true");
      const ok = within(dialog).getByRole("button", { name: "OK" });
      const cancel = within(dialog).getByRole("button", { name: "Cancel" });
      await waitFor(() => expect(document.activeElement).toBe(ok));

      fireEvent.keyDown(ok, { key: "Tab" });
      expect(document.activeElement).toBe(cancel);
      fireEvent.keyDown(cancel, { key: "Tab" });
      expect(document.activeElement).toBe(ok);
      fireEvent.keyDown(ok, { key: "Tab", shiftKey: true });
      expect(document.activeElement).toBe(cancel);
      fireEvent.keyDown(cancel, { key: "Tab", shiftKey: true });
      expect(document.activeElement).toBe(ok);

      fireEvent.keyDown(ok, { key: "Enter" });
      expect(screen.queryByTestId("code-workspace-undo-confirm")).not.toBeInTheDocument();
      await waitFor(() => expect(document.activeElement).toBe(row));
      await waitFor(() => {
        expect(disk["src/a.txt"]).toBe("alpha token\n");
        expect(disk["src/b.txt"]).toBe("beta token\n");
      });
      expect(caseContext.workspaceTestHarness.workspaceMocks.workspaceWriteFileEncoded).toHaveBeenCalledTimes(4);
    });

    it("ED-PARITY-006 Cancel and Escape leave history untouched, then OK undoes both files once", async () => {
      const { disk } = await mountReplaceHistoryAndSearch("instance-parity-006-cancel-ok");
      const row = await screen.findByTestId("code-workspace-find-match-row");
      row.focus();
      fireEvent.keyDown(row, { key: "z", ctrlKey: true });
      fireEvent.click(await screen.findByTestId("code-workspace-undo-confirm-cancel"));
      await waitFor(() => expect(document.activeElement).toBe(row));
      expect(disk["src/a.txt"]).toBe("alpha coin\n");
      expect(caseContext.workspaceTestHarness.workspaceMocks.workspaceWriteFileEncoded).toHaveBeenCalledTimes(2);

      fireEvent.keyDown(row, { key: "z", ctrlKey: true });
      await screen.findByTestId("code-workspace-undo-confirm");
      await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId("code-workspace-undo-confirm-ok")));
      fireEvent.keyDown(document.activeElement!, { key: "Escape" });
      expect(screen.queryByTestId("code-workspace-undo-confirm")).not.toBeInTheDocument();
      await waitFor(() => expect(document.activeElement).toBe(row));
      expect(disk["src/b.txt"]).toBe("beta coin\n");
      expect(caseContext.workspaceTestHarness.workspaceMocks.workspaceWriteFileEncoded).toHaveBeenCalledTimes(2);

      fireEvent.keyDown(row, { key: "z", ctrlKey: true });
      fireEvent.click(await screen.findByTestId("code-workspace-undo-confirm-ok"));
      await waitFor(() => {
        expect(disk["src/a.txt"]).toBe("alpha token\n");
        expect(disk["src/b.txt"]).toBe("beta token\n");
      });
      expect(useAppStore.getState().statusMessage).toContain("Undid Replace in files (2 files)");
    });

    it("ED-PARITY-006 editor Ctrl+Z still claims the journal without a prompt", async () => {
      const { disk } = await mountReplaceHistoryAndSearch("instance-parity-006-editor-undo");
      const content = document.querySelector<HTMLElement>(".cm-content");
      expect(content).not.toBeNull();
      content!.focus();
      fireEvent.keyDown(content!, { key: "z", code: "KeyZ", ctrlKey: true });
      await waitFor(() => expect(disk["src/a.txt"]).toBe("alpha token\n"));
      expect(screen.queryByTestId("code-workspace-undo-confirm")).not.toBeInTheDocument();
    });

    it("ED-PARITY-006 Actions exposes workspace Undo with an active editor and asks for confirmation", async () => {
      const { disk } = await mountReplaceHistoryAndSearch("instance-parity-006-actions-undo");
      const row = await screen.findByTestId("code-workspace-find-match-row");
      row.focus();
      fireEvent.keyDown(row, { key: "n", code: "KeyN", ctrlKey: true, shiftKey: true });
      const popup = await screen.findByTestId("code-workspace-search-everywhere");
      fireEvent.click(within(popup).getByRole("tab", { name: "Actions" }));
      fireEvent.change(within(popup).getByLabelText("Search actions"), { target: { value: "Undo Replace in files" } });
      fireEvent.click(await within(popup).findByText("Undo Replace in files"));
      expect(await screen.findByTestId("code-workspace-undo-confirm", {}, { timeout: 5_000 })).toHaveTextContent("Undo Replace in files?");
      expect(disk["src/a.txt"]).toBe("alpha coin\n");
      fireEvent.click(screen.getByTestId("code-workspace-undo-confirm-ok"));
      await waitFor(() => {
        expect(disk["src/a.txt"]).toBe("alpha token\n");
        expect(disk["src/b.txt"]).toBe("beta token\n");
      });
    });

    it("ED-PARITY-006 Replace in Files action focuses Replace text", async () => {
      const { registrationRef } = await mountReplaceHistoryAndSearch("instance-parity-006-replace-focus");
      await waitFor(() => expect(registrationRef.current).not.toBeNull());
      await act(async () => {
        await registrationRef.current?.executeAction("workspace.replaceInFiles");
      });
      const replacement = screen.getByLabelText("Replace text");
      await waitFor(() => expect(document.activeElement).toBe(replacement));
      expect(document.activeElement).toBe(replacement);
    });
  });
}
