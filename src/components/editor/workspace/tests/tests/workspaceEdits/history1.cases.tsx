import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { DEFAULT_CODE_VIEW_PROFILE, saveCodeViewProfile } from "../../../../../../lib/codeViewProfile";
import { useAppStore } from "../../../../../../stores/appStore";
import { selectCodeWorkspaceUi, useCodeWorkspaceStore } from "../../../../../../stores/codeWorkspaceStore";
import type { CodeWorkspaceTabInfo } from "../../../../../../types";
import { writeEditorAppearanceProfile } from "../../../editorAppearanceProfile";
import type { WorkspaceCommandRegistration } from "../../../workspaceCommands";
import { type registerWorkspaceEditsCasesFixture } from "../../workspaceEdits.cases";

export interface registerworkspaceEditsHistory1CasesContext {
  workspaceTestHarness: registerWorkspaceEditsCasesFixture;
}

export function registerworkspaceEditsHistory1Cases(caseContext: registerworkspaceEditsHistory1CasesContext) {
  it("keeps workspace editor appearance isolated from the global code-view profile", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-theme-follow",
      name: "Theme",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/main.ts" },
    };
    caseContext.workspaceTestHarness.workspaceMocks.workspaceReadFile.mockResolvedValue(caseContext.workspaceTestHarness.file("src/main.ts", "export const answer = 42;"));
    const registrationRef: { current: WorkspaceCommandRegistration | null; } = { current: null };
    const onCommandsChange = vi.fn((_tabId: string, next: WorkspaceCommandRegistration | null) => {
      if (next) registrationRef.current = next;
    });

    caseContext.workspaceTestHarness.renderWorkspace(workspace, { onCommandsChange });

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
    caseContext.workspaceTestHarness.workspaceMocks.workspaceListDir.mockResolvedValue([caseContext.workspaceTestHarness.entry("src", "src", "dir")]);
    caseContext.workspaceTestHarness.workspaceMocks.workspaceReadFile.mockResolvedValue(caseContext.workspaceTestHarness.file("src/main.ts", "x=1"));
    caseContext.workspaceTestHarness.workspaceMocks.workspaceWriteFileEncoded.mockImplementation(async (
      _rootPath: string,
      path: string,
      text: string,
    ) => caseContext.workspaceTestHarness.writeAck(caseContext.workspaceTestHarness.file(path, text, { hash: `hash-${text}` })));
    caseContext.workspaceTestHarness.lspMocks.lspOpenDocument.mockResolvedValue(caseContext.workspaceTestHarness.documentStatus({
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
    caseContext.workspaceTestHarness.lspMocks.lspCodeActions.mockResolvedValue({
      status: caseContext.workspaceTestHarness.documentStatus({ available: true, active: true }),
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
    caseContext.workspaceTestHarness.lspMocks.lspCodeActionResolve.mockResolvedValue({
      status: caseContext.workspaceTestHarness.documentStatus({ available: true, active: true }),
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

    const registrationRef: { current: WorkspaceCommandRegistration | null; } = { current: null };
    const onCommandsChange = vi.fn((_tabId: string, next: WorkspaceCommandRegistration | null) => {
      if (next) registrationRef.current = next;
    });
    caseContext.workspaceTestHarness.renderWorkspace(workspace, { onCommandsChange });
    await screen.findByTitle("app / src/main.ts");
    await waitFor(() => expect(screen.queryByText("LSP idle")).not.toBeInTheDocument());

    await waitFor(() => expect(document.querySelector(".cm-content")?.textContent).toBe("x=1"));

    fireEvent.keyDown(window, { key: "Enter", altKey: true });
    await waitFor(() => expect(caseContext.workspaceTestHarness.lspMocks.lspCodeActions).toHaveBeenCalled());
    fireEvent.click(await screen.findByRole("button", { name: "Insert space" }));
    await waitFor(() => expect(caseContext.workspaceTestHarness.lspMocks.lspCodeActionResolve).toHaveBeenCalledWith(
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
    await caseContext.workspaceTestHarness.confirmWorkspaceUndo();
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
    caseContext.workspaceTestHarness.workspaceMocks.workspaceListDir.mockResolvedValue([caseContext.workspaceTestHarness.entry("src", "src", "dir")]);
    caseContext.workspaceTestHarness.workspaceMocks.workspaceReadFile.mockResolvedValue(caseContext.workspaceTestHarness.file("src/main.ts", "x=1"));
    caseContext.workspaceTestHarness.workspaceMocks.workspaceWriteFileEncoded.mockImplementation(async (
      _rootPath: string,
      path: string,
      text: string,
    ) => caseContext.workspaceTestHarness.writeAck(caseContext.workspaceTestHarness.file(path, text, { hash: `hash-${text}` })));
    caseContext.workspaceTestHarness.lspMocks.lspOpenDocument.mockResolvedValue(caseContext.workspaceTestHarness.documentStatus({
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
    caseContext.workspaceTestHarness.lspMocks.lspCodeActions.mockResolvedValue({
      status: caseContext.workspaceTestHarness.documentStatus({ available: true, active: true }),
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
    caseContext.workspaceTestHarness.lspMocks.lspCodeActionResolve.mockResolvedValue({
      status: caseContext.workspaceTestHarness.documentStatus({ available: true, active: true }),
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

    caseContext.workspaceTestHarness.renderWorkspace(workspace);
    await screen.findByTitle("app / src/main.ts");
    await waitFor(() => expect(screen.queryByText("LSP idle")).not.toBeInTheDocument());

    await waitFor(() => expect(document.querySelector(".cm-content")?.textContent).toBe("x=1"));

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
    caseContext.workspaceTestHarness.workspaceMocks.workspaceListDir.mockResolvedValue([caseContext.workspaceTestHarness.entry("src", "src", "dir")]);
    caseContext.workspaceTestHarness.workspaceMocks.workspaceReadFile.mockResolvedValue(caseContext.workspaceTestHarness.file("src/main.ts", "x=1"));
    caseContext.workspaceTestHarness.workspaceMocks.workspaceWriteFileEncoded.mockImplementation(async (
      _rootPath: string,
      path: string,
      text: string,
    ) => caseContext.workspaceTestHarness.writeAck(caseContext.workspaceTestHarness.file(path, text, { hash: `hash-${text}` })));
    caseContext.workspaceTestHarness.lspMocks.lspOpenDocument.mockResolvedValue(caseContext.workspaceTestHarness.documentStatus({
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
    caseContext.workspaceTestHarness.lspMocks.lspCodeActions.mockResolvedValue({
      status: caseContext.workspaceTestHarness.documentStatus({ available: true, active: true }),
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
    caseContext.workspaceTestHarness.lspMocks.lspCodeActionResolve.mockResolvedValue({
      status: caseContext.workspaceTestHarness.documentStatus({ available: true, active: true }),
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
    caseContext.workspaceTestHarness.lspMocks.lspExecuteCommand.mockRejectedValue(
      new Error("LSP command execution timed out on language server"),
    );

    const registrationRef: { current: WorkspaceCommandRegistration | null; } = { current: null };
    const onCommandsChange = vi.fn((_tabId: string, next: WorkspaceCommandRegistration | null) => {
      if (next) registrationRef.current = next;
    });
    caseContext.workspaceTestHarness.renderWorkspace(workspace, { onCommandsChange });
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
}
