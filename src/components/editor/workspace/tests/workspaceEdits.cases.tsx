import { emit, type UnlistenFn } from "@tauri-apps/api/event";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { confirmAppDialog } from "../../../../lib/appDialogs";
import { DEFAULT_CODE_VIEW_PROFILE, saveCodeViewProfile } from "../../../../lib/codeViewProfile";
import type { LspDocumentStatus } from "../../../../lib/editor/lsp";
import * as workspaceSearchModule from "../../../../lib/editor/workspaceSearch";
import { useAppStore } from "../../../../stores/appStore";
import { selectCodeWorkspaceUi, useCodeWorkspaceStore } from "../../../../stores/codeWorkspaceStore";
import type { CodeWorkspaceTabInfo } from "../../../../types";
import type { WorkspaceTestFixture } from "../../CodeWorkspaceTab.test";
import { writeEditorAppearanceProfile } from "../editorAppearanceProfile";
import type { WorkspaceCommandRegistration } from "../workspaceCommands";
import { registerRecoveryJournalCases } from "./recoveryJournal.cases";
import { registerCleanupCases } from "./cleanup.cases";
import { registerEditTransactionsCases } from "./editTransactions.cases";
import { registerExtractMethodCases } from "./extractMethod.cases";

export type registerWorkspaceEditsCasesFixture = Pick<WorkspaceTestFixture, "workspaceMocks" | "file" | "renderWorkspace" | "entry" | "writeAck" | "lspMocks" | "documentStatus" | "confirmWorkspaceUndo" | "runtimeState" | "dapMocks" | "csharpStatus" | "toolbarControl" | "defaultCapabilities">;

export function registerWorkspaceEditsCases(workspaceTestHarness: registerWorkspaceEditsCasesFixture) {
it("keeps workspace editor appearance isolated from the global code-view profile", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-theme-follow",
      name: "Theme",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/main.ts" },
    };
    workspaceTestHarness.workspaceMocks.workspaceReadFile.mockResolvedValue(workspaceTestHarness.file("src/main.ts", "export const answer = 42;"));
    const registrationRef: { current: WorkspaceCommandRegistration | null } = { current: null };
    const onCommandsChange = vi.fn((_tabId: string, next: WorkspaceCommandRegistration | null) => {
      if (next) registrationRef.current = next;
    });

    workspaceTestHarness.renderWorkspace(workspace, { onCommandsChange });

    expect(await screen.findByText("Code · Theme")).toBeInTheDocument();
    // The workspace no longer owns a theme selector; theme is set in Settings.
    expect(screen.queryByTestId("code-workspace-theme-select")).toBeNull();

    // Global Code View changes no longer mutate the Code Workspace editor.
    act(() => {
      saveCodeViewProfile({ ...DEFAULT_CODE_VIEW_PROFILE, theme: "kanagawa-wave" });
    });
    expect(document.documentElement.style.getPropertyValue("--taomni-code-bg")).toBe("");

    writeEditorAppearanceProfile("ws-theme-follow", {
      fontFamily: DEFAULT_CODE_VIEW_PROFILE.fontFamily,
      fontSizePx: 13,
      lineHeight: 1.5,
      ligatures: true,
      colorSchemeId: "dracula",
      highContrast: false,
      zoomScope: "all-editors",
      highlighting: "all-problems",
      softWrap: { patterns: [], useOriginalIndent: true, additionalIndent: 0, showMarkers: false },
      virtualSpace: { afterLineEnd: false, atFileBottom: false },
      breadcrumbs: { visible: true, placement: "top", languages: ["*"] },
      clipboard: { historyEnabled: true, historyMaxItems: 30, historyMaxTotalBytes: 1024 * 1024 },
    });
    await waitFor(() => expect(
      registrationRef.current?.items.some((item) => item.id === "workspace.editorAppearanceSettings"),
    ).toBe(true));
    act(() => {
      expect(registrationRef.current?.execute("workspace.editorAppearanceSettings")).toBe(true);
    });
    expect(await screen.findByTestId("workspace-editor-appearance-settings-dialog")).toBeInTheDocument();
    fireEvent.change(screen.getByTestId("workspace-editor-appearance-color-scheme-id"), {
      target: { value: "dracula" },
    });
    fireEvent.click(screen.getByTestId("workspace-editor-appearance-apply"));
    await waitFor(() => {
      expect(document.querySelector(".cm-content")).toHaveAttribute(
        "data-editor-color-scheme",
        "dracula",
      );
    });
  });
