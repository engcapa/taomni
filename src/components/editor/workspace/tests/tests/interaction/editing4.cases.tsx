import { findEditorByTitle } from "../../editorReadiness";
import { EditorView } from "@codemirror/view";
import { emit } from "@tauri-apps/api/event";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { confirmAppDialog } from "../../../../../../lib/appDialogs";
import { useAppStore } from "../../../../../../stores/appStore";
import { selectCodeWorkspaceUi, useCodeWorkspaceStore } from "../../../../../../stores/codeWorkspaceStore";
import type { CodeWorkspaceTabInfo } from "../../../../../../types";
import { WorkspaceLocationController } from "../../../navigationHistoryModel";
import type { WorkspaceCommandRegistration } from "../../../workspaceCommands";
import { WORKSPACE_RECOVERY_STORAGE_PREFIX } from "../../../workspaceRecovery";
import { type registerInteractionCasesFixture } from "../../interaction.cases";

export interface registerinteractionEditing4CasesContext {
  workspaceTestHarness: registerInteractionCasesFixture;
}

export function registerinteractionEditing4Cases(caseContext: registerinteractionEditing4CasesContext) {
  it("makes the active editor read-only while a resource WorkspaceEdit is in flight", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-resource-action",
      workspaceInstanceId: "instance-resource-action",
      name: "Resource action",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/main.ts" },
    };
    caseContext.workspaceTestHarness.workspaceMocks.workspaceListDir.mockResolvedValue([caseContext.workspaceTestHarness.entry("src", "src", "dir")]);
    caseContext.workspaceTestHarness.workspaceMocks.workspaceReadFile.mockResolvedValue(caseContext.workspaceTestHarness.file("src/main.ts", "const value = 1;"));
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
        title: "Rename file",
        kind: "refactor.rename",
        isPreferred: true,
        edit: {
          documentEdits: [],
          operations: [{
            kind: "rename",
            oldUri: "file:///repo/app/src/main.ts",
            oldPath: "/repo/app/src/main.ts",
            newUri: "file:///repo/app/src/renamed.ts",
            newPath: "/repo/app/src/renamed.ts",
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
    let finishResourceOperation!: (value: { ignored: boolean; }) => void;
    caseContext.workspaceTestHarness.workspaceMocks.workspaceApplyResourceOperation.mockReturnValue(new Promise((resolve) => {
      finishResourceOperation = resolve;
    }));

    caseContext.workspaceTestHarness.renderWorkspace(workspace);
    await findEditorByTitle("app / src/main.ts");
    // The document must be open with the provider before Alt+Enter asks it.
    await waitFor(() => expect(caseContext.workspaceTestHarness.lspMocks.lspOpenDocument).toHaveBeenCalled());
    fireEvent.keyDown(window, { key: "Enter", altKey: true });
    fireEvent.click(await screen.findByRole("button", { name: "Rename file" }));

    await waitFor(() => expect(confirmAppDialog).toHaveBeenCalled());
    await waitFor(() => expect(caseContext.workspaceTestHarness.workspaceMocks.workspaceApplyResourceOperation).toHaveBeenCalled());
    await waitFor(() => expect(
      screen.getByTestId("code-workspace-editor").querySelector(".cm-content"),
    ).toHaveAttribute("aria-readonly", "true"));

    await act(async () => finishResourceOperation({ ignored: false }));
    await waitFor(() => expect(
      screen.getByTestId("code-workspace-editor").querySelector(".cm-content"),
    ).not.toHaveAttribute("aria-readonly"));
    expect(caseContext.workspaceTestHarness.workspaceMocks.workspaceApplyResourceOperation).toHaveBeenCalledWith("/repo/app", {
      kind: "rename",
      fromPath: "src/main.ts",
      toPath: "src/renamed.ts",
      toRepoRoot: "/repo/app",
      overwrite: false,
      ignoreIfExists: false,
    });
    expect(Object.keys(
      selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "instance-resource-action").openFiles,
    )).toContain("root:app:src/renamed.ts");
  });
  it("runs the same format action from the editor context menu", async () => {
    caseContext.workspaceTestHarness.runtimeState.tauri = true;
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-format-context-menu",
      workspaceInstanceId: "instance-format-context-menu",
      name: "Format context menu",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/main.ts" },
    };
    caseContext.workspaceTestHarness.workspaceMocks.workspaceListDir.mockResolvedValue([caseContext.workspaceTestHarness.entry("src", "src", "dir")]);
    caseContext.workspaceTestHarness.workspaceMocks.workspaceReadFile.mockResolvedValue(caseContext.workspaceTestHarness.file("src/main.ts", "const x=1"));
    caseContext.workspaceTestHarness.lspMocks.lspOpenDocument.mockResolvedValue(caseContext.workspaceTestHarness.documentStatus({
      path: "/repo/app/src/main.ts",
      uri: "file:///repo/app/src/main.ts",
      presetId: "typescript-javascript",
      languageId: "typescript",
      displayName: "TypeScript / JavaScript",
      available: true,
      active: true,
      capabilities: caseContext.workspaceTestHarness.defaultCapabilities({ formatting: true, rangeFormatting: true }),
    }));
    caseContext.workspaceTestHarness.lspMocks.lspFormatting.mockResolvedValue({
      status: caseContext.workspaceTestHarness.documentStatus({ active: true, available: true }),
      edits: [{
        range: { start: { line: 0, character: 7 }, end: { line: 0, character: 7 } },
        newText: " ",
      }],
    });

    const rendered = caseContext.workspaceTestHarness.renderWorkspace(workspace);
    await findEditorByTitle("app / src/main.ts");
    await waitFor(() => expect(screen.queryByText("LSP idle")).not.toBeInTheDocument());
    const content = rendered.container.querySelector<HTMLElement>(".cm-content");
    expect(content).not.toBeNull();
    const view = EditorView.findFromDOM(content!);
    expect(view).not.toBeNull();
    vi.spyOn(view!, "posAtCoords").mockReturnValue(null);

    fireEvent.contextMenu(content!, { clientX: 20, clientY: 30, button: 2 });
    fireEvent.click(await screen.findByTestId("editor-context-format"));

    await waitFor(() => expect(caseContext.workspaceTestHarness.lspMocks.lspFormatting).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(selectCodeWorkspaceUi(
      useCodeWorkspaceStore.getState(),
      "instance-format-context-menu",
    ).openFiles["root:app:src/main.ts"]?.text).toBe("const x =1"));
    expect(useAppStore.getState().statusMessage).toBe("Formatted main.ts");
    const treeReads = caseContext.workspaceTestHarness.workspaceMocks.workspaceListDir.mock.calls.length;
    await act(async () => {
      await emit("lsp://external-file-change", {
        workspaceId: "instance-format-context-menu", path: "/repo/app/.project", type: 1,
      });
    });
    await waitFor(() => expect(
      caseContext.workspaceTestHarness.workspaceMocks.workspaceListDir.mock.calls.length,
    ).toBeGreaterThan(treeReads));
    expect(useAppStore.getState().statusMessage).toBe("Formatted main.ts");
  });
  it("reports a typed no-provider reason and leaves the buffer untouched", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-format-no-provider",
      workspaceInstanceId: "instance-format-no-provider",
      name: "Format no provider",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/main.ts" },
    };
    caseContext.workspaceTestHarness.workspaceMocks.workspaceListDir.mockResolvedValue([caseContext.workspaceTestHarness.entry("src", "src", "dir")]);
    caseContext.workspaceTestHarness.workspaceMocks.workspaceReadFile.mockResolvedValue(caseContext.workspaceTestHarness.file("src/main.ts", "const x=1"));
    caseContext.workspaceTestHarness.lspMocks.lspOpenDocument.mockResolvedValue(caseContext.workspaceTestHarness.documentStatus({
      path: "/repo/app/src/main.ts",
      uri: "file:///repo/app/src/main.ts",
      presetId: "typescript-javascript",
      languageId: "typescript",
      displayName: "TypeScript / JavaScript",
      available: true,
      active: true,
      capabilities: caseContext.workspaceTestHarness.defaultCapabilities(),
    }));

    caseContext.workspaceTestHarness.renderWorkspace(workspace);
    await findEditorByTitle("app / src/main.ts");
    await waitFor(() => expect(screen.queryByText("LSP idle")).not.toBeInTheDocument());

    fireEvent.keyDown(window, { key: "l", ctrlKey: true, altKey: true });

    // AC-FMT-04: capability false is a visible reason, never a silent no-op.
    await waitFor(() => expect(useAppStore.getState().statusMessage).toContain(
      "No formatter provider for typescript is running",
    ));
    expect(caseContext.workspaceTestHarness.lspMocks.lspFormatting).not.toHaveBeenCalled();
    expect(selectCodeWorkspaceUi(
      useCodeWorkspaceStore.getState(),
      "instance-format-no-provider",
    ).openFiles["root:app:src/main.ts"]?.text).toBe("const x=1");
  });
  it("surfaces a provider request failure instead of swallowing it", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-format-provider-failure",
      workspaceInstanceId: "instance-format-provider-failure",
      name: "Format provider failure",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/main.ts" },
    };
    caseContext.workspaceTestHarness.workspaceMocks.workspaceListDir.mockResolvedValue([caseContext.workspaceTestHarness.entry("src", "src", "dir")]);
    caseContext.workspaceTestHarness.workspaceMocks.workspaceReadFile.mockResolvedValue(caseContext.workspaceTestHarness.file("src/main.ts", "const x=1"));
    caseContext.workspaceTestHarness.lspMocks.lspOpenDocument.mockResolvedValue(caseContext.workspaceTestHarness.documentStatus({
      path: "/repo/app/src/main.ts",
      uri: "file:///repo/app/src/main.ts",
      presetId: "typescript-javascript",
      languageId: "typescript",
      displayName: "TypeScript / JavaScript",
      available: true,
      active: true,
      capabilities: caseContext.workspaceTestHarness.defaultCapabilities({ formatting: true, rangeFormatting: true }),
    }));
    caseContext.workspaceTestHarness.lspMocks.lspFormatting.mockRejectedValue(new Error("provider transport failed"));

    caseContext.workspaceTestHarness.renderWorkspace(workspace);
    await findEditorByTitle("app / src/main.ts");
    await waitFor(() => expect(screen.queryByText("LSP idle")).not.toBeInTheDocument());

    fireEvent.keyDown(window, { key: "l", ctrlKey: true, altKey: true });

    await waitFor(() => expect(useAppStore.getState().statusMessage).toContain(
      "Format failed: provider transport failed",
    ));
    expect(selectCodeWorkspaceUi(
      useCodeWorkspaceStore.getState(),
      "instance-format-provider-failure",
    ).openFiles["root:app:src/main.ts"]?.text).toBe("const x=1");
  });
  it("restores a crash snapshot into the live editor without replacing the disk baseline", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-recovery",
      workspaceInstanceId: "instance-recovery",
      name: "Recovery",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/main.ts" },
    };
    caseContext.workspaceTestHarness.workspaceMocks.workspaceListDir.mockResolvedValue([caseContext.workspaceTestHarness.entry("src", "src", "dir")]);
    caseContext.workspaceTestHarness.workspaceMocks.workspaceReadFile.mockResolvedValue(caseContext.workspaceTestHarness.file("src/main.ts", "const value = 1;", { hash: "disk-hash" }));
    window.localStorage.setItem(
      `${WORKSPACE_RECOVERY_STORAGE_PREFIX}:instance-recovery`,
      JSON.stringify([{
        workspaceId: "instance-recovery",
        key: "root:app:src/main.ts",
        ref: { kind: "root", rootId: "app", path: "src/main.ts" },
        path: "src/main.ts",
        text: "const value = 2;",
        savedText: "const value = 1;",
        eol: "LF",
        hash: "disk-hash",
        mtime: 1,
        size: 16,
        capturedAt: Date.now(),
      }]),
    );

    caseContext.workspaceTestHarness.renderWorkspace(workspace);
    await findEditorByTitle("app / src/main.ts");
    await waitFor(() => expect(screen.getByTestId("workspace-recovery-dialog")).toBeInTheDocument());
    expect(await screen.findByTestId("workspace-recovery-dialog")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Recover selected" }));
    await waitFor(() => {
      const recovered = selectCodeWorkspaceUi(
        useCodeWorkspaceStore.getState(),
        "instance-recovery",
      ).openFiles["root:app:src/main.ts"];
      expect(recovered?.text).toBe("const value = 2;");
      expect(recovered?.savedText).toBe("const value = 1;");
      expect(recovered?.hash).toBe("disk-hash");
      expect(recovered?.dirty).toBe(true);
    });
    expect(screen.queryByTestId("workspace-recovery-dialog")).not.toBeInTheDocument();
  });

  it("evaluates the keymap cheat sheet in its modal context: editor-only actions are not runnable there", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app", workspaceId: "ws-cheat-sheet-modal", workspaceInstanceId: "instance-cheat-sheet-modal",
      name: "Cheat sheet modal", roots: [{ id: "app", name: "app", path: "/repo/app", kind: "folder" }],
      looseFiles: [], initialFile: { kind: "root", rootId: "app", path: "notes.txt" },
    };
    caseContext.workspaceTestHarness.workspaceMocks.workspaceListDir.mockResolvedValue([caseContext.workspaceTestHarness.entry("notes.txt", "notes.txt")]);
    caseContext.workspaceTestHarness.workspaceMocks.workspaceReadFile.mockResolvedValue(caseContext.workspaceTestHarness.file("notes.txt", "item\nsecond item\nthird item"));
    const registrationRef: { current: WorkspaceCommandRegistration | null; } = { current: null };
    const onCommandsChange = vi.fn((_tabId: string, next: WorkspaceCommandRegistration | null) => {
      if (next) registrationRef.current = next;
    });
    const rendered = caseContext.workspaceTestHarness.renderWorkspace(workspace, { onCommandsChange });
    await findEditorByTitle("app / notes.txt");
    const content = rendered.container.querySelector<HTMLElement>(".cm-content")!;
    act(() => { content.focus(); });
    await act(async () => {
      await registrationRef.current?.executeAction("workspace.openKeymapCheatsheet");
    });
    fireEvent.change(await screen.findByTestId("keymap-search-input"), { target: { value: "Basic Completion" } });
    expect(screen.getByTestId("keymap-item-editor.basicCompletion")).toBeInTheDocument();
    expect(screen.queryByTestId("keymap-run-editor.basicCompletion")).toBeNull();
    // Workspace actions stay runnable from the cheat sheet.
    fireEvent.change(screen.getByTestId("keymap-search-input"), { target: { value: "Find in Files" } });
    expect(screen.getByTestId("keymap-run-workspace.findInFiles")).toBeInTheDocument();
  });

  it("coalesces editor text publications until the input burst is idle", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-editor-text-batch",
      workspaceInstanceId: "instance-editor-text-batch",
      name: "Editor text batch",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/main.ts" },
    };
    caseContext.workspaceTestHarness.workspaceMocks.workspaceReadFile.mockResolvedValue(caseContext.workspaceTestHarness.file("src/main.ts", "one\ntwo"));

    const rendered = caseContext.workspaceTestHarness.renderWorkspace(workspace);
    await findEditorByTitle("app / src/main.ts");
    const content = rendered.container.querySelector<HTMLElement>(".cm-content");
    expect(content).not.toBeNull();
    const fileKey = "root:app:src/main.ts";
    const getBufferText = () => selectCodeWorkspaceUi(
      useCodeWorkspaceStore.getState(),
      "instance-editor-text-batch",
    ).openFiles[fileKey]?.text;
    const recordUserEdit = vi.spyOn(WorkspaceLocationController.prototype, "recordUserEdit");

    vi.useFakeTimers();
    try {
      fireEvent.keyDown(content!, { key: "d", code: "KeyD", ctrlKey: true });
      expect(getBufferText()).toBe("one\ntwo");
      expect(recordUserEdit).not.toHaveBeenCalled();

      // EDITOR_TEXT_COMMIT_IDLE_DELAY_MS is 220ms — stay under it first.
      act(() => vi.advanceTimersByTime(219));
      expect(getBufferText()).toBe("one\ntwo");
      expect(recordUserEdit).not.toHaveBeenCalled();

      act(() => vi.advanceTimersByTime(1));
      expect(getBufferText()).toBe("one\none\ntwo");
      expect(recordUserEdit).toHaveBeenCalledOnce();
      expect(recordUserEdit).toHaveBeenLastCalledWith(expect.objectContaining({
        line: 1,
        character: 0,
        lineText: "one",
        contextSnippet: "one\none\ntwo",
      }));
    } finally {
      recordUserEdit.mockRestore();
      vi.useRealTimers();
    }
  });
}
