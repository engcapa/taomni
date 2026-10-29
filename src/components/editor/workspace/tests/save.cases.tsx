import { findEditorByTitle, findEditorPanes } from "./editorReadiness";
import { EditorSelection } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { emit } from "@tauri-apps/api/event";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { confirmAppDialog, promptAppDialog } from "../../../../lib/appDialogs";
import type { WorkspaceWriteAck } from "../../../../lib/editor/workspace";
import { useAppStore } from "../../../../stores/appStore";
import { useCodeWorkspaceStatusStore } from "../../../../stores/codeWorkspaceStatusStore";
import { selectCodeWorkspaceUi, useCodeWorkspaceStore } from "../../../../stores/codeWorkspaceStore";
import type { CodeWorkspaceTabInfo } from "../../../../types";
import type { WorkspaceTestFixture } from "../../tests/codeWorkspaceTab/harness";
import { registerAtomicSaveCases } from "./atomicSave.cases";
import { registerSaveRetryCases } from "./saveRetry.cases";

export type registerSaveCasesFixture = Pick<WorkspaceTestFixture, "documentStatus" | "defaultCapabilities" | "workspaceMocks" | "file" | "lspMocks" | "renderWorkspace" | "writeAck" | "entry" | "runtimeState" | "csharpStatus" | "toolbarControl" | "localHistoryMocks" | "saveCommitObservations" | "saveRaceGate" | "clipboardMocks">;