it("requests code actions on Alt+Enter and applies workspace edits", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-actions",
      workspaceInstanceId: "instance-actions",
      name: "Actions",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/main.ts" },
    };
    workspaceTestHarness.workspaceMocks.workspaceListDir.mockResolvedValue([workspaceTestHarness.entry("src", "src", "dir")]);
    workspaceTestHarness.workspaceMocks.workspaceReadFile.mockResolvedValue(workspaceTestHarness.file("src/main.ts", "x=1"));
    workspaceTestHarness.workspaceMocks.workspaceWriteFileEncoded.mockImplementation(async (
      _rootPath: string,
      path: string,
      text: string,
    ) => workspaceTestHarness.writeAck(workspaceTestHarness.file(path, text, { hash: `hash-${text}` })));
    workspaceTestHarness.lspMocks.lspOpenDocument.mockResolvedValue(workspaceTestHarness.documentStatus({
      path: "/repo/app/src/main.ts",
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
    }));
    workspaceTestHarness.lspMocks.lspCodeActions.mockResolvedValue({
      status: workspaceTestHarness.documentStatus({ available: true, active: true }),
      actions: [{
        title: "Insert space",
        kind: "quickfix",
        isPreferred: true,
        edit: null,
        command: null,
        commandArguments: null,
        raw: {
          title: "Insert space",
          kind: "quickfix",
          data: { fixId: "space" },
        },
      }],
    });
    workspaceTestHarness.lspMocks.lspCodeActionResolve.mockResolvedValue({
      status: workspaceTestHarness.documentStatus({ available: true, active: true }),
      action: {
        title: "Insert space",
        kind: "quickfix",
        isPreferred: true,
        edit: {
          documentEdits: [{
            uri: "file:///repo/app/src/main.ts",
            path: "/repo/app/src/main.ts",
            edits: [{
              range: {
                start: { line: 0, character: 1 },
                end: { line: 0, character: 1 },
              },
              newText: " ",
            }],
          }],
        },
        command: null,
        commandArguments: null,
        raw: { title: "Insert space", data: { fixId: "space" } },
      },
    });

    const registrationRef: { current: WorkspaceCommandRegistration | null } = { current: null };
    const onCommandsChange = vi.fn((_tabId: string, next: WorkspaceCommandRegistration | null) => {
      if (next) registrationRef.current = next;
    });
    workspaceTestHarness.renderWorkspace(workspace, { onCommandsChange });
    await screen.findByTitle("app / src/main.ts");
    await waitFor(() => expect(screen.queryByText("LSP idle")).not.toBeInTheDocument());

    fireEvent.keyDown(window, { key: "Enter", altKey: true });
    await waitFor(() => expect(workspaceTestHarness.lspMocks.lspCodeActions).toHaveBeenCalled());
    fireEvent.click(await screen.findByRole("button", { name: "Insert space" }));
    await waitFor(() => expect(workspaceTestHarness.lspMocks.lspCodeActionResolve).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ data: { fixId: "space" } }),
    ));
    await waitFor(() => expect(selectCodeWorkspaceUi(
      useCodeWorkspaceStore.getState(),
      "instance-actions",
    ).openFiles["root:app:src/main.ts"]?.text).toBe("x =1"));
    await waitFor(() => expect(useAppStore.getState().statusMessage).toContain("undo transaction"));

    // ED-AUDIT-008: with editor focus the journal action yields the stroke to
    // the shared document undo (which claims the journal), so the journal
    // action itself stays disabled in the snapshot even though the transaction
    // is undoable; a non-editor stroke (window target) still reaches it.
    await waitFor(() => expect(
      registrationRef.current?.items.find((item) => item.id === "workspace.undoWorkspaceEdit")?.enabled,
    ).toBe(false));
    await act(async () => {
      fireEvent.keyDown(window, { key: "z", ctrlKey: true });
    });
    await workspaceTestHarness.confirmWorkspaceUndo();
    await waitFor(() => expect(selectCodeWorkspaceUi(
      useCodeWorkspaceStore.getState(),
      "instance-actions",
    ).openFiles["root:app:src/main.ts"]?.text).toBe("x=1"));

    await act(async () => {
      fireEvent.keyDown(window, { key: "z", ctrlKey: true, shiftKey: true });
    });
    await waitFor(() => expect(selectCodeWorkspaceUi(
      useCodeWorkspaceStore.getState(),
      "instance-actions",
    ).openFiles["root:app:src/main.ts"]?.text).toBe("x =1"));
  });
