import { act, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { confirmAppDialog } from "../../../../../../lib/appDialogs";
import { useAppStore } from "../../../../../../stores/appStore";
import { selectCodeWorkspaceUi, useCodeWorkspaceStore } from "../../../../../../stores/codeWorkspaceStore";
import type { CodeWorkspaceTabInfo } from "../../../../../../types";
import type { WorkspaceCommandRegistration } from "../../../workspaceCommands";
import { type registerWorkspaceEditsCasesFixture } from "../../workspaceEdits.cases";

export interface registereditTransactionsLifecycle2CasesContext {
  workspaceTestHarness: registerWorkspaceEditsCasesFixture;
}

export function registereditTransactionsLifecycle2Cases(caseContext: registereditTransactionsLifecycle2CasesContext) {
  describe("ED-IMPROVE-003 provider payload boundary (mounted)", () => {
    const SERVICE_PRE = "package com.example;\n\npublic class Service {\n    public void beta() {}\n    public void alpha() {}\n}\n";
    const TARGET_URI = "file:///repo/app/src/Service.java";
    const TARGET_PATH = "/repo/app/src/Service.java";
    const SWAP_EDIT = {
      range: { start: { line: 3, character: 0 }, end: { line: 4, character: 26 } },
      newText: "    public void alpha() {}\n    public void beta() {}",
    };

    function boundaryWorkspace(instance: string): CodeWorkspaceTabInfo {
      return {
        repoRoot: "/repo/app",
        workspaceId: "ws-improve003",
        workspaceInstanceId: instance,
        name: "Improve 003",
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

    const ACTION = {
      title: "Rearrange members",
      kind: "source.rearrange",
      isPreferred: true,
      edit: null,
      command: null,
      commandArguments: null,
      raw: { title: "Rearrange members" },
    };

    async function runBoundary(
      instance: string,
      commandId: string,
      resolvedAction: Record<string, unknown> | null,
      advertisedKinds: string[] = ["source.rearrange"],
    ): Promise<void> {
      const registrationRef: { current: WorkspaceCommandRegistration | null; } = { current: null };
      const onCommandsChange = vi.fn((_tabId: string, next: WorkspaceCommandRegistration | null) => {
        if (next) registrationRef.current = next;
      });
      caseContext.workspaceTestHarness.workspaceMocks.workspaceListDir.mockResolvedValue([caseContext.workspaceTestHarness.entry("src", "src", "dir")]);
      caseContext.workspaceTestHarness.workspaceMocks.workspaceReadFile.mockResolvedValue(caseContext.workspaceTestHarness.file("src/Service.java", SERVICE_PRE, { hash: "hash-pre" }));
      caseContext.workspaceTestHarness.workspaceMocks.workspaceWriteFileEncoded.mockImplementation(async (
        _rootPath: string,
        path: string,
        text: string,
      ) => caseContext.workspaceTestHarness.writeAck(caseContext.workspaceTestHarness.file(path, text, { hash: `hash-${text}` })));
      caseContext.workspaceTestHarness.lspMocks.lspOpenDocument.mockResolvedValue(caseContext.workspaceTestHarness.documentStatus({
        path: TARGET_PATH,
        uri: TARGET_URI,
        presetId: "jdtls",
        languageId: "java",
        displayName: "Eclipse JDT Language Server",
        available: true,
        active: true,
        capabilities: caseContext.workspaceTestHarness.defaultCapabilities({ codeAction: true, codeActionKinds: advertisedKinds }),
      }));
      const resolvedKind = resolvedAction && typeof resolvedAction.kind === "string"
        ? resolvedAction.kind
        : ACTION.kind;
      caseContext.workspaceTestHarness.lspMocks.lspCodeActions.mockResolvedValue({
        status: caseContext.workspaceTestHarness.documentStatus({ available: true, active: true }),
        actions: [{ ...ACTION, kind: resolvedKind }],
      });
      caseContext.workspaceTestHarness.lspMocks.lspCodeActionResolve.mockResolvedValue({
        status: caseContext.workspaceTestHarness.documentStatus({ available: true, active: true }),
        action: resolvedAction,
      });
      vi.mocked(confirmAppDialog).mockClear();
      vi.mocked(confirmAppDialog).mockResolvedValue(true);

      caseContext.workspaceTestHarness.renderWorkspace(boundaryWorkspace(instance), { onCommandsChange });
      await screen.findByTitle("app / src/Service.java");
      await waitFor(() => expect(screen.queryByText("LSP idle")).not.toBeInTheDocument());

      await act(async () => {
        await registrationRef.current?.executeAction(commandId);
      });
    }

    function expectRejected(instance: string, reason: string): void {
      expect(useAppStore.getState().statusMessage).toContain(reason);
      expect(useAppStore.getState().statusMessage).toContain("nothing applied");
      expect(fileText(instance)).toBe(SERVICE_PRE);
      expect(caseContext.workspaceTestHarness.workspaceMocks.workspaceWriteFileEncoded).not.toHaveBeenCalled();
      expect(confirmAppDialog).not.toHaveBeenCalled();
    }

    it("rejects a cross-file payload without filtering it", async () => {
      await runBoundary("instance-improve003-cross-file", "workspace.rearrangeCode", {
        ...ACTION,
        edit: {
          documentEdits: [
            { uri: TARGET_URI, path: TARGET_PATH, edits: [SWAP_EDIT] },
            { uri: "file:///repo/app/src/Other.java", path: "/repo/app/src/Other.java", edits: [SWAP_EDIT] },
          ],
        },
      });
      await waitFor(() => expect(useAppStore.getState().statusMessage).toContain(
        "/repo/app/src/Other.java",
      ));
      expectRejected("instance-improve003-cross-file", "different or contradictory document");
    });

    it("rejects a rename resource operation even beside a text edit", async () => {
      await runBoundary("instance-improve003-resource", "workspace.rearrangeCode", {
        ...ACTION,
        edit: {
          documentEdits: [{ uri: TARGET_URI, path: TARGET_PATH, edits: [SWAP_EDIT] }],
          operations: [{ kind: "rename", oldUri: TARGET_URI, newUri: "file:///repo/app/src/Renamed.java" }],
        },
      });
      await waitFor(() => expect(useAppStore.getState().statusMessage).toContain(
        "resource operations (rename)",
      ));
      expectRejected("instance-improve003-resource", "resource operations (rename)");
    });

    it("rejects an edit+command payload", async () => {
      await runBoundary("instance-improve003-mixed", "workspace.rearrangeCode", {
        ...ACTION,
        edit: { documentEdits: [{ uri: TARGET_URI, path: TARGET_PATH, edits: [SWAP_EDIT] }] },
        command: "editor.action.extraSideEffect",
      });
      await waitFor(() => expect(useAppStore.getState().statusMessage).toContain(
        "both an edit and the command",
      ));
      expectRejected("instance-improve003-mixed", "both an edit and the command");
    });

    it("rejects a provider-disabled action", async () => {
      await runBoundary("instance-improve003-disabled", "workspace.rearrangeCode", {
        ...ACTION,
        edit: { documentEdits: [{ uri: TARGET_URI, path: TARGET_PATH, edits: [SWAP_EDIT] }] },
        raw: { title: "Rearrange members", disabled: true },
      });
      await waitFor(() => expect(useAppStore.getState().statusMessage).toContain("disabled"));
      expectRejected("instance-improve003-disabled", "disabled");
    });

    it("rejects a malformed or reversed edit range", async () => {
      await runBoundary("instance-improve003-range", "workspace.rearrangeCode", {
        ...ACTION,
        edit: {
          documentEdits: [{
            uri: TARGET_URI,
            path: TARGET_PATH,
            edits: [{
              range: { start: { line: 4, character: 5 }, end: { line: 3, character: 0 } },
              newText: "x",
            }],
          }],
        },
      });
      await waitFor(() => expect(useAppStore.getState().statusMessage).toContain(
        "malformed or reversed",
      ));
      expectRejected("instance-improve003-range", "malformed or reversed");
    });

    it("rejects a null resolve as malformed", async () => {
      await runBoundary("instance-improve003-null", "workspace.rearrangeCode", null);
      await waitFor(() => expect(useAppStore.getState().statusMessage).toContain(
        "resolve returned no action",
      ));
      expect(fileText("instance-improve003-null")).toBe(SERVICE_PRE);
      expect(caseContext.workspaceTestHarness.workspaceMocks.workspaceWriteFileEncoded).not.toHaveBeenCalled();
    });

    it("does not relabel source.fixAll as an equivalent cleanup", async () => {
      await runBoundary(
        "instance-improve003-fixall",
        "workspace.codeCleanup",
        {
          title: "Fix all",
          kind: "source.fixAll",
          isPreferred: true,
          edit: { documentEdits: [{ uri: TARGET_URI, path: TARGET_PATH, edits: [SWAP_EDIT] }] },
          command: null,
          commandArguments: null,
          raw: { title: "Fix all" },
        },
        ["source.fixAll"],
      );
      await waitFor(() => expect(useAppStore.getState().statusMessage).toContain(
        "Provider returned no cleanup action",
      ));
      expect(fileText("instance-improve003-fixall")).toBe(SERVICE_PRE);
      expect(caseContext.workspaceTestHarness.workspaceMocks.workspaceWriteFileEncoded).not.toHaveBeenCalled();
      expect(confirmAppDialog).not.toHaveBeenCalled();
    });
  });
}
