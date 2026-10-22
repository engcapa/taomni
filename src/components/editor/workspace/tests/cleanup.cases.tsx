import { act, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { confirmAppDialog } from "../../../../lib/appDialogs";
import { useAppStore } from "../../../../stores/appStore";
import { selectCodeWorkspaceUi, useCodeWorkspaceStore } from "../../../../stores/codeWorkspaceStore";
import type { CodeWorkspaceTabInfo } from "../../../../types";
import type { WorkspaceCommandRegistration } from "../workspaceCommands";
import { type registerWorkspaceEditsCasesFixture } from "./workspaceEdits.cases";

export function registerCleanupCases(workspaceTestHarness: registerWorkspaceEditsCasesFixture) {
describe("ED-AUDIT-015 rearrange execute wiring (mounted, model boundary for the supported path)", () => {
    const SERVICE_PRE = "package com.example;\n\npublic class Service {\n    public void beta() {}\n    public void alpha() {}\n}\n";
    const SERVICE_POST = "package com.example;\n\npublic class Service {\n    public void alpha() {}\n    public void beta() {}\n}\n";
    const SWAP_EDIT = {
      range: { start: { line: 3, character: 0 }, end: { line: 4, character: 26 } },
      newText: "    public void alpha() {}\n    public void beta() {}",
    };

    function rearrangeWorkspace(instance: string): CodeWorkspaceTabInfo {
      return {
        repoRoot: "/repo/app",
        workspaceId: "ws-rearrange",
        workspaceInstanceId: instance,
        name: "Rearrange",
        roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
        looseFiles: [],
        initialFile: { kind: "root", rootId: "app", path: "src/Service.java" },
      };
    }

    function mockRearrangeServer(codeActionKinds: string[]) {
      workspaceTestHarness.workspaceMocks.workspaceListDir.mockResolvedValue([workspaceTestHarness.entry("src", "src", "dir")]);
      workspaceTestHarness.workspaceMocks.workspaceReadFile.mockResolvedValue(workspaceTestHarness.file("src/Service.java", SERVICE_PRE));
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
        capabilities: workspaceTestHarness.defaultCapabilities({ codeAction: true, codeActionKinds }),
      }));
    }

    function fileText(instance: string): string | undefined {
      return selectCodeWorkspaceUi(
        useCodeWorkspaceStore.getState(),
        instance,
      ).openFiles["root:app:src/Service.java"]?.text;
    }

    it("reports honest unavailable via live discovery when rearrange is unadvertised", async () => {
      const registrationRef: { current: WorkspaceCommandRegistration | null } = { current: null };
      const onCommandsChange = vi.fn((_tabId: string, next: WorkspaceCommandRegistration | null) => {
        if (next) registrationRef.current = next;
      });
      mockRearrangeServer(["quickfix", "source.organizeImports"]);
      vi.mocked(confirmAppDialog).mockClear();
      workspaceTestHarness.lspMocks.lspCodeActions.mockClear();
      // Live discovery returns only the advertised non-rearrange actions.
      workspaceTestHarness.lspMocks.lspCodeActions.mockResolvedValue({
        status: workspaceTestHarness.documentStatus({ available: true, active: true }),
        actions: [
          { title: "Organize imports", kind: "source.organizeImports", raw: {} },
        ],
      });

      workspaceTestHarness.renderWorkspace(rearrangeWorkspace("instance-rearrange-unavail"), { onCommandsChange });
      await screen.findByTitle("app / src/Service.java");
      await waitFor(() => expect(screen.queryByText("LSP idle")).not.toBeInTheDocument());

      await act(async () => {
        await registrationRef.current?.executeAction("workspace.rearrangeCode");
      });
      // Advertised summaries never arbitrate (JDT LS never advertises
      // arrangement kinds): the handler discovers live, finds no
      // rearrange-kind action, and reports the received kinds with zero
      // commits and no fake success.
      await waitFor(() => expect(useAppStore.getState().statusMessage).toContain("Provider returned no rearrange action"));
      expect(fileText("instance-rearrange-unavail")).toBe(SERVICE_PRE);
      expect(workspaceTestHarness.lspMocks.lspCodeActions).toHaveBeenCalled();
      expect(confirmAppDialog).not.toHaveBeenCalled();
    });

    it("refuses a provider-disabled rearrange action before resolve and shows the reason (ED-MAIN-002)", async () => {
      const registrationRef: { current: WorkspaceCommandRegistration | null } = { current: null };
      const onCommandsChange = vi.fn((_tabId: string, next: WorkspaceCommandRegistration | null) => {
        if (next) registrationRef.current = next;
      });
      mockRearrangeServer(["source.rearrange"]);
      vi.mocked(confirmAppDialog).mockClear();
      workspaceTestHarness.lspMocks.lspCodeActions.mockClear();
      workspaceTestHarness.lspMocks.lspCodeActionResolve.mockClear();
      // LSP standard disabled object: the action is returned by discovery but
      // the provider marks it disabled with a reason.
      workspaceTestHarness.lspMocks.lspCodeActions.mockResolvedValue({
        status: workspaceTestHarness.documentStatus({ available: true, active: true }),
        actions: [{
          title: "Rearrange members",
          kind: "source.rearrange",
          isPreferred: true,
          edit: null,
          command: null,
          commandArguments: null,
          raw: { title: "Rearrange members", disabled: { reason: "cannot rearrange generated file" } },
        }],
      });

      workspaceTestHarness.renderWorkspace(rearrangeWorkspace("instance-rearrange-disabled"), { onCommandsChange });
      await screen.findByTitle("app / src/Service.java");
      await waitFor(() => expect(screen.queryByText("LSP idle")).not.toBeInTheDocument());

      await act(async () => {
        await registrationRef.current?.executeAction("workspace.rearrangeCode");
      });
      await waitFor(() => expect(useAppStore.getState().statusMessage)
        .toContain("cannot rearrange generated file"));
      expect(useAppStore.getState().statusMessage).toContain("disabled by the provider");
      expect(workspaceTestHarness.lspMocks.lspCodeActionResolve).not.toHaveBeenCalled();
      expect(confirmAppDialog).not.toHaveBeenCalled();
      expect(fileText("instance-rearrange-disabled")).toBe(SERVICE_PRE);
    });

    it("commits one verified transaction from the action entry on the supported path", async () => {
      const registrationRef: { current: WorkspaceCommandRegistration | null } = { current: null };
      const onCommandsChange = vi.fn((_tabId: string, next: WorkspaceCommandRegistration | null) => {
        if (next) registrationRef.current = next;
      });
      mockRearrangeServer(["source.rearrange"]);
      vi.mocked(confirmAppDialog).mockClear();
      vi.mocked(confirmAppDialog).mockResolvedValue(true);
      const rearrangeAction = {
        title: "Rearrange members",
        kind: "source.rearrange",
        isPreferred: true,
        edit: null,
        command: null,
        commandArguments: null,
        raw: { title: "Rearrange members" },
      };
      workspaceTestHarness.lspMocks.lspCodeActions.mockResolvedValue({
        status: workspaceTestHarness.documentStatus({ available: true, active: true }),
        actions: [rearrangeAction],
      });
      workspaceTestHarness.lspMocks.lspCodeActionResolve.mockResolvedValue({
        status: workspaceTestHarness.documentStatus({ available: true, active: true }),
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

      workspaceTestHarness.renderWorkspace(rearrangeWorkspace("instance-rearrange-apply"), { onCommandsChange });
      await screen.findByTitle("app / src/Service.java");
      await waitFor(() => expect(screen.queryByText("LSP idle")).not.toBeInTheDocument());

      await act(async () => {
        await registrationRef.current?.executeAction("workspace.rearrangeCode");
      });
      await waitFor(() => expect(confirmAppDialog).toHaveBeenCalledWith(expect.objectContaining({
        title: "Rearrange preview",
      })));
      await waitFor(() => expect(fileText("instance-rearrange-apply")).toBe(SERVICE_POST));
      await waitFor(() => expect(useAppStore.getState().statusMessage).toContain("Rearranged"));
      // Test-double provider: this proves the handler wiring (request ->
      // resolve -> plan -> confirm -> apply -> post-verify), not a live
      // capable provider.
    });

    it("cancels at the preview gate with zero commits", async () => {
      const registrationRef: { current: WorkspaceCommandRegistration | null } = { current: null };
      const onCommandsChange = vi.fn((_tabId: string, next: WorkspaceCommandRegistration | null) => {
        if (next) registrationRef.current = next;
      });
      mockRearrangeServer(["source.rearrange"]);
      vi.mocked(confirmAppDialog).mockClear();
      vi.mocked(confirmAppDialog).mockResolvedValue(false);
      const rearrangeAction = {
        title: "Rearrange members",
        kind: "source.rearrange",
        isPreferred: true,
        edit: null,
        command: null,
        commandArguments: null,
        raw: { title: "Rearrange members" },
      };
      workspaceTestHarness.lspMocks.lspCodeActions.mockResolvedValue({
        status: workspaceTestHarness.documentStatus({ available: true, active: true }),
        actions: [rearrangeAction],
      });
      workspaceTestHarness.lspMocks.lspCodeActionResolve.mockResolvedValue({
        status: workspaceTestHarness.documentStatus({ available: true, active: true }),
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

      workspaceTestHarness.renderWorkspace(rearrangeWorkspace("instance-rearrange-cancel"), { onCommandsChange });
      await screen.findByTitle("app / src/Service.java");
      await waitFor(() => expect(screen.queryByText("LSP idle")).not.toBeInTheDocument());

      await act(async () => {
        await registrationRef.current?.executeAction("workspace.rearrangeCode");
      });
      await waitFor(() => expect(useAppStore.getState().statusMessage).toContain("cancelled"));
      expect(fileText("instance-rearrange-cancel")).toBe(SERVICE_PRE);
      expect(workspaceTestHarness.workspaceMocks.workspaceWriteFileEncoded).not.toHaveBeenCalled();
    });
  });
describe("ED-AUDIT-016 cleanup execute wiring (mounted, model boundary for the supported path)", () => {
    const SERVICE_PRE = "package com.example;\n\npublic class Service {\n    public void beta() {}\n    public void alpha() {}\n}\n";
    const SERVICE_POST = "package com.example;\n\npublic class Service {\n    public void alpha() {}\n    public void beta() {}\n}\n";
    const CLEANUP_EDIT = {
      range: { start: { line: 3, character: 0 }, end: { line: 4, character: 26 } },
      newText: "    public void alpha() {}\n    public void beta() {}",
    };

    function cleanupWorkspace(instance: string): CodeWorkspaceTabInfo {
      return {
        repoRoot: "/repo/app",
        workspaceId: "ws-cleanup",
        workspaceInstanceId: instance,
        name: "Cleanup",
        roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
        looseFiles: [],
        initialFile: { kind: "root", rootId: "app", path: "src/Service.java" },
      };
    }

    function mockCleanupServer(codeActionKinds: string[]) {
      workspaceTestHarness.workspaceMocks.workspaceListDir.mockResolvedValue([workspaceTestHarness.entry("src", "src", "dir")]);
      workspaceTestHarness.workspaceMocks.workspaceReadFile.mockResolvedValue(workspaceTestHarness.file("src/Service.java", SERVICE_PRE));
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
        capabilities: workspaceTestHarness.defaultCapabilities({ codeAction: true, codeActionKinds }),
      }));
    }

    function fileText(instance: string): string | undefined {
      return selectCodeWorkspaceUi(
        useCodeWorkspaceStore.getState(),
        instance,
      ).openFiles["root:app:src/Service.java"]?.text;
    }

    it("reports honest unavailable via live discovery when cleanup is unadvertised", async () => {
      const registrationRef: { current: WorkspaceCommandRegistration | null } = { current: null };
      const onCommandsChange = vi.fn((_tabId: string, next: WorkspaceCommandRegistration | null) => {
        if (next) registrationRef.current = next;
      });
      mockCleanupServer(["quickfix", "source.organizeImports"]);
      vi.mocked(confirmAppDialog).mockClear();
      workspaceTestHarness.lspMocks.lspCodeActions.mockClear();
      workspaceTestHarness.lspMocks.lspCodeActions.mockResolvedValue({
        status: workspaceTestHarness.documentStatus({ available: true, active: true }),
        actions: [
          { title: "Organize imports", kind: "source.organizeImports", raw: {} },
        ],
      });

      workspaceTestHarness.renderWorkspace(cleanupWorkspace("instance-cleanup-unavail"), { onCommandsChange });
      await screen.findByTitle("app / src/Service.java");
      await waitFor(() => expect(screen.queryByText("LSP idle")).not.toBeInTheDocument());

      await act(async () => {
        await registrationRef.current?.executeAction("workspace.codeCleanup");
      });
      // Advertised summaries never arbitrate: live discovery finds no
      // cleanup-kind action and reports the received kinds, zero commits.
      await waitFor(() => expect(useAppStore.getState().statusMessage).toContain("Provider returned no cleanup action"));
      expect(fileText("instance-cleanup-unavail")).toBe(SERVICE_PRE);
      expect(workspaceTestHarness.lspMocks.lspCodeActions).toHaveBeenCalled();
      expect(confirmAppDialog).not.toHaveBeenCalled();
    });

    it("commits one verified transaction from the action entry on the supported path", async () => {
      const registrationRef: { current: WorkspaceCommandRegistration | null } = { current: null };
      const onCommandsChange = vi.fn((_tabId: string, next: WorkspaceCommandRegistration | null) => {
        if (next) registrationRef.current = next;
      });
      mockCleanupServer(["source.cleanup"]);
      vi.mocked(confirmAppDialog).mockClear();
      vi.mocked(confirmAppDialog).mockResolvedValue(true);
      const cleanupAction = {
        title: "Clean up",
        kind: "source.cleanup",
        isPreferred: true,
        edit: null,
        command: null,
        commandArguments: null,
        raw: { title: "Clean up" },
      };
      workspaceTestHarness.lspMocks.lspCodeActions.mockResolvedValue({
        status: workspaceTestHarness.documentStatus({ available: true, active: true }),
        actions: [cleanupAction],
      });
      workspaceTestHarness.lspMocks.lspCodeActionResolve.mockResolvedValue({
        status: workspaceTestHarness.documentStatus({ available: true, active: true }),
        action: {
          ...cleanupAction,
          edit: {
            documentEdits: [{
              uri: "file:///repo/app/src/Service.java",
              path: "/repo/app/src/Service.java",
              edits: [CLEANUP_EDIT],
            }],
          },
        },
      });

      workspaceTestHarness.renderWorkspace(cleanupWorkspace("instance-cleanup-apply"), { onCommandsChange });
      await screen.findByTitle("app / src/Service.java");
      await waitFor(() => expect(screen.queryByText("LSP idle")).not.toBeInTheDocument());

      await act(async () => {
        await registrationRef.current?.executeAction("workspace.codeCleanup");
      });
      await waitFor(() => expect(confirmAppDialog).toHaveBeenCalledWith(expect.objectContaining({
        title: "Code cleanup preview",
      })));
      await waitFor(() => expect(fileText("instance-cleanup-apply")).toBe(SERVICE_POST));
      await waitFor(() => expect(useAppStore.getState().statusMessage).toContain("Cleaned up"));
      // Test-double provider: this proves the handler wiring (request ->
      // resolve -> plan -> confirm -> apply -> post-verify), not a live
      // capable provider.
    });

    it("cancels at the preview gate with zero commits", async () => {
      const registrationRef: { current: WorkspaceCommandRegistration | null } = { current: null };
      const onCommandsChange = vi.fn((_tabId: string, next: WorkspaceCommandRegistration | null) => {
        if (next) registrationRef.current = next;
      });
      mockCleanupServer(["source.cleanup"]);
      vi.mocked(confirmAppDialog).mockClear();
      vi.mocked(confirmAppDialog).mockResolvedValue(false);
      const cleanupAction = {
        title: "Clean up",
        kind: "source.cleanup",
        isPreferred: true,
        edit: null,
        command: null,
        commandArguments: null,
        raw: { title: "Clean up" },
      };
      workspaceTestHarness.lspMocks.lspCodeActions.mockResolvedValue({
        status: workspaceTestHarness.documentStatus({ available: true, active: true }),
        actions: [cleanupAction],
      });
      workspaceTestHarness.lspMocks.lspCodeActionResolve.mockResolvedValue({
        status: workspaceTestHarness.documentStatus({ available: true, active: true }),
        action: {
          ...cleanupAction,
          edit: {
            documentEdits: [{
              uri: "file:///repo/app/src/Service.java",
              path: "/repo/app/src/Service.java",
              edits: [CLEANUP_EDIT],
            }],
          },
        },
      });

      workspaceTestHarness.renderWorkspace(cleanupWorkspace("instance-cleanup-cancel"), { onCommandsChange });
      await screen.findByTitle("app / src/Service.java");
      await waitFor(() => expect(screen.queryByText("LSP idle")).not.toBeInTheDocument());

      await act(async () => {
        await registrationRef.current?.executeAction("workspace.codeCleanup");
      });
      await waitFor(() => expect(useAppStore.getState().statusMessage).toContain("cancelled"));
      expect(fileText("instance-cleanup-cancel")).toBe(SERVICE_PRE);
      expect(workspaceTestHarness.workspaceMocks.workspaceWriteFileEncoded).not.toHaveBeenCalled();
    });
  });
}