it("undoes an applied code action through the journal with Ctrl+Z on the editor surface", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-actions-undo",
      workspaceInstanceId: "instance-actions-undo",
      name: "Actions",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/main.ts" },
    };
    workspaceTestHarness.workspaceMocks.workspaceListDir.mockResolvedValue([workspaceTestHarness.entry("src", "src", "dir")]);
    workspaceTestHarness.workspaceMocks.workspaceReadFile.mockResolvedValue(workspaceTestHarness.file("src/main.ts", "x=1"));
    workspaceTestHarness.workspaceMocks.workspaceWriteFileEncoded.mockImplementation(async (
      _rootPath: string,
      path: string,
      text: string,
    ) => workspaceTestHarness.writeAck(workspaceTestHarness.file(path, text, { hash: `hash-${text}` })));
    workspaceTestHarness.lspMocks.lspOpenDocument.mockResolvedValue(workspaceTestHarness.documentStatus({
      path: "/repo/app/src/main.ts",
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
    }));
    workspaceTestHarness.lspMocks.lspCodeActions.mockResolvedValue({
      status: workspaceTestHarness.documentStatus({ available: true, active: true }),
      actions: [{
        title: "Insert space",
        kind: "quickfix",
        isPreferred: true,
        edit: null,
        command: null,
        commandArguments: null,
        raw: {
          title: "Insert space",
          kind: "quickfix",
          data: { fixId: "space" },
        },
      }],
    });
    workspaceTestHarness.lspMocks.lspCodeActionResolve.mockResolvedValue({
      status: workspaceTestHarness.documentStatus({ available: true, active: true }),
      action: {
        title: "Insert space",
        kind: "quickfix",
        isPreferred: true,
        edit: {
          documentEdits: [{
            uri: "file:///repo/app/src/main.ts",
            path: "/repo/app/src/main.ts",
            edits: [{
              range: {
                start: { line: 0, character: 1 },
                end: { line: 0, character: 1 },
              },
              newText: " ",
            }],
          }],
        },
        command: null,
        commandArguments: null,
        raw: { title: "Insert space", data: { fixId: "space" } },
      },
    });

    workspaceTestHarness.renderWorkspace(workspace);
    await screen.findByTitle("app / src/main.ts");
    await waitFor(() => expect(screen.queryByText("LSP idle")).not.toBeInTheDocument());

    fireEvent.keyDown(window, { key: "Enter", altKey: true });
    fireEvent.click(await screen.findByRole("button", { name: "Insert space" }));
    await waitFor(() => expect(selectCodeWorkspaceUi(
      useCodeWorkspaceStore.getState(),
      "instance-actions-undo",
    ).openFiles["root:app:src/main.ts"]?.text).toBe("x =1"));
    await waitFor(() => expect(useAppStore.getState().statusMessage).toContain("undo transaction"));

    const pane = screen.getAllByTestId("code-workspace-editor-pane")[0]!;
    fireEvent.keyDown(pane, { key: "z", ctrlKey: true });
    await waitFor(() => expect(selectCodeWorkspaceUi(
      useCodeWorkspaceStore.getState(),
      "instance-actions-undo",
    ).openFiles["root:app:src/main.ts"]?.text).toBe("x=1"));
    await waitFor(() => expect(useAppStore.getState().statusMessage).toContain("Undid Insert space"));

    // The journal owns the reverted transaction; the superseded document
    // ledger entry is stale, so a second Ctrl+Z must be a no-op instead of
    // re-applying the undone change.
    fireEvent.keyDown(pane, { key: "z", ctrlKey: true });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(selectCodeWorkspaceUi(
      useCodeWorkspaceStore.getState(),
      "instance-actions-undo",
    ).openFiles["root:app:src/main.ts"]?.text).toBe("x=1");
  });
