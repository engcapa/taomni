import { emit } from "@tauri-apps/api/event";
import { act, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { confirmAppDialog } from "../../../../../../lib/appDialogs";
import { useAppStore } from "../../../../../../stores/appStore";
import { selectCodeWorkspaceUi, useCodeWorkspaceStore } from "../../../../../../stores/codeWorkspaceStore";
import type { CodeWorkspaceTabInfo } from "../../../../../../types";
import type { WorkspaceCommandRegistration } from "../../../workspaceCommands";
import { type registerWorkspaceEditsCasesFixture } from "../../workspaceEdits.cases";

export interface registerworkspaceEditsLifecycle4CasesContext {
  workspaceTestHarness: registerWorkspaceEditsCasesFixture;
}

export function registerworkspaceEditsLifecycle4Cases(caseContext: registerworkspaceEditsLifecycle4CasesContext) {
  describe("ED-IMPROVE-001 preview-window identity guard (mounted, model boundary)", () => {
    const SERVICE_PRE = "package com.example;\n\npublic class Service {\n    public void beta() {}\n    public void alpha() {}\n}\n";
    const SERVICE_RELOADED = "package com.example;\n\npublic class Service {\n    public void gamma() {}\n    public void alpha() {}\n}\n";
    const SWAP_EDIT = {
      range: { start: { line: 3, character: 0 }, end: { line: 4, character: 26 } },
      newText: "    public void alpha() {}\n    public void beta() {}",
    };

    function stalePreviewWorkspace(instance: string): CodeWorkspaceTabInfo {
      return {
        repoRoot: "/repo/app",
        workspaceId: "ws-improve001",
        workspaceInstanceId: instance,
        name: "Improve 001",
        roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
        looseFiles: [],
        initialFile: { kind: "root", rootId: "app", path: "src/Service.java" },
      };
    }

    function fileText(instance: string): string | undefined {
      return selectCodeWorkspaceUi(
        useCodeWorkspaceStore.getState(),
        instance,
      ).openFiles["root:app:src/Service.java"]?.text;
    }

    function mockProvider() {
      caseContext.workspaceTestHarness.workspaceMocks.workspaceListDir.mockResolvedValue([caseContext.workspaceTestHarness.entry("src", "src", "dir")]);
      caseContext.workspaceTestHarness.workspaceMocks.workspaceWriteFileEncoded.mockImplementation(async (
        _rootPath: string,
        path: string,
        text: string,
      ) => caseContext.workspaceTestHarness.writeAck(caseContext.workspaceTestHarness.file(path, text, { hash: `hash-${text}` })));
      caseContext.workspaceTestHarness.lspMocks.lspOpenDocument.mockResolvedValue(caseContext.workspaceTestHarness.documentStatus({
        path: "/repo/app/src/Service.java",
        uri: "file:///repo/app/src/Service.java",
        presetId: "jdtls",
        languageId: "java",
        displayName: "Eclipse JDT Language Server",
        available: true,
        active: true,
        capabilities: caseContext.workspaceTestHarness.defaultCapabilities({ codeAction: true, codeActionKinds: ["source.rearrange"] }),
      }));
      const rearrangeAction = {
        title: "Rearrange members",
        kind: "source.rearrange",
        isPreferred: true,
        edit: null,
        command: null,
        commandArguments: null,
        raw: { title: "Rearrange members" },
      };
      caseContext.workspaceTestHarness.lspMocks.lspCodeActions.mockResolvedValue({
        status: caseContext.workspaceTestHarness.documentStatus({ available: true, active: true }),
        actions: [rearrangeAction],
      });
      caseContext.workspaceTestHarness.lspMocks.lspCodeActionResolve.mockResolvedValue({
        status: caseContext.workspaceTestHarness.documentStatus({ available: true, active: true }),
        action: {
          ...rearrangeAction,
          edit: {
            documentEdits: [{
              uri: "file:///repo/app/src/Service.java",
              path: "/repo/app/src/Service.java",
              edits: [SWAP_EDIT],
            }],
          },
        },
      });
    }

    it("refuses the plan when the document changed while the preview was open", async () => {
      caseContext.workspaceTestHarness.runtimeState.tauri = true;
      const registrationRef: { current: WorkspaceCommandRegistration | null; } = { current: null };
      const onCommandsChange = vi.fn((_tabId: string, next: WorkspaceCommandRegistration | null) => {
        if (next) registrationRef.current = next;
      });
      mockProvider();
      let disk = caseContext.workspaceTestHarness.file("src/Service.java", SERVICE_PRE, { hash: "hash-pre" });
      caseContext.workspaceTestHarness.workspaceMocks.workspaceReadFile.mockImplementation(async () => disk);
      vi.mocked(confirmAppDialog).mockClear();
      vi.mocked(confirmAppDialog).mockImplementation(async () => {
        // A real external process writes the file while the preview dialog is
        // open; the watcher reloads the clean buffer before the user confirms.
        disk = caseContext.workspaceTestHarness.file("src/Service.java", SERVICE_RELOADED, { hash: "hash-reloaded" });
        await emit("lsp://external-file-change", {
          workspaceId: "instance-improve001-stale",
          path: "/repo/app/src/Service.java",
          type: 2,
        });
        // The watcher coalesces events for EXTERNAL_FILE_EVENT_SETTLE_MS
        // before reloading the clean buffer; give the real debounce time to
        // land so the confirmation truly races a changed document.
        await new Promise((resolve) => setTimeout(resolve, 240));
        return true;
      });

      caseContext.workspaceTestHarness.renderWorkspace(stalePreviewWorkspace("instance-improve001-stale"), { onCommandsChange });
      await screen.findByTitle("app / src/Service.java");
      await waitFor(() => expect(screen.queryByText("LSP idle")).not.toBeInTheDocument());

      await act(async () => {
        await registrationRef.current?.executeAction("workspace.rearrangeCode");
      });
      await waitFor(() => expect(useAppStore.getState().statusMessage).toContain(
        "changed since the frozen preimage",
      ));
      expect(fileText("instance-improve001-stale")).toBe(SERVICE_RELOADED);
      expect(caseContext.workspaceTestHarness.workspaceMocks.workspaceWriteFileEncoded).not.toHaveBeenCalled();
    });
  });
}
