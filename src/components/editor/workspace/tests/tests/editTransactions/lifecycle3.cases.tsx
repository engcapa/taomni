import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import * as workspaceSearchModule from "../../../../../../lib/editor/workspaceSearch";
import { useAppStore } from "../../../../../../stores/appStore";
import { useCodeWorkspaceStore } from "../../../../../../stores/codeWorkspaceStore";
import type { CodeWorkspaceTabInfo } from "../../../../../../types";
import type { WorkspaceCommandRegistration } from "../../../workspaceCommands";
import { type registerWorkspaceEditsCasesFixture } from "../../workspaceEdits.cases";

export interface registereditTransactionsLifecycle3CasesContext {
  workspaceTestHarness: registerWorkspaceEditsCasesFixture;
}

export function registereditTransactionsLifecycle3Cases(caseContext: registereditTransactionsLifecycle3CasesContext) {
  describe("ED-REPAIR-002: replace preflight and open buffer freeze conditions (mounted)", () => {
    function setupWorkspace(instanceId: string, openFile: string) {
      const disk: Record<string, string> = {};
      const workspace: CodeWorkspaceTabInfo = {
        repoRoot: "/repo/app",
        workspaceId: `ws-${instanceId}`,
        workspaceInstanceId: `instance-${instanceId}`,
        name: instanceId,
        roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
        looseFiles: [],
        initialFile: { kind: "root", rootId: "app", path: openFile },
      };
      caseContext.workspaceTestHarness.workspaceMocks.workspaceListDir.mockImplementation(async (_root: string, path: string) => (
        path === "src"
          ? Object.keys(disk).map((rel) => caseContext.workspaceTestHarness.entry(rel.split("/").pop()!, rel))
          : [caseContext.workspaceTestHarness.entry("src", "src", "dir")]
      ));
      caseContext.workspaceTestHarness.workspaceMocks.workspaceReadFile.mockImplementation(async (_root: string, path: string) => {
        if (!(path in disk)) throw new Error(`missing fixture file: ${path}`);
        return caseContext.workspaceTestHarness.file(path, disk[path]!, { hash: `hash-${disk[path]!}` });
      });
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
      return { disk, workspace, registrationRef, onCommandsChange };
    }

    it.each(["disk-before", "open-during-final-read", "open-during-history-read", "excluded"])("validates exactly the selected replace set before the first effect: %s (ED-REPAIR-002-A1)", async (scenario) => {
      const { disk, workspace, registrationRef, onCommandsChange } = setupWorkspace("repair-002-b-modified", "src/c.ts");
      disk["src/c.ts"] = "hello reader";
      disk["src/a.ts"] = "hello needle";
      disk["src/b.ts"] = "hello needle";

      let searchHandler: ((event: workspaceSearchModule.WorkspaceSearchEvent) => void) | null = null;
      const unlisten = vi.fn();
      vi.spyOn(workspaceSearchModule, "subscribeWorkspaceSearch").mockImplementation(async (_id, handler) => {
        searchHandler = handler;
        return unlisten;
      });
      vi.spyOn(workspaceSearchModule, "workspaceSearchStart").mockResolvedValue("search-repair-002");

      caseContext.workspaceTestHarness.renderWorkspace(workspace, { onCommandsChange });
      await screen.findByTitle("app / src/c.ts");

      // Open find in files panel
      await act(async () => {
        await registrationRef.current?.executeAction("workspace.findInFiles");
      });

      const searchInput = await screen.findByLabelText("Search query");
      fireEvent.change(searchInput, { target: { value: "needle" } });
      fireEvent.keyDown(searchInput, { key: "Enter" });

      await waitFor(() => expect(searchHandler).not.toBeNull());

      // Emit search matches for a.ts and b.ts
      await act(async () => {
        searchHandler?.({
          searchId: "search-repair-002",
          kind: "batch",
          matches: [
            {
              rootId: "app",
              rootName: "app",
              rootPath: "/repo/app",
              path: "src/a.ts",
              lineNumber: 1,
              column: 7,
              matchStart: 6,
              matchEnd: 12,
              lineText: "hello needle",
            },
            {
              rootId: "app",
              rootName: "app",
              rootPath: "/repo/app",
              path: "src/b.ts",
              lineNumber: 1,
              column: 7,
              matchStart: 6,
              matchEnd: 12,
              lineText: "hello needle",
            },
          ],
          truncated: false,
          cancelled: false,
          filesScanned: 2,
          totalMatches: 2,
          error: null,
        });
        searchHandler?.({
          searchId: "search-repair-002",
          kind: "done",
          matches: [],
          truncated: false,
          cancelled: false,
          filesScanned: 2,
          totalMatches: 2,
          error: null,
        });
      });

      // Enter replace text and preview
      fireEvent.change(screen.getByLabelText("Replace text"), { target: { value: "REPLACED" } });
      fireEvent.click(screen.getByRole("button", { name: "Preview replace all matches" }));

      const preview = await screen.findByTestId("code-workspace-replace-preview");
      expect(preview).toBeInTheDocument();

      if (scenario.startsWith("open-during")) {
        let readsOfB = 0;
        let readsOfA = 0;
        caseContext.workspaceTestHarness.workspaceMocks.workspaceReadFile.mockImplementation(async (_root: string, path: string) => {
          // Commit reads B for outer validation, recovery snapshot, then final preflight.
          // A is read again by the applier (4) and the local-history committer (5).
          if (path === "src/b.ts") readsOfB += 1;
          if (path === "src/a.ts") readsOfA += 1;
          if ((scenario === "open-during-final-read" && path === "src/b.ts" && readsOfB === 3)
            || (scenario === "open-during-history-read" && path === "src/a.ts" && readsOfA === 5)) {
            useCodeWorkspaceStore.getState().updateOpenFiles(workspace.workspaceInstanceId!, (current) => ({
              ...current,
              "root:app:src/b.ts": {
                ...current["root:app:src/c.ts"]!, key: "root:app:src/b.ts", path: "src/b.ts",
                ref: { kind: "root", rootId: "app", path: "src/b.ts" },
                text: "hello user typing", savedText: "hello needle", dirty: true, documentRevision: 1
              },
            }));
            await new Promise((resolve) => setTimeout(resolve, 0));
          }
          return caseContext.workspaceTestHarness.file(path, disk[path]!, { hash: `hash-${disk[path]!}` });
        });
      } else {
        if (scenario === "excluded") {
          fireEvent.click(within(preview).getByLabelText("Include all matches in /repo/app/src/b.ts"));
        }
        disk["src/b.ts"] = "hello modified";
      }

      // Click Replace All
      fireEvent.click(screen.getByTestId("code-workspace-replace-commit"));

      if (scenario === "excluded") {
        await waitFor(() => expect(disk["src/a.ts"]).toBe("hello REPLACED"));
        expect(disk["src/b.ts"]).toBe("hello modified");
        await waitFor(() => expect(registrationRef.current?.items.find((item) => item.id === "workspace.undoWorkspaceEdit")?.enabled).toBe(true));
        await act(async () => { await registrationRef.current?.executeAction("workspace.undoWorkspaceEdit"); });
        fireEvent.click(await screen.findByTestId("code-workspace-undo-confirm-ok"));
        await waitFor(() => expect(disk["src/a.ts"]).toBe("hello needle"));
        expect(disk["src/b.ts"]).toBe("hello modified");
        return;
      }

      // Preflight detects disk hash mismatch on src/b.ts and refuses with zero writes
      await waitFor(() => {
        const status = useAppStore.getState().statusMessage;
        expect(status).toMatch(scenario === "disk-before" ? /changed on disk since/ : /opened since replace preview|unsaved modifications/);
      });

      // Both files must have ZERO writes applied
      expect(disk["src/a.ts"]).toBe("hello needle");
      expect(disk["src/b.ts"]).toBe(scenario === "disk-before" ? "hello modified" : "hello needle");
      expect(caseContext.workspaceTestHarness.workspaceMocks.workspaceWriteFileEncoded).not.toHaveBeenCalled();
    });

    it("preserves file A effect when file B write fails after first write (ED-REPAIR-002-A2)", async () => {
      const { disk, workspace, registrationRef, onCommandsChange } = setupWorkspace("repair-002-b-fail", "src/c.ts");
      disk["src/c.ts"] = "hello reader";
      disk["src/a.ts"] = "hello needle";
      disk["src/b.ts"] = "hello needle";

      let searchHandler: ((event: workspaceSearchModule.WorkspaceSearchEvent) => void) | null = null;
      const unlisten = vi.fn();
      vi.spyOn(workspaceSearchModule, "subscribeWorkspaceSearch").mockImplementation(async (_id, handler) => {
        searchHandler = handler;
        return unlisten;
      });
      vi.spyOn(workspaceSearchModule, "workspaceSearchStart").mockResolvedValue("search-repair-002-post");

      // Inject write failure on src/b.ts
      caseContext.workspaceTestHarness.workspaceMocks.workspaceWriteFileEncoded.mockImplementation(async (
        _root: string,
        path: string,
        text: string,
      ) => {
        if (path === "src/b.ts") {
          throw new Error("disk I/O error on b.ts");
        }
        disk[path] = text;
        return caseContext.workspaceTestHarness.writeAck(caseContext.workspaceTestHarness.file(path, text, { hash: `hash-${text}` }));
      });

      caseContext.workspaceTestHarness.renderWorkspace(workspace, { onCommandsChange });
      await screen.findByTitle("app / src/c.ts");

      await act(async () => {
        await registrationRef.current?.executeAction("workspace.findInFiles");
      });

      const searchInput = await screen.findByLabelText("Search query");
      fireEvent.change(searchInput, { target: { value: "needle" } });
      fireEvent.keyDown(searchInput, { key: "Enter" });

      await waitFor(() => expect(searchHandler).not.toBeNull());

      await act(async () => {
        searchHandler?.({
          searchId: "search-repair-002-post",
          kind: "batch",
          matches: [
            {
              rootId: "app",
              rootName: "app",
              rootPath: "/repo/app",
              path: "src/a.ts",
              lineNumber: 1,
              column: 7,
              matchStart: 6,
              matchEnd: 12,
              lineText: "hello needle",
            },
            {
              rootId: "app",
              rootName: "app",
              rootPath: "/repo/app",
              path: "src/b.ts",
              lineNumber: 1,
              column: 7,
              matchStart: 6,
              matchEnd: 12,
              lineText: "hello needle",
            },
          ],
          truncated: false,
          cancelled: false,
          filesScanned: 2,
          totalMatches: 2,
          error: null,
        });
        searchHandler?.({
          searchId: "search-repair-002-post",
          kind: "done",
          matches: [],
          truncated: false,
          cancelled: false,
          filesScanned: 2,
          totalMatches: 2,
          error: null,
        });
      });

      fireEvent.change(screen.getByLabelText("Replace text"), { target: { value: "REPLACED" } });
      fireEvent.click(screen.getByRole("button", { name: "Preview replace all matches" }));

      const preview = await screen.findByTestId("code-workspace-replace-preview");
      expect(preview).toBeInTheDocument();

      fireEvent.click(screen.getByTestId("code-workspace-replace-commit"));

      // Operation A succeeded and its effect is preserved on disk!
      await waitFor(() => expect(disk["src/a.ts"]).toBe("hello REPLACED"));
      // Operation B failed and was not modified
      expect(disk["src/b.ts"]).toBe("hello needle");

      // Status message indicates failure / recovery required
      await waitFor(() => {
        const status = useAppStore.getState().statusMessage;
        expect(status).toContain("recovery required");
      });
    });
  });
}