export function registerSaveCases(workspaceTestHarness: registerSaveCasesFixture) {
  it("uses the canonical plan-only result for organize imports on save", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-action-save-plan",
      workspaceInstanceId: "instance-action-save-plan",
      name: "Action save plan",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/main.ts" },
    };
    const initialText = "import { b } from \"./b\";\nimport { a } from \"./a\";\nvalue();\n";
    const dirtyText = `${initialText}// dirty\n`;
    const organizedText = "import { a } from \"./a\";\nimport { b } from \"./b\";\nvalue();\n// dirty\n";
    const status = workspaceTestHarness.documentStatus({
      path: "/repo/app/src/main.ts",
      uri: "file:///repo/app/src/main.ts",
      presetId: "typescript-javascript",
      languageId: "typescript",
      displayName: "TypeScript / JavaScript",
      available: true,
      active: true,
      capabilities: workspaceTestHarness.defaultCapabilities({ codeAction: true }),
    });
    window.localStorage.setItem("taomni.codeWorkspace.codeStyle.schemes.v1", JSON.stringify({
      schemes: [{
        schemaVersion: 3,
        id: "save-actions",
        name: "Save actions",
        languageId: "ts",
        basedOn: null,
        values: {},
        saveActions: { format: false, organizeImports: true, rearrange: false, cleanup: false },
        exclusions: { patterns: [], formatterMarkers: true },
      }],
      activeByLanguage: { ts: "save-actions" },
    }));
    workspaceTestHarness.workspaceMocks.workspaceReadFile.mockResolvedValue(workspaceTestHarness.file("src/main.ts", initialText));
    workspaceTestHarness.lspMocks.lspOpenDocument.mockResolvedValue(status);
    workspaceTestHarness.lspMocks.lspChangeDocument.mockResolvedValue(status);
    workspaceTestHarness.lspMocks.lspSaveDocument.mockResolvedValue(status);
    workspaceTestHarness.lspMocks.lspGetDiagnostics.mockResolvedValue({ status, diagnostics: [] });
    workspaceTestHarness.lspMocks.lspCodeActions.mockResolvedValue({
      status,
      actions: [{
        title: "Organize Imports",
        kind: "source.organizeImports",
        isPreferred: true,
        edit: {
          documentEdits: [{
            uri: "file:///repo/app/src/main.ts",
            path: "/repo/app/src/main.ts",
            edits: [{
              range: { start: { line: 0, character: 0 }, end: { line: 2, character: 0 } },
              newText: "import { a } from \"./a\";\nimport { b } from \"./b\";\n",
            }],
          }],
        },
        command: null,
        commandArguments: null,
        raw: null,
      }],
    });
    let releaseWrite!: (ack: WorkspaceWriteAck) => void;
    workspaceTestHarness.workspaceMocks.workspaceWriteFileEncoded.mockImplementation(() => new Promise((resolve) => {
      releaseWrite = resolve;
    }));

    const rendered = workspaceTestHarness.renderWorkspace(workspace);
    await findEditorByTitle("app / src/main.ts");
    const content = rendered.container.querySelector<HTMLElement>(".cm-content");
    expect(content).not.toBeNull();
    const view = EditorView.findFromDOM(content!);
    expect(view).not.toBeNull();
    act(() => {
      view!.dispatch({ changes: { from: view!.state.doc.length, insert: "// dirty\n" } });
    });
    await waitFor(() => expect(selectCodeWorkspaceUi(
      useCodeWorkspaceStore.getState(),
      "instance-action-save-plan",
    ).openFiles["root:app:src/main.ts"]?.text).toBe(dirtyText));

    fireEvent.keyDown(window, { key: "s", code: "KeyS", ctrlKey: true });
    await waitFor(() => expect(workspaceTestHarness.lspMocks.lspCodeActions).toHaveBeenCalledWith(
      expect.objectContaining({ filePath: "src/main.ts" }),
      expect.anything(),
      [],
      ["source.organizeImports"],
    ));
    await waitFor(() => expect(workspaceTestHarness.workspaceMocks.workspaceWriteFileEncoded).toHaveBeenCalledWith(
      "/repo/app",
      "src/main.ts",
      organizedText,
      "hash-src/main.ts",
      "UTF-8",
      false,
    ));
    expect(selectCodeWorkspaceUi(
      useCodeWorkspaceStore.getState(),
      "instance-action-save-plan",
    ).openFiles["root:app:src/main.ts"]?.text).toBe(dirtyText);
    expect(workspaceTestHarness.lspMocks.lspExecuteCommand).not.toHaveBeenCalled();

    await act(async () => {
      releaseWrite(workspaceTestHarness.writeAck(workspaceTestHarness.file("src/main.ts", organizedText, { hash: "hash-organized" })));
      await Promise.resolve();
    });
    await waitFor(() => expect(selectCodeWorkspaceUi(
      useCodeWorkspaceStore.getState(),
      "instance-action-save-plan",
    ).openFiles["root:app:src/main.ts"]?.dirty).toBe(false));

    workspaceTestHarness.lspMocks.lspCodeActions.mockRejectedValueOnce(new Error("provider transport failed"));
    const currentContent = rendered.container.querySelector<HTMLElement>(".cm-content");
    const currentView = currentContent ? EditorView.findFromDOM(currentContent) : null;
    expect(currentView).not.toBeNull();
    act(() => {
      currentView!.dispatch({
        changes: { from: currentView!.state.doc.length, insert: "// second save\n" },
      });
    });
    const secondText = `${dirtyText}// second save\n`;
    await waitFor(() => expect(selectCodeWorkspaceUi(
      useCodeWorkspaceStore.getState(),
      "instance-action-save-plan",
    ).openFiles["root:app:src/main.ts"]?.text).toBe(secondText));

    fireEvent.keyDown(window, { key: "s", code: "KeyS", ctrlKey: true });
    await waitFor(() => expect(workspaceTestHarness.workspaceMocks.workspaceWriteFileEncoded).toHaveBeenCalledTimes(2));
    expect(workspaceTestHarness.workspaceMocks.workspaceWriteFileEncoded).toHaveBeenLastCalledWith(
      "/repo/app",
      "src/main.ts",
      secondText,
      "hash-organized",
      "UTF-8",
      false,
    );
    expect(workspaceTestHarness.lspMocks.lspExecuteCommand).not.toHaveBeenCalled();

    await act(async () => {
      releaseWrite(workspaceTestHarness.writeAck(workspaceTestHarness.file("src/main.ts", secondText, { hash: "hash-second-save" })));
      await Promise.resolve();
    });
    await waitFor(() => expect(useAppStore.getState().statusMessage).toContain(
      "save action issue: Organize imports: Code action request failed: provider transport failed",
    ));
  });
  it("ED-PARITY-007 organize imports on save reports provider failure but still saves", async () => {
    const instanceId = "instance-parity007-save-action";
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-parity007-save-action",
      workspaceInstanceId: instanceId,
      name: "Parity 007 save action",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/main.ts" },
    };
    const initialText = "import { b } from \"./b\";\nvalue();\n";
    const dirtyText = initialText + "// dirty\n";
    const status = workspaceTestHarness.documentStatus({
      path: "/repo/app/src/main.ts",
      uri: "file:///repo/app/src/main.ts",
      presetId: "typescript-javascript",
      languageId: "typescript",
      displayName: "TypeScript / JavaScript",
      available: true,
      active: true,
      capabilities: workspaceTestHarness.defaultCapabilities({ codeAction: true }),
    });
    window.localStorage.setItem("taomni.codeWorkspace.codeStyle.schemes.v1", JSON.stringify({
      schemes: [{
        schemaVersion: 3,
        id: "save-actions",
        name: "Save actions",
        languageId: "ts",
        basedOn: null,
        values: {},
        saveActions: { format: false, organizeImports: true, rearrange: false, cleanup: false },
        exclusions: { patterns: [], formatterMarkers: true },
      }],
      activeByLanguage: { ts: "save-actions" },
    }));
    workspaceTestHarness.workspaceMocks.workspaceReadFile.mockResolvedValue(workspaceTestHarness.file("src/main.ts", initialText));
    workspaceTestHarness.workspaceMocks.workspaceWriteFileEncoded.mockImplementation(async (
      _root: string,
      path: string,
      text: string,
    ) => workspaceTestHarness.writeAck(workspaceTestHarness.file(path, text, { hash: "hash-" + text })));
    workspaceTestHarness.lspMocks.lspOpenDocument.mockResolvedValue(status);
    workspaceTestHarness.lspMocks.lspChangeDocument.mockResolvedValue(status);
    workspaceTestHarness.lspMocks.lspSaveDocument.mockResolvedValue(status);
    workspaceTestHarness.lspMocks.lspGetDiagnostics.mockResolvedValue({ status, diagnostics: [] });
    workspaceTestHarness.lspMocks.lspCodeActions.mockRejectedValue(new Error("provider transport failed"));

    const rendered = workspaceTestHarness.renderWorkspace(workspace);
    await findEditorByTitle("app / src/main.ts");
    const content = rendered.container.querySelector<HTMLElement>(".cm-content");
    expect(content).not.toBeNull();
    const view = EditorView.findFromDOM(content!)!;
    act(() => {
      view.dispatch({ changes: { from: view.state.doc.length, insert: "// dirty\n" } });
    });
    await waitFor(() => expect(selectCodeWorkspaceUi(
      useCodeWorkspaceStore.getState(),
      instanceId,
    ).openFiles["root:app:src/main.ts"]?.text).toBe(dirtyText));

    fireEvent.keyDown(window, { key: "s", code: "KeyS", ctrlKey: true });
    // The provider failure is reported truthfully...
    await waitFor(() => expect(useAppStore.getState().statusMessage).toContain(
      "save action issue: Organize imports: Code action request failed: provider transport failed",
    ));
    // ...and the save itself still wrote the live buffer bytes.
    await waitFor(() => expect(workspaceTestHarness.workspaceMocks.workspaceWriteFileEncoded).toHaveBeenCalledWith(
      "/repo/app",
      "src/main.ts",
      dirtyText,
      "hash-src/main.ts",
      "UTF-8",
      false,
    ));
    await waitFor(() => expect(selectCodeWorkspaceUi(
      useCodeWorkspaceStore.getState(),
      instanceId,
    ).openFiles["root:app:src/main.ts"]?.dirty).toBe(false));
    expect(workspaceTestHarness.lspMocks.lspExecuteCommand).not.toHaveBeenCalled();
  });
  it("persists the workspace format-on-save switch and saves formatted text", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-format-on-save",
      workspaceInstanceId: "instance-format-on-save",
      name: "Format on save",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/main.ts" },
    };
    const capabilities = {
      completion: false,
      signatureHelp: false,
      hover: true,
      definition: true,
      typeDefinition: false,
      implementation: false,
      references: true,
      documentSymbol: true,
      workspaceSymbol: false,
      rename: false,
      formatting: true,
      rangeFormatting: true,
      codeAction: false,
      documentHighlight: false,
      callHierarchy: false,
      typeHierarchy: false,
      inlayHint: false,
      selectionRange: false,
      semanticTokens: false,
      completionTriggerCharacters: [],
      signatureTriggerCharacters: [],
    };
    workspaceTestHarness.workspaceMocks.workspaceListDir.mockResolvedValue([workspaceTestHarness.entry("src", "src", "dir")]);
    workspaceTestHarness.workspaceMocks.workspaceReadFile.mockResolvedValue(workspaceTestHarness.file("src/main.ts", "const x=1"));
    workspaceTestHarness.lspMocks.lspOpenDocument.mockResolvedValue(workspaceTestHarness.documentStatus({
      path: "/repo/app/src/main.ts",
      uri: "file:///repo/app/src/main.ts",
      presetId: "typescript-javascript",
      languageId: "typescript",
      displayName: "TypeScript / JavaScript",
      available: true,
      active: true,
      capabilities,
    }));
    workspaceTestHarness.lspMocks.lspFormatting
      .mockResolvedValueOnce({
        status: workspaceTestHarness.documentStatus({ active: true, available: true, capabilities }),
        edits: [{
          range: {
            start: { line: 0, character: 7 },
            end: { line: 0, character: 7 },
          },
          newText: " ",
        }],
      })
      .mockResolvedValueOnce({
        status: workspaceTestHarness.documentStatus({ active: true, available: true, capabilities }),
        edits: [{
          range: {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 0 },
          },
          newText: "// formatted\n",
        }],
      });
    workspaceTestHarness.workspaceMocks.workspaceWriteFileEncoded.mockResolvedValue(workspaceTestHarness.writeAck(workspaceTestHarness.file(
      "src/main.ts",
      "// formatted\nconst x =1",
      { hash: "hash-formatted" },
    )));

    // Format-on-save is a workspace intelligence preference (command / Settings path).
    // Pref-seed before mount so save applies formatting without the old tree checkbox.
    window.localStorage.setItem(
      "taomni.codeWorkspace.intelligence.v1.instance-format-on-save",
      JSON.stringify({ formatOnSave: true }),
    );

    workspaceTestHarness.renderWorkspace(workspace);
    await findEditorByTitle("app / src/main.ts");
    await waitFor(() => expect(screen.queryByText("LSP idle")).not.toBeInTheDocument());

    // Make the buffer dirty through the existing manual formatting path.
    fireEvent.keyDown(window, { key: "l", ctrlKey: true, altKey: true });
    await waitFor(() => expect(workspaceTestHarness.lspMocks.lspFormatting).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByText(/unsaved/)).toBeInTheDocument());

    fireEvent.keyDown(window, { key: "s", ctrlKey: true });
    await waitFor(() => expect(workspaceTestHarness.workspaceMocks.workspaceWriteFileEncoded).toHaveBeenCalledWith(
      "/repo/app",
      "src/main.ts",
      "// formatted\nconst x =1",
      "hash-src/main.ts",
      "UTF-8",
      false,
    ));
    expect(workspaceTestHarness.lspMocks.lspFormatting).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(screen.queryByText(/unsaved/)).not.toBeInTheDocument());
    expect(workspaceTestHarness.lspMocks.lspWorkspaceDidChangeWatchedFiles).toHaveBeenCalledWith(
      "instance-format-on-save",
      [{ path: "/repo/app/src/main.ts", type: 2 }],
    );
  });
  it("preserves unsaved EOL and BOM choices when a save watcher echo arrives", async () => {
    workspaceTestHarness.runtimeState.tauri = true;
    const instance = "instance-watcher-policy";
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app", workspaceId: "ws-watcher-policy",
      workspaceInstanceId: instance, name: "Watcher policy",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [], initialFile: { kind: "root", rootId: "app", path: "src/main.ts" },
    };
    workspaceTestHarness.workspaceMocks.workspaceListDir.mockResolvedValue([workspaceTestHarness.entry("src", "src", "dir")]);
    workspaceTestHarness.workspaceMocks.workspaceReadFile.mockResolvedValue(workspaceTestHarness.file("src/main.ts", "first\nsecond", {
      hash: "watcher-original", encoding: "UTF-8", bom: false,
    }));
    workspaceTestHarness.renderWorkspace(workspace);
    await findEditorByTitle("app / src/main.ts");
    const key = "root:app:src/main.ts";
    const current = () => selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), instance).openFiles[key];
    await waitFor(() => expect(current()?.text).toBe("first\nsecond"));
    await waitFor(() => expect(useCodeWorkspaceStatusStore.getState().actions?.cycleEol).toBeDefined());
    act(() => {
      useCodeWorkspaceStatusStore.getState().actions?.cycleEol?.();
      useCodeWorkspaceStatusStore.getState().actions?.toggleBom?.();
    });
    await waitFor(() => expect(current()).toMatchObject({ eol: "CRLF", bom: true, dirty: true }));
    workspaceTestHarness.workspaceMocks.workspaceReadFile.mockResolvedValue(workspaceTestHarness.file("src/main.ts", "first\nsecond", {
      hash: "watcher-refreshed", encoding: "UTF-8", bom: false,
    }));
    await act(async () => {
      await emit("lsp://external-file-change", { workspaceId: instance, path: "/repo/app/src/main.ts", type: 2 });
    });
    await waitFor(() => expect(current()?.hash).toBe("watcher-refreshed"));
    expect(current()).toMatchObject({ eol: "CRLF", bom: true, dirty: true, text: "first\nsecond" });
  });
  it("queues an external dirty-buffer conflict and applies a merge against the latest disk hash", async () => {
    workspaceTestHarness.runtimeState.tauri = true;
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-external-conflict",
      workspaceInstanceId: "instance-external-conflict",
      name: "External conflict",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/main.ts" },
    };
    let disk = workspaceTestHarness.file("src/main.ts", "const value = 1;", { hash: "hash-base" });
    workspaceTestHarness.workspaceMocks.workspaceListDir.mockResolvedValue([workspaceTestHarness.entry("src", "src", "dir")]);
    workspaceTestHarness.workspaceMocks.workspaceReadFile.mockImplementation(async () => disk);

    workspaceTestHarness.renderWorkspace(workspace);
    await findEditorByTitle("app / src/main.ts");
    const key = "root:app:src/main.ts";
    await waitFor(() => expect(
      selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "instance-external-conflict")
        .openFiles[key]?.text,
    ).toBe("const value = 1;"));

    act(() => {
      useCodeWorkspaceStore.getState().updateOpenFiles(
        "instance-external-conflict",
        (current) => ({
          ...current,
          [key]: {
            ...current[key]!,
            text: "const value = 2;",
            dirty: true,
          },
        }),
      );
    });
    disk = workspaceTestHarness.file("src/main.ts", "const value = 3;", { hash: "hash-external" });
    await act(async () => {
      await emit("lsp://external-file-change", {
        workspaceId: "instance-external-conflict",
        path: "/repo/app/src/main.ts",
        type: 2,
      });
    });

    expect(await screen.findByTestId("external-file-conflict-dialog")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Merge" }));
    fireEvent.change(await screen.findByRole("textbox", { name: "Merge result" }, { timeout: 5000 }), {
      target: { value: "const value = 4;" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Apply Merge" }));

    await waitFor(() => {
      const merged = selectCodeWorkspaceUi(
        useCodeWorkspaceStore.getState(),
        "instance-external-conflict",
      ).openFiles[key];
      expect(merged?.text).toBe("const value = 4;");
      expect(merged?.savedText).toBe("const value = 3;");
      expect(merged?.hash).toBe("hash-external");
      expect(merged?.dirty).toBe(true);
    });
    expect(screen.queryByTestId("external-file-conflict-dialog")).not.toBeInTheDocument();
  });
  it("ED-AUDIT-009: split close keeps survivor history, dirty cancel is zero effect, reopen reads saved bytes", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-audit009-close",
      workspaceInstanceId: "instance-audit009-close",
      name: "Audit009 Close",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "folder" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/main.ts" },
    };
    workspaceTestHarness.workspaceMocks.workspaceReadFile.mockImplementation(async (_root: string, _path: string) => (
      workspaceTestHarness.file("src/main.ts", "alpha\nbeta\n")
    ));
    workspaceTestHarness.lspMocks.lspDetectServers.mockResolvedValue([workspaceTestHarness.csharpStatus({ available: true, active: true })]);
    workspaceTestHarness.lspMocks.lspOpenDocument.mockResolvedValue(workspaceTestHarness.documentStatus({ available: true, active: true }));

    workspaceTestHarness.renderWorkspace(workspace);
    await screen.findAllByTitle("app / src/main.ts");
    await waitFor(() => expect(workspaceTestHarness.lspMocks.lspOpenDocument).toHaveBeenCalledTimes(1));

    fireEvent.click(workspaceTestHarness.toolbarControl("code-workspace-split-right"));
    await waitFor(() => expect(screen.getAllByTestId("code-workspace-editor-pane")).toHaveLength(2));

    const panes = await findEditorPanes();
    const primaryPane = panes.find((pane) => pane.getAttribute("data-editor-group-id") === "primary")!;
    // A live split generates a fresh leaf id for the new pane (unlike the
    // seeded V1 snapshot's "secondary"), so select it by set difference.
    const splitPane = panes.find((pane) => pane.getAttribute("data-editor-group-id") !== "primary")!;
    const primaryView = EditorView.findFromDOM(primaryPane.querySelector<HTMLElement>(".cm-editor")!)!;
    const splitView = EditorView.findFromDOM(splitPane.querySelector<HTMLElement>(".cm-editor")!)!;

    // A dirty edit in the primary leaf reaches the split leaf.
    primaryView.dispatch({ changes: { from: 0, to: 0, insert: "DIRTY;" } });
    await waitFor(() => expect(splitView.state.doc.toString()).toBe("DIRTY;alpha\nbeta\n"));

    // Close the primary tab: the other leaf still holds the buffer, so no
    // discard confirm appears, no didClose fires, and nothing is written.
    // The emptied leaf keeps rendering (it loses only its tab strip entry).
    fireEvent.click(within(primaryPane).getByTitle("Close"));
    await waitFor(() => expect(
      within(primaryPane).queryByTitle("app / src/main.ts"),
    ).not.toBeInTheDocument());
    expect(workspaceTestHarness.lspMocks.lspCloseDocument).not.toHaveBeenCalled();
    expect(confirmAppDialog).not.toHaveBeenCalled();
    expect(workspaceTestHarness.workspaceMocks.workspaceWriteFile).not.toHaveBeenCalled();

    // Re-resolve the survivor: the leaf that still holds the tab.
    const survivorPane = screen.getAllByTestId("code-workspace-editor-pane").find(
      (pane) => within(pane).queryByTitle("app / src/main.ts") !== null,
    )!;
    const survivorView = EditorView.findFromDOM(survivorPane.querySelector<HTMLElement>(".cm-editor")!)!;
    expect(survivorView.state.doc.toString()).toBe("DIRTY;alpha\nbeta\n");
    // History strokes go through the editor surface (.cm-content): a pane-div
    // target resolves as workspace focus and the requiresEditor history
    // actions are rejected before the shared owner is consulted.
    const survivorContent = () => survivorPane.querySelector<HTMLElement>(".cm-content")!;

    // The survivor keeps the shared history: undo reverts the pre-close edit.
    fireEvent.keyDown(survivorContent(), { key: "z", ctrlKey: true });
    await waitFor(() => expect(survivorView.state.doc.toString()).toBe("alpha\nbeta\n"));
    // Redo makes the buffer dirty again for the cancel segment.
    fireEvent.keyDown(survivorContent(), { key: "z", ctrlKey: true, shiftKey: true });
    await waitFor(() => expect(survivorView.state.doc.toString()).toBe("DIRTY;alpha\nbeta\n"));

    // Close the LAST dirty view: cancel must have zero effect.
    vi.mocked(confirmAppDialog).mockImplementationOnce(async () => false);
    fireEvent.click(within(survivorPane).getByTitle("Close"));
    await waitFor(() => expect(vi.mocked(confirmAppDialog)).toHaveBeenCalledTimes(1));
    expect(within(survivorPane).getByTitle("app / src/main.ts")).toBeInTheDocument();
    expect(survivorView.state.doc.toString()).toBe("DIRTY;alpha\nbeta\n");
    expect(workspaceTestHarness.workspaceMocks.workspaceWriteFile).not.toHaveBeenCalled();
    expect(workspaceTestHarness.lspMocks.lspCloseDocument).not.toHaveBeenCalled();

    // Confirming the discard closes the last view — still without writing.
    fireEvent.click(within(survivorPane).getByTitle("Close"));
    await waitFor(() => expect(workspaceTestHarness.lspMocks.lspCloseDocument).toHaveBeenCalledTimes(1));
    expect(screen.queryByTitle("app / src/main.ts")).not.toBeInTheDocument();
    expect(workspaceTestHarness.workspaceMocks.workspaceWriteFile).not.toHaveBeenCalled();

    // Reopen (Ctrl+Shift+T) reads the saved disk bytes: the discarded dirty
    // text is not revived and the read is a fresh decode of the same file.
    fireEvent.keyDown(window, { key: "T", ctrlKey: true, shiftKey: true });
    const reopened = await findEditorByTitle("app / src/main.ts");
    expect(reopened).toBeInTheDocument();
    await waitFor(() => expect(
      EditorView.findFromDOM(
        screen.getAllByTestId("code-workspace-editor-pane")
          .find((pane) => within(pane).queryByTitle("app / src/main.ts") !== null)!
          .querySelector<HTMLElement>(".cm-editor")!,
      )!.state.doc.toString(),
    ).toBe("alpha\nbeta\n"));
    expect(workspaceTestHarness.workspaceMocks.workspaceWriteFile).not.toHaveBeenCalled();
  });
  it("sets mnemonic bookmarks through the mounted prompt and replaces conflicts", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-mnemonic-mounted",
      workspaceInstanceId: "instance-mnemonic-mounted",
      name: "Mnemonic bookmarks",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/main.ts" },
    };
    workspaceTestHarness.workspaceMocks.workspaceReadFile.mockResolvedValue(workspaceTestHarness.file(
      "src/main.ts",
      "const first = 1;\nconst second = 2;\n",
    ));

    const rendered = workspaceTestHarness.renderWorkspace(workspace);
    const content = await findEditorByTitle("app / src/main.ts").then(() => (
      screen.getByTestId("code-workspace-editor").querySelector<HTMLElement>(".cm-content")
    ));
    expect(content).not.toBeNull();
    const cmEditor = content?.closest<HTMLElement>(".cm-editor");
    expect(cmEditor).not.toBeNull();
    const view = EditorView.findFromDOM(cmEditor!);
    expect(view).not.toBeNull();

    vi.mocked(promptAppDialog).mockResolvedValueOnce("a");
    fireEvent.keyDown(content!, { key: "F11", code: "F11", ctrlKey: true });

    const panel = await screen.findByTestId("code-workspace-todos-panel");
    // setMnemonicBookmark writes localStorage synchronously and only then dispatches
    // replaceBookmarks, so the persisted value becomes observable one React commit
    // before the panel re-renders. Gating on storage alone and asserting the DOM
    // afterwards therefore reads a fact the gate never waited for. Both facts are
    // asserted under the same gate so the wait covers the later one too.
    await waitFor(() => {
      const saved = JSON.parse(
        window.localStorage.getItem("taomni.codeWorkspace.bookmarks.v1.instance-mnemonic-mounted") ?? "[]",
      ) as Array<{ line: number; mnemonic: string | null; group: string | null; }>;
      expect(saved).toHaveLength(1);
      expect(saved[0]).toMatchObject({ line: 0, mnemonic: "A", group: "Mnemonic" });
      expect(panel).toHaveTextContent("A");
    });
    expect(promptAppDialog).toHaveBeenCalledWith(expect.objectContaining({
      title: "Set Bookmark Mnemonic",
      label: "Mnemonic (0-9 or A-Z)",
    }));

    view!.dispatch({ selection: EditorSelection.cursor(view!.state.doc.line(2).from) });
    vi.mocked(promptAppDialog).mockResolvedValueOnce("A");
    fireEvent.keyDown(content!, { key: "F11", code: "F11", ctrlKey: true });

    await waitFor(() => {
      const saved = JSON.parse(
        window.localStorage.getItem("taomni.codeWorkspace.bookmarks.v1.instance-mnemonic-mounted") ?? "[]",
      ) as Array<{ line: number; mnemonic: string | null; }>;
      expect(saved).toHaveLength(2);
      expect(saved.find((bookmark) => bookmark.line === 0)?.mnemonic).toBeNull();
      expect(saved.find((bookmark) => bookmark.line === 1)?.mnemonic).toBe("A");
      // Same ordering hazard as above: this is the row count the storage gate does
      // not imply, so it belongs inside the gate.
      expect(screen.getAllByTestId("code-workspace-bookmark-open")).toHaveLength(2);
    });
    rendered.unmount();
  });
  it("opens the encoding chooser from workspace status and saves through the encoded writer", async () => {
    workspaceTestHarness.runtimeState.tauri = true;
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-encoding-save",
      workspaceInstanceId: "instance-encoding-save",
      name: "Encoding Save",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/main.txt" },
    };
    workspaceTestHarness.workspaceMocks.workspaceReadFile.mockResolvedValue(workspaceTestHarness.file(
      "src/main.txt",
      "café",
      { encoding: "UTF-8", bom: false },
    ));
    workspaceTestHarness.workspaceMocks.workspaceWriteFileEncoded.mockResolvedValue(workspaceTestHarness.writeAck(workspaceTestHarness.file(
      "src/main.txt",
      "café",
      { encoding: "windows-1252", bom: false, hash: "hash-latin1" },
    )));

    workspaceTestHarness.renderWorkspace(workspace);
    await findEditorByTitle("app / src/main.txt");
    await waitFor(() => expect(useCodeWorkspaceStatusStore.getState().actions?.chooseEncoding)
      .toBeTypeOf("function"));

    act(() => useCodeWorkspaceStatusStore.getState().actions?.chooseEncoding?.());
    expect(await screen.findByTestId("file-encoding-dialog")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Encoding"), { target: { value: "ISO-8859-1" } });
    fireEvent.click(screen.getByRole("button", { name: "Convert on Save" }));

    await waitFor(() => expect(
      selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "instance-encoding-save")
        .openFiles["root:app:src/main.txt"]?.dirty,
    ).toBe(true));
    fireEvent.keyDown(window, { key: "s", code: "KeyS", ctrlKey: true });

    await waitFor(() => expect(workspaceTestHarness.workspaceMocks.workspaceWriteFileEncoded).toHaveBeenCalledWith(
      "/repo/app",
      "src/main.txt",
      "café",
      "hash-src/main.txt",
      "ISO-8859-1",
      false,
    ));
    expect(workspaceTestHarness.workspaceMocks.workspaceWriteFile).not.toHaveBeenCalled();
    await waitFor(() => expect(
      selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "instance-encoding-save")
        .openFiles["root:app:src/main.txt"]?.dirty,
    ).toBe(false));
    expect(
      selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "instance-encoding-save")
        .openFiles["root:app:src/main.txt"]?.encoding,
    ).toBe("ISO-8859-1");

    // The watcher reads the same saved bytes using the decoder's canonical
    // label. It must not overwrite the user's chosen encoding after save.
    workspaceTestHarness.workspaceMocks.workspaceReadFileWithEncoding.mockResolvedValue(workspaceTestHarness.file("src/main.txt", "café", {
      encoding: "windows-1252", bom: false, hash: "hash-latin1", mtime: 12345,
    }));
    await act(async () => {
      await emit("lsp://external-file-change", {
        workspaceId: "instance-encoding-save", path: "/repo/app/src/main.txt", type: 2,
      });
    });
    await waitFor(() => expect(
      selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "instance-encoding-save")
        .openFiles["root:app:src/main.txt"]?.mtime,
    ).toBe(12345));
    expect(
      selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "instance-encoding-save")
        .openFiles["root:app:src/main.txt"],
    ).toMatchObject({ encoding: "ISO-8859-1", dirty: false });
  });
  it("opens a queued encoding chooser after an in-flight save settles", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-encoding-save-race",
      workspaceInstanceId: "instance-encoding-save-race",
      name: "Encoding Save Race",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/main.txt" },
    };
    workspaceTestHarness.workspaceMocks.workspaceReadFile.mockResolvedValue(workspaceTestHarness.file("src/main.txt", "before\n"));
    let resolveWrite!: (ack: WorkspaceWriteAck) => void;
    workspaceTestHarness.workspaceMocks.workspaceWriteFileEncoded.mockImplementation(() => new Promise((resolve) => {
      resolveWrite = resolve;
    }));

    const rendered = workspaceTestHarness.renderWorkspace(workspace);
    await findEditorByTitle("app / src/main.txt");
    const content = rendered.container.querySelector<HTMLElement>(".cm-content");
    expect(content).not.toBeNull();
    fireEvent.keyDown(content!, { key: "d", code: "KeyD", ctrlKey: true });
    await waitFor(() => expect(selectCodeWorkspaceUi(
      useCodeWorkspaceStore.getState(),
      "instance-encoding-save-race",
    ).openFiles["root:app:src/main.txt"]?.dirty).toBe(true));

    fireEvent.keyDown(window, { key: "s", code: "KeyS", ctrlKey: true });
    await waitFor(() => expect(selectCodeWorkspaceUi(
      useCodeWorkspaceStore.getState(),
      "instance-encoding-save-race",
    ).openFiles["root:app:src/main.txt"]?.saving).toBe(true));
    act(() => useCodeWorkspaceStatusStore.getState().actions?.chooseEncoding?.());
    expect(screen.queryByTestId("file-encoding-dialog")).toBeNull();

    await act(async () => {
      resolveWrite(workspaceTestHarness.writeAck(workspaceTestHarness.file("src/main.txt", "before\nbefore\n", { hash: "hash-saved" })));
    });
    expect(await screen.findByTestId("file-encoding-dialog")).toBeInTheDocument();
  });
  it("reloads the active file with an explicit encoding from the status action", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-encoding-reload",
      workspaceInstanceId: "instance-encoding-reload",
      name: "Encoding Reload",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/legacy.txt" },
    };
    workspaceTestHarness.workspaceMocks.workspaceReadFile.mockResolvedValue(workspaceTestHarness.file(
      "src/legacy.txt",
      "caf\u00E9",
      { encoding: "windows-1252", bom: false },
    ));
    workspaceTestHarness.workspaceMocks.workspaceReadFileWithEncoding.mockResolvedValue(workspaceTestHarness.file(
      "src/legacy.txt",
      "caf\u00E9",
      { encoding: "UTF-16LE", bom: true, hash: "hash-utf16" },
    ));

    workspaceTestHarness.renderWorkspace(workspace);
    await findEditorByTitle("app / src/legacy.txt");
    await waitFor(() => expect(useCodeWorkspaceStatusStore.getState().actions?.chooseEncoding)
      .toBeTypeOf("function"));
    act(() => useCodeWorkspaceStatusStore.getState().actions?.chooseEncoding?.());
    await screen.findByTestId("file-encoding-dialog");

    fireEvent.change(screen.getByLabelText("Encoding"), { target: { value: "UTF-16LE" } });
    fireEvent.click(screen.getByRole("button", { name: "Reload from Disk" }));

    await waitFor(() => expect(workspaceTestHarness.workspaceMocks.workspaceReadFileWithEncoding).toHaveBeenCalledWith(
      "/repo/app",
      "src/legacy.txt",
      "UTF-16LE",
    ));
    await waitFor(() => {
      const open = selectCodeWorkspaceUi(
        useCodeWorkspaceStore.getState(),
        "instance-encoding-reload",
      ).openFiles["root:app:src/legacy.txt"];
      expect(open?.encoding).toBe("UTF-16LE");
      expect(open?.bom).toBe(true);
      expect(open?.dirty).toBe(false);
    });
    expect(screen.queryByTestId("file-encoding-dialog")).toBeNull();
  });
  registerAtomicSaveCases(workspaceTestHarness);
  registerSaveRetryCases(workspaceTestHarness);
}
