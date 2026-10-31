import { findEditorByTitle } from "../../editorReadiness";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { confirmAppDialog } from "../../../../../../lib/appDialogs";
import type { LspDocumentStatus } from "../../../../../../lib/editor/lsp";
import { useAppStore } from "../../../../../../stores/appStore";
import { selectCodeWorkspaceUi, useCodeWorkspaceStore } from "../../../../../../stores/codeWorkspaceStore";
import type { CodeWorkspaceTabInfo } from "../../../../../../types";
import type { WorkspaceCommandRegistration } from "../../../workspaceCommands";
import { type registerWorkspaceEditsCasesFixture } from "../../workspaceEdits.cases";

export interface registerworkspaceEditsHistory2CasesContext {
  workspaceTestHarness: registerWorkspaceEditsCasesFixture;
}

export function registerworkspaceEditsHistory2Cases(caseContext: registerworkspaceEditsHistory2CasesContext) {
  it("rejects a provider refactor when the editor changes during preview confirmation", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-stale-refactor",
      workspaceInstanceId: "instance-stale-refactor",
      name: "Stale refactor",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/main.ts" },
    };
    const activeStatus = caseContext.workspaceTestHarness.documentStatus({
      path: "/repo/app/src/main.ts",
      uri: "file:///repo/app/src/main.ts",
      available: true,
      active: true,
      capabilities: {
        completion: false,
        signatureHelp: false,
        hover: false,
        definition: false,
        typeDefinition: false,
        implementation: false,
        references: false,
        documentSymbol: false,
        workspaceSymbol: false,
        rename: false,
        formatting: false,
        rangeFormatting: false,
        codeAction: true,
        documentHighlight: false,
        callHierarchy: false,
        typeHierarchy: false,
        inlayHint: false,
        selectionRange: false,
        semanticTokens: false,
        completionTriggerCharacters: [],
        signatureTriggerCharacters: [],
      },
    });
    caseContext.workspaceTestHarness.workspaceMocks.workspaceReadFile.mockResolvedValue(caseContext.workspaceTestHarness.file("src/main.ts", "const value = 1;"));
    caseContext.workspaceTestHarness.lspMocks.lspOpenDocument.mockResolvedValue(activeStatus);
    caseContext.workspaceTestHarness.lspMocks.lspChangeDocument.mockResolvedValue(activeStatus);
    caseContext.workspaceTestHarness.lspMocks.lspCodeActions.mockResolvedValue({
      status: activeStatus,
      actions: [{
        title: "Extract generated helper",
        kind: "refactor.extract",
        isPreferred: true,
        edit: {
          documentEdits: [],
          operations: [{
            kind: "create",
            uri: "file:///repo/app/src/generated.ts",
            path: "/repo/app/src/generated.ts",
            overwrite: false,
            ignoreIfExists: false,
            annotationId: null,
          }],
        },
        command: null,
        commandArguments: null,
        raw: {},
      }],
    });
    let resolvePreview!: (confirmed: boolean) => void;
    vi.mocked(confirmAppDialog).mockImplementationOnce(() => new Promise<boolean>((resolve) => {
      resolvePreview = resolve;
    }));

    const rendered = caseContext.workspaceTestHarness.renderWorkspace(workspace);
    await findEditorByTitle("app / src/main.ts");
    await waitFor(() => expect(screen.queryByText("LSP idle")).not.toBeInTheDocument());
    fireEvent.keyDown(window, { key: "Enter", altKey: true });
    fireEvent.click(await screen.findByRole("button", { name: "Extract generated helper" }));
    await waitFor(() => expect(confirmAppDialog).toHaveBeenCalled());

    const content = rendered.container.querySelector<HTMLElement>(".cm-content");
    expect(content).not.toBeNull();
    fireEvent.keyDown(content!, { key: "d", code: "KeyD", ctrlKey: true });
    await act(async () => {
      resolvePreview(true);
      await Promise.resolve();
    });

    await waitFor(() => expect(useAppStore.getState().statusMessage).toContain(
      "Code action stale: Live document revision changed from 0 to 1",
    ));
    expect(caseContext.workspaceTestHarness.workspaceMocks.workspaceApplyResourceOperation).not.toHaveBeenCalled();
  });
  it("recovers and launches when incremental build reports withError but full rebuild succeeds", async () => {
    caseContext.workspaceTestHarness.runtimeState.tauri = true;
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-java-debug-rebuild-recover",
      workspaceInstanceId: "instance-java-debug-rebuild-recover",
      name: "Java debug rebuild recover",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/main/java/com/acme/App.java" },
    };
    caseContext.workspaceTestHarness.workspaceMocks.workspaceReadFile.mockResolvedValue(caseContext.workspaceTestHarness.file(
      "src/main/java/com/acme/App.java",
      "package com.acme; class App { public static void main(String[] args) {} }",
    ));
    caseContext.workspaceTestHarness.lspMocks.lspBuildWorkspace
      .mockResolvedValueOnce("withError")
      .mockResolvedValueOnce("succeed");
    caseContext.workspaceTestHarness.dapMocks.dapResolveJavaMainClasses.mockResolvedValue({
      kind: "resolved",
      main: {
        mainClass: "com.acme.App",
        projectName: "app",
        filePath: "/repo/app/src/main/java/com/acme/App.java",
      },
    });
    caseContext.workspaceTestHarness.dapMocks.dapStartSession.mockResolvedValue({
      sessionId: "sess-recover",
      capabilities: {},
      request: "launch",
      arguments: { mainClass: "com.acme.App" },
    });

    caseContext.workspaceTestHarness.renderWorkspace(workspace, {}, { strict: true });
    await screen.findByTitle("app / src/main/java/com/acme/App.java");
    fireEvent.click(screen.getByTestId("code-workspace-debug-target"));

    const consoleOutput = await screen.findByTestId("debug-console-output");
    await waitFor(() => expect(consoleOutput.textContent).toContain("Rebuilding project…"));
    await waitFor(() => expect(caseContext.workspaceTestHarness.dapMocks.dapResolveJavaMainClasses).toHaveBeenCalled());
    await waitFor(() => expect(caseContext.workspaceTestHarness.dapMocks.dapStartSession).toHaveBeenCalled());
  });
  it("keeps the committed layout and buffer recovery state when final-view didClose fails", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-close-recovery",
      workspaceInstanceId: "instance-close-recovery",
      name: "Close Recovery",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/Program.cs" },
    };
    const fileKey = "root:app:src/Program.cs";
    caseContext.workspaceTestHarness.workspaceMocks.workspaceReadFile.mockResolvedValue(caseContext.workspaceTestHarness.file("src/Program.cs", "class Program {}"));
    caseContext.workspaceTestHarness.lspMocks.lspDetectServers.mockResolvedValue([caseContext.workspaceTestHarness.csharpStatus({ available: true, active: true })]);
    caseContext.workspaceTestHarness.lspMocks.lspOpenDocument.mockResolvedValue(caseContext.workspaceTestHarness.documentStatus({ available: true, active: true }));
    caseContext.workspaceTestHarness.lspMocks.lspCloseDocument.mockRejectedValueOnce(new Error("didClose transport failed"));

    caseContext.workspaceTestHarness.renderWorkspace(workspace);
    await screen.findByTitle("app / src/Program.cs");
    await waitFor(() => expect(caseContext.workspaceTestHarness.lspMocks.lspOpenDocument).toHaveBeenCalledTimes(1));
    fireEvent.keyDown(window, { key: "F4", ctrlKey: true });

    await waitFor(() => expect(
      selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "instance-close-recovery")
        .editorGroups.primary.openOrder,
    ).toHaveLength(0));
    await waitFor(() => expect(useAppStore.getState().statusMessage).toMatch(
      /committed with recovery resource-recovery-instance-close-recovery-1/,
    ));
    expect(caseContext.workspaceTestHarness.lspMocks.lspCloseDocument).toHaveBeenCalledTimes(1);
    expect(
      selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "instance-close-recovery").openFiles[fileKey],
    ).toBeDefined();

    const recovery = screen.getByTestId("workspace-resource-cleanup-recovery");
    expect(recovery).toHaveAttribute("role", "status");
    const recoveryItem = screen.getByTestId("workspace-resource-cleanup-recovery-item");
    expect(recoveryItem).toHaveAttribute("data-recovery-id", "resource-recovery-instance-close-recovery-1");
    expect(recoveryItem).toHaveAttribute("data-next-stage", "didClose");
    expect(recoveryItem).toHaveAttribute("data-attempt-count", "1");
    expect(recovery).toHaveTextContent("didClose transport failed");

    const retry = screen.getByRole("button", { name: `Retry resource cleanup for ${fileKey}` });
    fireEvent.click(retry);
    await waitFor(() => expect(caseContext.workspaceTestHarness.lspMocks.lspCloseDocument).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByTestId("workspace-resource-cleanup-recovery")).not.toBeInTheDocument());
    expect(
      selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "instance-close-recovery").openFiles[fileKey],
    ).toBeUndefined();
    expect(useAppStore.getState().statusMessage).toContain("Completed resource cleanup recovery");
  });
  it("exposes and replays cleanup recovery from a committed tab policy eviction", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-policy-recovery",
      workspaceInstanceId: "instance-policy-recovery",
      name: "Policy Recovery",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "A.cs" },
    };
    const firstKey = "root:app:A.cs";
    const secondKey = "root:app:B.cs";
    caseContext.workspaceTestHarness.workspaceMocks.workspaceListDir.mockResolvedValue([
      caseContext.workspaceTestHarness.entry("A.cs", "A.cs"),
      caseContext.workspaceTestHarness.entry("B.cs", "B.cs"),
    ]);
    caseContext.workspaceTestHarness.workspaceMocks.workspaceReadFile.mockImplementation(async (_root: string, path: string) => (
      caseContext.workspaceTestHarness.file(path, path === "A.cs" ? "class A {}" : "class B {}")
    ));
    caseContext.workspaceTestHarness.lspMocks.lspDetectServers.mockResolvedValue([caseContext.workspaceTestHarness.csharpStatus({ available: true, active: true })]);
    caseContext.workspaceTestHarness.lspMocks.lspOpenDocument.mockResolvedValue(caseContext.workspaceTestHarness.documentStatus({ available: true, active: true }));

    caseContext.workspaceTestHarness.renderWorkspace(workspace);
    await screen.findByTitle("app / A.cs");
    const secondRow = (await screen.findAllByTestId("code-workspace-tree-file")).find(
      (row) => row.getAttribute("data-path") === "B.cs",
    );
    expect(secondRow).toBeDefined();
    fireEvent.doubleClick(secondRow!);
    await screen.findByTitle("app / B.cs");
    await waitFor(() => expect(
      selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "instance-policy-recovery")
        .editorGroups.primary.openOrder,
    ).toEqual([firstKey, secondKey]));

    caseContext.workspaceTestHarness.lspMocks.lspCloseDocument.mockRejectedValueOnce(new Error("policy didClose failed"));
    fireEvent.click(caseContext.workspaceTestHarness.toolbarControl("code-workspace-tab-policy-settings"));
    fireEvent.change(await screen.findByTestId("workspace-tab-policy-limit"), {
      target: { value: "1" },
    });
    fireEvent.click(screen.getByTestId("workspace-tab-policy-apply"));

    await waitFor(() => expect(
      selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "instance-policy-recovery")
        .editorGroups.primary.openOrder,
    ).toEqual([secondKey]));
    const root = screen.getByTestId("code-workspace-tab");
    await waitFor(() => expect(root).toHaveAttribute("data-tab-policy-receipt-status", "applied"));
    expect(root).toHaveAttribute("data-tab-policy-receipt-evicted-count", "1");
    expect(root).toHaveAttribute("data-tab-policy-receipt-cleanup-count", "1");
    expect(root).toHaveAttribute("data-tab-policy-receipt-cleanup-recovery-count", "1");
    expect(root).toHaveAttribute("data-resource-recovery-count", "1");
    expect(
      selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "instance-policy-recovery").openFiles[firstKey],
    ).toBeDefined();
    expect(screen.getByTestId("workspace-resource-cleanup-recovery")).toHaveTextContent(
      "policy didClose failed",
    );

    fireEvent.click(screen.getByRole("button", { name: `Retry resource cleanup for ${firstKey}` }));
    await waitFor(() => expect(caseContext.workspaceTestHarness.lspMocks.lspCloseDocument).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(root).toHaveAttribute("data-resource-recovery-count", "0"));
    expect(
      selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "instance-policy-recovery").openFiles[firstKey],
    ).toBeUndefined();
    expect(
      selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "instance-policy-recovery").openFiles[secondKey],
    ).toBeDefined();
  });
  it("publishes the reopen claim before delayed resource cleanup completes", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-close-reopen-race",
      workspaceInstanceId: "instance-close-reopen-race",
      name: "Close Reopen Race",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/Program.cs" },
    };
    const fileKey = "root:app:src/Program.cs";
    let resolveClose!: (status: LspDocumentStatus) => void;
    const closePromise = new Promise<LspDocumentStatus>((resolve) => {
      resolveClose = resolve;
    });
    caseContext.workspaceTestHarness.workspaceMocks.workspaceReadFile.mockResolvedValue(caseContext.workspaceTestHarness.file("src/Program.cs", "class Program {}"));
    caseContext.workspaceTestHarness.lspMocks.lspDetectServers.mockResolvedValue([caseContext.workspaceTestHarness.csharpStatus({ available: true, active: true })]);
    caseContext.workspaceTestHarness.lspMocks.lspOpenDocument.mockResolvedValue(caseContext.workspaceTestHarness.documentStatus({ available: true, active: true }));
    caseContext.workspaceTestHarness.lspMocks.lspCloseDocument.mockReturnValueOnce(closePromise);
    const registrationRef: { current: WorkspaceCommandRegistration | null; } = { current: null };
    const onCommandsChange = vi.fn((_tabId: string, next: WorkspaceCommandRegistration | null) => {
      if (next) registrationRef.current = next;
    });

    caseContext.workspaceTestHarness.renderWorkspace(workspace, { onCommandsChange });
    await screen.findByTitle("app / src/Program.cs");
    await waitFor(() => expect(caseContext.workspaceTestHarness.lspMocks.lspOpenDocument).toHaveBeenCalledTimes(1));

    fireEvent.keyDown(window, { key: "F4", ctrlKey: true });
    await waitFor(() => expect(
      selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "instance-close-reopen-race")
        .editorGroups.primary.openOrder,
    ).toHaveLength(0));
    await waitFor(() => expect(screen.getByTestId("code-workspace-tab"))
      .toHaveAttribute("data-reopen-stack-count", "1"));
    expect(registrationRef.current?.shellShortcutClaims).toHaveLength(1);
    expect(caseContext.workspaceTestHarness.lspMocks.lspCloseDocument).toHaveBeenCalledTimes(1);

    await act(async () => {
      await registrationRef.current?.executeAction("workspace.reopenClosedTab");
    });
    await waitFor(() => expect(
      selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "instance-close-reopen-race")
        .editorGroups.primary.openOrder,
    ).toContain(fileKey));
    expect(screen.getByTestId("code-workspace-tab")).toHaveAttribute("data-reopen-stack-count", "0");

    resolveClose(caseContext.workspaceTestHarness.documentStatus({ available: true, active: true }));
    await waitFor(() => expect(caseContext.workspaceTestHarness.lspMocks.lspOpenDocument).toHaveBeenCalledTimes(2));
    expect(selectCodeWorkspaceUi(
      useCodeWorkspaceStore.getState(),
      "instance-close-reopen-race",
    ).openFiles[fileKey]).toBeDefined();
  });
}
