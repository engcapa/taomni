import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { confirmAppDialog } from "../../../../lib/appDialogs";
import { useAppStore } from "../../../../stores/appStore";
import { selectCodeWorkspaceUi, useCodeWorkspaceStore } from "../../../../stores/codeWorkspaceStore";
import type { CodeWorkspaceTabInfo } from "../../../../types";
import type { WorkspaceCommandRegistration } from "../workspaceCommands";
import { type registerSaveCasesFixture } from "./save.cases";

export function registerSaveRetryCases(workspaceTestHarness: registerSaveCasesFixture) {
describe("ED-REPAIR-001: workspace edit save failure retry safety (mounted)", () => {
    const SERVICE_PRE = "package com.example;\n\npublic class Service {\n    public void beta() {}\n    public void alpha() {}\n}\n";
    const SERVICE_POST = "package com.example;\n\npublic class Service {\n    public void alpha() {}\n    public void beta() {}\n}\n";
    const SWAP_EDIT = {
      range: { start: { line: 3, character: 0 }, end: { line: 4, character: 26 } },
      newText: "    public void alpha() {}\n    public void beta() {}",
    };
    const RECOVERY_V2_PREFIX = "taomni.refactor.recovery.v2:";
    const OPEN_KEY = "root:app:src/Service.java";

    function repairWorkspace(instance: string): CodeWorkspaceTabInfo {
      return {
        repoRoot: "/repo/app",
        workspaceId: "ws-repair001",
        workspaceInstanceId: instance,
        name: "Repair 001",
        roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
        looseFiles: [],
        initialFile: { kind: "root", rootId: "app", path: "src/Service.java" },
      };
    }

    function fileText(instance: string): string | undefined {
      return selectCodeWorkspaceUi(
        useCodeWorkspaceStore.getState(),
        instance,
      ).openFiles[OPEN_KEY]?.text;
    }

    function mockWorkflowProvider(kind: "source.rearrange" | "source.cleanup" = "source.rearrange") {
      workspaceTestHarness.workspaceMocks.workspaceListDir.mockResolvedValue([workspaceTestHarness.entry("src", "src", "dir")]);
      workspaceTestHarness.workspaceMocks.workspaceReadFile.mockResolvedValue(workspaceTestHarness.file("src/Service.java", SERVICE_PRE, { hash: "hash-pre" }));
      workspaceTestHarness.workspaceMocks.workspaceWriteFileEncoded.mockImplementation(async (
        _rootPath: string,
        path: string,
        text: string,
      ) => workspaceTestHarness.writeAck(workspaceTestHarness.file(path, text, { hash: `hash-${text}` })));
      workspaceTestHarness.lspMocks.lspOpenDocument.mockResolvedValue(workspaceTestHarness.documentStatus({
        path: "/repo/app/src/Service.java",
        uri: "file:///repo/app/src/Service.java",
        presetId: "jdtls",
        languageId: "java",
        displayName: "Eclipse JDT Language Server",
        available: true,
        active: true,
        capabilities: workspaceTestHarness.defaultCapabilities({ codeAction: true, codeActionKinds: [kind] }),
      }));
      const action = {
        title: kind === "source.rearrange" ? "Rearrange members" : "Clean up",
        kind,
        isPreferred: true,
        edit: null,
        command: null,
        commandArguments: null,
        raw: { title: kind },
      };
      workspaceTestHarness.lspMocks.lspCodeActions.mockResolvedValue({
        status: workspaceTestHarness.documentStatus({ available: true, active: true }),
        actions: [action],
      });
      workspaceTestHarness.lspMocks.lspCodeActionResolve.mockResolvedValue({
        status: workspaceTestHarness.documentStatus({ available: true, active: true }),
        action: {
          ...action,
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

    function storedJournals(): Array<{ key: string; entry: { status: string } }> {
      return Object.keys(window.localStorage)
        .filter((key) => key.startsWith(RECOVERY_V2_PREFIX))
        .map((key) => ({ key, entry: JSON.parse(window.localStorage.getItem(key)!) }));
    }

    async function runWorkflow(
      registrationRef: { current: WorkspaceCommandRegistration | null },
      commandId: string,
    ): Promise<void> {
      await act(async () => {
        await registrationRef.current?.executeAction(commandId);
      });
    }

    it("retries save without duplicating buffer edits when save fails known-zero and user confirms retry (ED-REPAIR-001-A1, A2)", async () => {
      const registrationRef: { current: WorkspaceCommandRegistration | null } = { current: null };
      const onCommandsChange = vi.fn((_tabId: string, next: WorkspaceCommandRegistration | null) => {
        if (next) registrationRef.current = next;
      });
      mockWorkflowProvider("source.rearrange");
      let writeAttempts = 0;
      workspaceTestHarness.workspaceMocks.workspaceWriteFileEncoded.mockImplementation(async (
        _rootPath: string,
        path: string,
        text: string,
      ) => {
        writeAttempts += 1;
        if (writeAttempts === 1) {
          throw Object.assign(new Error("disk locked"), { kind: "io", effect: "none" });
        }
        return workspaceTestHarness.writeAck(workspaceTestHarness.file(path, text, { hash: `hash-${text}` }));
      });
      vi.mocked(confirmAppDialog).mockClear();
      vi.mocked(confirmAppDialog).mockImplementation(async (opts) => {
        if (opts.title === "Rearrange preview") return true;
        if (opts.title === "Workspace edit save failed") return true;
        return false;
      });

      workspaceTestHarness.renderWorkspace(repairWorkspace("instance-repair001-retry-success"), { onCommandsChange });
      await screen.findByTitle("app / src/Service.java");
      await waitFor(() => expect(screen.queryByText("LSP idle")).not.toBeInTheDocument());

      await runWorkflow(registrationRef, "workspace.rearrangeCode");
      // The buffer has the applied text, NOT duplicated
      await waitFor(() => expect(fileText("instance-repair001-retry-success")).toBe(SERVICE_POST));
      await waitFor(() => expect(useAppStore.getState().statusMessage).toContain("Rearranged Service.java"));
      expect(writeAttempts).toBe(2);

      // Verify single history entry undo/redo
      const pane = screen.getByTestId("code-workspace-editor-pane");
      fireEvent.keyDown(pane, { key: "z", ctrlKey: true });
      await waitFor(() => expect(useAppStore.getState().statusMessage).toContain("Undid Rearrange Code"));
      expect(fileText("instance-repair001-retry-success")).toBe(SERVICE_PRE);

      // Redo restores to clean post-text
      fireEvent.keyDown(pane, { key: "z", ctrlKey: true, shiftKey: true });
      await waitFor(() => expect(useAppStore.getState().statusMessage).toContain("Redid Rearrange Code"));
      expect(fileText("instance-repair001-retry-success")).toBe(SERVICE_POST);
    });

    it("preserves mutated buffer and marks journal recovery-required when save retry is cancelled (ED-REPAIR-001-A1, A2)", async () => {
      const registrationRef: { current: WorkspaceCommandRegistration | null } = { current: null };
      const onCommandsChange = vi.fn((_tabId: string, next: WorkspaceCommandRegistration | null) => {
        if (next) registrationRef.current = next;
      });
      mockWorkflowProvider("source.rearrange");
      workspaceTestHarness.workspaceMocks.workspaceWriteFileEncoded.mockRejectedValue(Object.assign(
        new Error("disk locked permanently"),
        { kind: "io", effect: "none" },
      ));
      vi.mocked(confirmAppDialog).mockClear();
      vi.mocked(confirmAppDialog).mockImplementation(async (opts) => {
        if (opts.title === "Rearrange preview") return true;
        // User cancels retry
        if (opts.title === "Workspace edit save failed") return false;
        return false;
      });

      workspaceTestHarness.renderWorkspace(repairWorkspace("instance-repair001-retry-cancel"), { onCommandsChange });
      await screen.findByTitle("app / src/Service.java");
      await waitFor(() => expect(screen.queryByText("LSP idle")).not.toBeInTheDocument());

      await runWorkflow(registrationRef, "workspace.rearrangeCode");
      // Applied text remains in buffer
      await waitFor(() => expect(fileText("instance-repair001-retry-cancel")).toBe(SERVICE_POST));
      const message = useAppStore.getState().statusMessage;
      expect(message).toContain("postcondition could not be verified");
      expect(message).not.toContain("Rearranged Service.java");

      const journals = storedJournals();
      expect(journals).toHaveLength(1);
      expect(journals[0]!.entry.status).toBe("recovery-required");
    });

    it("refuses save retry if buffer text was modified by user typing before retry (ED-REPAIR-001-A2)", async () => {
      const registrationRef: { current: WorkspaceCommandRegistration | null } = { current: null };
      const onCommandsChange = vi.fn((_tabId: string, next: WorkspaceCommandRegistration | null) => {
        if (next) registrationRef.current = next;
      });
      mockWorkflowProvider("source.rearrange");
      let writeAttempts = 0;
      workspaceTestHarness.workspaceMocks.workspaceWriteFileEncoded.mockImplementation(async (
        _rootPath: string,
        path: string,
        text: string,
      ) => {
        writeAttempts += 1;
        if (writeAttempts === 1) {
          throw Object.assign(new Error("disk locked"), { kind: "io", effect: "none" });
        }
        return workspaceTestHarness.writeAck(workspaceTestHarness.file(path, text, { hash: `hash-${text}` }));
      });
      const typedUserComment = "\n// concurrent user typing\n";
      let dialogCalls = 0;
      vi.mocked(confirmAppDialog).mockClear();
      vi.mocked(confirmAppDialog).mockImplementation(async (opts) => {
        if (opts.title === "Rearrange preview") return true;
        if (opts.title === "Workspace edit save failed") {
          dialogCalls += 1;
          // Simulate user typing into the buffer while the dialog was open
          useCodeWorkspaceStore.getState().updateOpenFiles(
            "instance-repair001-typing-before-retry",
            (current) => {
              const target = current[OPEN_KEY];
              if (!target) return current;
              return {
                ...current,
                [OPEN_KEY]: {
                  ...target,
                  text: target.text + typedUserComment,
                  dirty: true,
                },
              };
            },
          );
          return true;
        }
        return false;
      });

      workspaceTestHarness.renderWorkspace(repairWorkspace("instance-repair001-typing-before-retry"), { onCommandsChange });
      await screen.findByTitle("app / src/Service.java");
      await waitFor(() => expect(screen.queryByText("LSP idle")).not.toBeInTheDocument());

      await runWorkflow(registrationRef, "workspace.rearrangeCode");
      // Newer typing was protected and not overwritten
      await waitFor(() => expect(fileText("instance-repair001-typing-before-retry")).toBe(SERVICE_POST + typedUserComment));
      // Retry was aborted, so only the initial write was attempted (writeAttempts === 1)
      expect(writeAttempts).toBe(1);
      expect(dialogCalls).toBe(1);
      expect(useAppStore.getState().statusMessage).not.toContain("Rearranged Service.java");
      const journals = storedJournals();
      expect(journals).toHaveLength(1);
      expect(journals[0]!.entry.status).toBe("recovery-required");
    });

    it("does not offer save retry when disk write reports unknown effect (ED-REPAIR-001-A1)", async () => {
      const registrationRef: { current: WorkspaceCommandRegistration | null } = { current: null };
      const onCommandsChange = vi.fn((_tabId: string, next: WorkspaceCommandRegistration | null) => {
        if (next) registrationRef.current = next;
      });
      mockWorkflowProvider("source.rearrange");
      workspaceTestHarness.workspaceMocks.workspaceWriteFileEncoded.mockRejectedValue(Object.assign(
        new Error("network timeout writing file"),
        { kind: "io", effect: "unknown" },
      ));
      const dialogTitles: string[] = [];
      vi.mocked(confirmAppDialog).mockClear();
      vi.mocked(confirmAppDialog).mockImplementation(async (opts) => {
        if (opts.title) dialogTitles.push(opts.title);
        return opts.title === "Rearrange preview";
      });

      workspaceTestHarness.renderWorkspace(repairWorkspace("instance-repair001-unknown-effect"), { onCommandsChange });
      await screen.findByTitle("app / src/Service.java");
      await waitFor(() => expect(screen.queryByText("LSP idle")).not.toBeInTheDocument());

      await runWorkflow(registrationRef, "workspace.rearrangeCode");
      // Save retry dialog must NEVER be shown for unknown disk effects
      expect(dialogTitles).not.toContain("Workspace edit save failed");
      expect(dialogTitles).not.toContain("Workspace edit partially applied");
      expect(useAppStore.getState().statusMessage).toContain("write result is unknown");
      const journals = storedJournals();
      expect(journals).toHaveLength(1);
      expect(journals[0]!.entry.status).toBe("recovery-required");
    });
  });
}