it("recovers the applied edit and reports an accurate failure when the provider command throws", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-actions-cmdfail",
      workspaceInstanceId: "instance-actions-cmdfail",
      name: "Actions",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/main.ts" },
    };
    workspaceTestHarness.workspaceMocks.workspaceListDir.mockResolvedValue([workspaceTestHarness.entry("src", "src", "dir")]);
    workspaceTestHarness.workspaceMocks.workspaceReadFile.mockResolvedValue(workspaceTestHarness.file("src/main.ts", "x=1"));
    workspaceTestHarness.workspaceMocks.workspaceWriteFileEncoded.mockImplementation(async (
      _rootPath: string,
      path: string,
      text: string,
    ) => workspaceTestHarness.writeAck(workspaceTestHarness.file(path, text, { hash: `hash-${text}` })));
    workspaceTestHarness.lspMocks.lspOpenDocument.mockResolvedValue(workspaceTestHarness.documentStatus({
      path: "/repo/app/src/main.ts",
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
    }));
    workspaceTestHarness.lspMocks.lspCodeActions.mockResolvedValue({
      status: workspaceTestHarness.documentStatus({ available: true, active: true }),
      actions: [{
        title: "Insert space then sync",
        kind: "quickfix",
        isPreferred: true,
        edit: null,
        command: null,
        commandArguments: null,
        raw: { title: "Insert space then sync", data: { fixId: "space-sync" } },
      }],
    });
    workspaceTestHarness.lspMocks.lspCodeActionResolve.mockResolvedValue({
      status: workspaceTestHarness.documentStatus({ available: true, active: true }),
      action: {
        title: "Insert space then sync",
        kind: "quickfix",
        isPreferred: true,
        edit: {
          documentEdits: [{
            uri: "file:///repo/app/src/main.ts",
            path: "/repo/app/src/main.ts",
            edits: [{
              range: { start: { line: 0, character: 1 }, end: { line: 0, character: 1 } },
              newText: " ",
            }],
          }],
        },
        command: "java.project.refresh",
        commandArguments: [],
        raw: { title: "Insert space then sync", data: { fixId: "space-sync" } },
      },
    });
    workspaceTestHarness.lspMocks.lspExecuteCommand.mockRejectedValue(
      new Error("LSP command execution timed out on language server"),
    );

    const registrationRef: { current: WorkspaceCommandRegistration | null } = { current: null };
    const onCommandsChange = vi.fn((_tabId: string, next: WorkspaceCommandRegistration | null) => {
      if (next) registrationRef.current = next;
    });
    workspaceTestHarness.renderWorkspace(workspace, { onCommandsChange });
    await screen.findByTitle("app / src/main.ts");
    await waitFor(() => expect(screen.queryByText("LSP idle")).not.toBeInTheDocument());

    fireEvent.keyDown(window, { key: "Enter", altKey: true });
    fireEvent.click(await screen.findByRole("button", { name: "Insert space then sync" }));

    // The edit lands first...
    await waitFor(() => expect(selectCodeWorkspaceUi(
      useCodeWorkspaceStore.getState(),
      "instance-actions-cmdfail",
    ).openFiles["root:app:src/main.ts"]?.text).toBe("x =1"));
    // ...then the command failure is recovered: the text is restored and the
    // message names the failure plus the performed recovery (never a
    // zero-effect wording that would mask the mutation).
    await waitFor(() => expect(useAppStore.getState().statusMessage).toContain("Code action failed:"));
    expect(useAppStore.getState().statusMessage).toContain("Provider command execution failed");
    expect(useAppStore.getState().statusMessage).toContain("recovery ca-rec-");
    expect(useAppStore.getState().statusMessage).toContain("performed");
    await waitFor(() => expect(selectCodeWorkspaceUi(
      useCodeWorkspaceStore.getState(),
      "instance-actions-cmdfail",
    ).openFiles["root:app:src/main.ts"]?.text).toBe("x=1"));
    await waitFor(() => expect(
      registrationRef.current?.items.find((item) => item.id === "workspace.undoWorkspaceEdit")?.enabled,
    ).not.toBe(true));
  });
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
    const activeStatus = workspaceTestHarness.documentStatus({
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
    workspaceTestHarness.workspaceMocks.workspaceReadFile.mockResolvedValue(workspaceTestHarness.file("src/main.ts", "const value = 1;"));
    workspaceTestHarness.lspMocks.lspOpenDocument.mockResolvedValue(activeStatus);
    workspaceTestHarness.lspMocks.lspChangeDocument.mockResolvedValue(activeStatus);
    workspaceTestHarness.lspMocks.lspCodeActions.mockResolvedValue({
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

    const rendered = workspaceTestHarness.renderWorkspace(workspace);
    await screen.findByTitle("app / src/main.ts");
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
    expect(workspaceTestHarness.workspaceMocks.workspaceApplyResourceOperation).not.toHaveBeenCalled();
  });
it("recovers and launches when incremental build reports withError but full rebuild succeeds", async () => {
    workspaceTestHarness.runtimeState.tauri = true;
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-java-debug-rebuild-recover",
      workspaceInstanceId: "instance-java-debug-rebuild-recover",
      name: "Java debug rebuild recover",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/main/java/com/acme/App.java" },
    };
    workspaceTestHarness.workspaceMocks.workspaceReadFile.mockResolvedValue(workspaceTestHarness.file(
      "src/main/java/com/acme/App.java",
      "package com.acme; class App { public static void main(String[] args) {} }",
    ));
    workspaceTestHarness.lspMocks.lspBuildWorkspace
      .mockResolvedValueOnce("withError")
      .mockResolvedValueOnce("succeed");
    workspaceTestHarness.dapMocks.dapResolveJavaMainClasses.mockResolvedValue({
      kind: "resolved",
      main: {
        mainClass: "com.acme.App",
        projectName: "app",
        filePath: "/repo/app/src/main/java/com/acme/App.java",
      },
    });
    workspaceTestHarness.dapMocks.dapStartSession.mockResolvedValue({
      sessionId: "sess-recover",
      capabilities: {},
      request: "launch",
      arguments: { mainClass: "com.acme.App" },
    });

    workspaceTestHarness.renderWorkspace(workspace, {}, { strict: true });
    await screen.findByTitle("app / src/main/java/com/acme/App.java");
    fireEvent.click(screen.getByTestId("code-workspace-debug-target"));

    const consoleOutput = await screen.findByTestId("debug-console-output");
    await waitFor(() => expect(consoleOutput.textContent).toContain("Rebuilding project…"));
    await waitFor(() => expect(workspaceTestHarness.dapMocks.dapResolveJavaMainClasses).toHaveBeenCalled());
    await waitFor(() => expect(workspaceTestHarness.dapMocks.dapStartSession).toHaveBeenCalled());
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
    workspaceTestHarness.workspaceMocks.workspaceReadFile.mockResolvedValue(workspaceTestHarness.file("src/Program.cs", "class Program {}"));
    workspaceTestHarness.lspMocks.lspDetectServers.mockResolvedValue([workspaceTestHarness.csharpStatus({ available: true, active: true })]);
    workspaceTestHarness.lspMocks.lspOpenDocument.mockResolvedValue(workspaceTestHarness.documentStatus({ available: true, active: true }));
    workspaceTestHarness.lspMocks.lspCloseDocument.mockRejectedValueOnce(new Error("didClose transport failed"));

    workspaceTestHarness.renderWorkspace(workspace);
    await screen.findByTitle("app / src/Program.cs");
    await waitFor(() => expect(workspaceTestHarness.lspMocks.lspOpenDocument).toHaveBeenCalledTimes(1));
    fireEvent.keyDown(window, { key: "F4", ctrlKey: true });

    await waitFor(() => expect(
      selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "instance-close-recovery")
        .editorGroups.primary.openOrder,
    ).toHaveLength(0));
    await waitFor(() => expect(useAppStore.getState().statusMessage).toMatch(
      /committed with recovery resource-recovery-instance-close-recovery-1/,
    ));
    expect(workspaceTestHarness.lspMocks.lspCloseDocument).toHaveBeenCalledTimes(1);
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
    await waitFor(() => expect(workspaceTestHarness.lspMocks.lspCloseDocument).toHaveBeenCalledTimes(2));
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
    workspaceTestHarness.workspaceMocks.workspaceListDir.mockResolvedValue([
      workspaceTestHarness.entry("A.cs", "A.cs"),
      workspaceTestHarness.entry("B.cs", "B.cs"),
    ]);
    workspaceTestHarness.workspaceMocks.workspaceReadFile.mockImplementation(async (_root: string, path: string) => (
      workspaceTestHarness.file(path, path === "A.cs" ? "class A {}" : "class B {}")
    ));
    workspaceTestHarness.lspMocks.lspDetectServers.mockResolvedValue([workspaceTestHarness.csharpStatus({ available: true, active: true })]);
    workspaceTestHarness.lspMocks.lspOpenDocument.mockResolvedValue(workspaceTestHarness.documentStatus({ available: true, active: true }));

    workspaceTestHarness.renderWorkspace(workspace);
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

    workspaceTestHarness.lspMocks.lspCloseDocument.mockRejectedValueOnce(new Error("policy didClose failed"));
    fireEvent.click(workspaceTestHarness.toolbarControl("code-workspace-tab-policy-settings"));
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
    await waitFor(() => expect(workspaceTestHarness.lspMocks.lspCloseDocument).toHaveBeenCalledTimes(2));
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
    workspaceTestHarness.workspaceMocks.workspaceReadFile.mockResolvedValue(workspaceTestHarness.file("src/Program.cs", "class Program {}"));
    workspaceTestHarness.lspMocks.lspDetectServers.mockResolvedValue([workspaceTestHarness.csharpStatus({ available: true, active: true })]);
    workspaceTestHarness.lspMocks.lspOpenDocument.mockResolvedValue(workspaceTestHarness.documentStatus({ available: true, active: true }));
    workspaceTestHarness.lspMocks.lspCloseDocument.mockReturnValueOnce(closePromise);
    const registrationRef: { current: WorkspaceCommandRegistration | null } = { current: null };
    const onCommandsChange = vi.fn((_tabId: string, next: WorkspaceCommandRegistration | null) => {
      if (next) registrationRef.current = next;
    });

    workspaceTestHarness.renderWorkspace(workspace, { onCommandsChange });
    await screen.findByTitle("app / src/Program.cs");
    await waitFor(() => expect(workspaceTestHarness.lspMocks.lspOpenDocument).toHaveBeenCalledTimes(1));

    fireEvent.keyDown(window, { key: "F4", ctrlKey: true });
    await waitFor(() => expect(
      selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "instance-close-reopen-race")
        .editorGroups.primary.openOrder,
    ).toHaveLength(0));
    await waitFor(() => expect(screen.getByTestId("code-workspace-tab"))
      .toHaveAttribute("data-reopen-stack-count", "1"));
    expect(registrationRef.current?.shellShortcutClaims).toHaveLength(1);
    expect(workspaceTestHarness.lspMocks.lspCloseDocument).toHaveBeenCalledTimes(1);

    await act(async () => {
      await registrationRef.current?.executeAction("workspace.reopenClosedTab");
    });
    await waitFor(() => expect(
      selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "instance-close-reopen-race")
        .editorGroups.primary.openOrder,
    ).toContain(fileKey));
    expect(screen.getByTestId("code-workspace-tab")).toHaveAttribute("data-reopen-stack-count", "0");

    resolveClose(workspaceTestHarness.documentStatus({ available: true, active: true }));
    await waitFor(() => expect(workspaceTestHarness.lspMocks.lspOpenDocument).toHaveBeenCalledTimes(2));
    expect(selectCodeWorkspaceUi(
      useCodeWorkspaceStore.getState(),
      "instance-close-reopen-race",
    ).openFiles[fileKey]).toBeDefined();
  });
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
      workspaceTestHarness.workspaceMocks.workspaceListDir.mockImplementation(async (_root: string, path: string) => (
        path === "src"
          ? Object.keys(disk).map((relative) => workspaceTestHarness.entry(relative.split("/").pop()!, relative))
          : [workspaceTestHarness.entry("src", "src", "dir")]
      ));
      workspaceTestHarness.workspaceMocks.workspaceReadFile.mockImplementation(async (_root: string, path: string) => (
        workspaceTestHarness.file(path, disk[path] ?? "", { hash: `hash-${disk[path] ?? ""}` })
      ));
      workspaceTestHarness.workspaceMocks.workspaceReadFileWithEncoding.mockImplementation(async (_root: string, path: string) => (
        workspaceTestHarness.file(path, disk[path] ?? "", { hash: `hash-${disk[path] ?? ""}` })
      ));
      workspaceTestHarness.workspaceMocks.workspaceWriteFileEncoded.mockImplementation(async (
        _root: string,
        path: string,
        text: string,
      ) => {
        disk[path] = text;
        return workspaceTestHarness.writeAck(workspaceTestHarness.file(path, text, { hash: `hash-${text}` }));
      });

      const registrationRef: { current: WorkspaceCommandRegistration | null } = { current: null };
      const onCommandsChange = vi.fn((_tabId: string, next: WorkspaceCommandRegistration | null) => {
        if (next) registrationRef.current = next;
      });
      let searchHandler: ((event: workspaceSearchModule.WorkspaceSearchEvent) => void) | null = null;
      vi.spyOn(workspaceSearchModule, "subscribeWorkspaceSearch").mockImplementation(async (_id, handler): Promise<UnlistenFn> => {
        searchHandler = handler;
        return () => undefined;
      });
      vi.spyOn(workspaceSearchModule, "workspaceSearchStart").mockResolvedValue("search-parity-006");

      workspaceTestHarness.renderWorkspace(workspace, { onCommandsChange });
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
      expect(workspaceTestHarness.workspaceMocks.workspaceWriteFileEncoded).toHaveBeenCalledTimes(4);
    });

    it("ED-PARITY-006 Cancel and Escape leave history untouched, then OK undoes both files once", async () => {
      const { disk } = await mountReplaceHistoryAndSearch("instance-parity-006-cancel-ok");
      const row = await screen.findByTestId("code-workspace-find-match-row");
      row.focus();
      fireEvent.keyDown(row, { key: "z", ctrlKey: true });
      fireEvent.click(await screen.findByTestId("code-workspace-undo-confirm-cancel"));
      await waitFor(() => expect(document.activeElement).toBe(row));
      expect(disk["src/a.txt"]).toBe("alpha coin\n");
      expect(workspaceTestHarness.workspaceMocks.workspaceWriteFileEncoded).toHaveBeenCalledTimes(2);

      fireEvent.keyDown(row, { key: "z", ctrlKey: true });
      await screen.findByTestId("code-workspace-undo-confirm");
      await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId("code-workspace-undo-confirm-ok")));
      fireEvent.keyDown(document.activeElement!, { key: "Escape" });
      expect(screen.queryByTestId("code-workspace-undo-confirm")).not.toBeInTheDocument();
      await waitFor(() => expect(document.activeElement).toBe(row));
      expect(disk["src/b.txt"]).toBe("beta coin\n");
      expect(workspaceTestHarness.workspaceMocks.workspaceWriteFileEncoded).toHaveBeenCalledTimes(2);

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
registerRecoveryJournalCases(workspaceTestHarness);
registerCleanupCases(workspaceTestHarness);
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
      workspaceTestHarness.workspaceMocks.workspaceListDir.mockResolvedValue([workspaceTestHarness.entry("src", "src", "dir")]);
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
        capabilities: workspaceTestHarness.defaultCapabilities({ codeAction: true, codeActionKinds: ["source.rearrange"] }),
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
    }

    it("refuses the plan when the document changed while the preview was open", async () => {
      workspaceTestHarness.runtimeState.tauri = true;
      const registrationRef: { current: WorkspaceCommandRegistration | null } = { current: null };
      const onCommandsChange = vi.fn((_tabId: string, next: WorkspaceCommandRegistration | null) => {
        if (next) registrationRef.current = next;
      });
      mockProvider();
      let disk = workspaceTestHarness.file("src/Service.java", SERVICE_PRE, { hash: "hash-pre" });
      workspaceTestHarness.workspaceMocks.workspaceReadFile.mockImplementation(async () => disk);
      vi.mocked(confirmAppDialog).mockClear();
      vi.mocked(confirmAppDialog).mockImplementation(async () => {
        // A real external process writes the file while the preview dialog is
        // open; the watcher reloads the clean buffer before the user confirms.
        disk = workspaceTestHarness.file("src/Service.java", SERVICE_RELOADED, { hash: "hash-reloaded" });
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

      workspaceTestHarness.renderWorkspace(stalePreviewWorkspace("instance-improve001-stale"), { onCommandsChange });
      await screen.findByTitle("app / src/Service.java");
      await waitFor(() => expect(screen.queryByText("LSP idle")).not.toBeInTheDocument());

      await act(async () => {
        await registrationRef.current?.executeAction("workspace.rearrangeCode");
      });
      await waitFor(() => expect(useAppStore.getState().statusMessage).toContain(
        "changed since the frozen preimage",
      ));
      expect(fileText("instance-improve001-stale")).toBe(SERVICE_RELOADED);
      expect(workspaceTestHarness.workspaceMocks.workspaceWriteFileEncoded).not.toHaveBeenCalled();
    });
  });

registerEditTransactionsCases(workspaceTestHarness);

registerExtractMethodCases(workspaceTestHarness);
}
