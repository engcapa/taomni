import { EditorView } from "@codemirror/view";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { useAppStore } from "../../../../../../stores/appStore";
import { selectCodeWorkspaceUi, useCodeWorkspaceStore } from "../../../../../../stores/codeWorkspaceStore";
import type { CodeWorkspaceTabInfo } from "../../../../../../types";
import { type registerInteractionCasesFixture } from "../../interaction.cases";

export interface registerinteractionEditing3CasesContext {
  workspaceTestHarness: registerInteractionCasesFixture;
}

export function registerinteractionEditing3Cases(caseContext: registerinteractionEditing3CasesContext) {
  it("reports a retryable resolve failure with zero effect when resolve returns null", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-actions-resolvefail",
      workspaceInstanceId: "instance-actions-resolvefail",
      name: "Actions",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/main.ts" },
    };
    caseContext.workspaceTestHarness.workspaceMocks.workspaceListDir.mockResolvedValue([caseContext.workspaceTestHarness.entry("src", "src", "dir")]);
    caseContext.workspaceTestHarness.workspaceMocks.workspaceReadFile.mockResolvedValue(caseContext.workspaceTestHarness.file("src/main.ts", "x=1"));
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
        title: "Vanishing fix",
        kind: "quickfix",
        isPreferred: true,
        edit: null,
        command: null,
        commandArguments: null,
        raw: { title: "Vanishing fix", data: { fixId: "vanish" } },
      }],
    });
    caseContext.workspaceTestHarness.lspMocks.lspCodeActionResolve.mockResolvedValue({
      status: caseContext.workspaceTestHarness.documentStatus({ available: true, active: true }),
      action: null,
    });

    caseContext.workspaceTestHarness.renderWorkspace(workspace);
    await screen.findByTitle("app / src/main.ts");
    await waitFor(() => expect(screen.queryByText("LSP idle")).not.toBeInTheDocument());

    fireEvent.keyDown(window, { key: "Enter", altKey: true });
    fireEvent.click(await screen.findByRole("button", { name: "Vanishing fix" }));

    await waitFor(() => expect(useAppStore.getState().statusMessage).toContain("Code action resolve failed:"));
    expect(useAppStore.getState().statusMessage).toContain("Provider returned null on resolve");
    expect(useAppStore.getState().statusMessage).toContain("you can retry");
    // Zero effect: the buffer text is untouched by the failed resolve.
    expect(selectCodeWorkspaceUi(
      useCodeWorkspaceStore.getState(),
      "instance-actions-resolvefail",
    ).openFiles["root:app:src/main.ts"]?.text).toBe("x=1");
  });
  it("keeps a failed Alt+Enter resolve visible and retries the frozen candidate", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-action-retry",
      workspaceInstanceId: "instance-action-retry",
      name: "Action retry",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/main.ts" },
    };
    const status = caseContext.workspaceTestHarness.documentStatus({
      path: "/repo/app/src/main.ts",
      uri: "file:///repo/app/src/main.ts",
      available: true,
      active: true,
      capabilities: caseContext.workspaceTestHarness.defaultCapabilities({ codeAction: true }),
    });
    const deferredAction = {
      title: "Insert retry space",
      kind: "quickfix",
      isPreferred: true,
      edit: null,
      command: null,
      commandArguments: null,
      raw: { title: "Insert retry space", kind: "quickfix", data: { fixId: "retry-space" } },
    };
    const resolvedAction = {
      ...deferredAction,
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
    };
    caseContext.workspaceTestHarness.workspaceMocks.workspaceListDir.mockResolvedValue([caseContext.workspaceTestHarness.entry("src", "src", "dir")]);
    caseContext.workspaceTestHarness.workspaceMocks.workspaceReadFile.mockResolvedValue(caseContext.workspaceTestHarness.file("src/main.ts", "x=1"));
    caseContext.workspaceTestHarness.workspaceMocks.workspaceWriteFileEncoded.mockImplementation(async (
      _rootPath: string,
      path: string,
      text: string,
    ) => caseContext.workspaceTestHarness.writeAck(caseContext.workspaceTestHarness.file(path, text, { hash: `hash-${text}` })));
    caseContext.workspaceTestHarness.lspMocks.lspOpenDocument.mockResolvedValue(status);
    caseContext.workspaceTestHarness.lspMocks.lspCodeActions.mockResolvedValue({ status, actions: [deferredAction] });
    caseContext.workspaceTestHarness.lspMocks.lspCodeActionResolve
      .mockRejectedValueOnce(new Error("resolve transport unavailable"))
      .mockResolvedValueOnce({ status, action: resolvedAction });

    caseContext.workspaceTestHarness.renderWorkspace(workspace);
    await screen.findByTitle("app / src/main.ts");
    await waitFor(() => expect(screen.queryByText("LSP idle")).not.toBeInTheDocument());

    fireEvent.keyDown(window, { key: "Enter", altKey: true });
    fireEvent.click(await screen.findByRole("button", { name: "Insert retry space" }));

    const retry = await screen.findByRole("button", {
      name: /Retry Insert retry space.*resolve transport unavailable/i,
    });
    expect(selectCodeWorkspaceUi(
      useCodeWorkspaceStore.getState(),
      "instance-action-retry",
    ).openFiles["root:app:src/main.ts"]?.text).toBe("x=1");
    expect(caseContext.workspaceTestHarness.lspMocks.lspCodeActionResolve).toHaveBeenCalledTimes(1);

    fireEvent.click(retry);
    await waitFor(() => expect(caseContext.workspaceTestHarness.lspMocks.lspCodeActionResolve).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(selectCodeWorkspaceUi(
      useCodeWorkspaceStore.getState(),
      "instance-action-retry",
    ).openFiles["root:app:src/main.ts"]?.text).toBe("x =1"));
  });
  it("shares frozen candidate identity between Alt+Enter and the gutter lightbulb", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-action-entries",
      workspaceInstanceId: "instance-action-entries",
      name: "Action entries",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/main.ts" },
    };
    const status = caseContext.workspaceTestHarness.documentStatus({
      path: "/repo/app/src/main.ts",
      available: true,
      active: true,
      capabilities: caseContext.workspaceTestHarness.defaultCapabilities({ codeAction: true }),
    });
    const diagnostic = {
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
      severity: 2,
      code: "shared-entry",
      source: "typescript",
      message: "Shared entry diagnostic",
    };
    const action = {
      title: "Use shared candidate",
      kind: "quickfix",
      isPreferred: true,
      edit: { documentEdits: [] },
      command: null,
      commandArguments: null,
      raw: { title: "Use shared candidate", kind: "quickfix" },
    };
    caseContext.workspaceTestHarness.workspaceMocks.workspaceListDir.mockResolvedValue([caseContext.workspaceTestHarness.entry("src", "src", "dir")]);
    caseContext.workspaceTestHarness.workspaceMocks.workspaceReadFile.mockResolvedValue(caseContext.workspaceTestHarness.file("src/main.ts", "x"));
    caseContext.workspaceTestHarness.lspMocks.lspOpenDocument.mockResolvedValue(status);
    caseContext.workspaceTestHarness.lspMocks.lspGetDiagnostics.mockResolvedValue({ status, diagnostics: [diagnostic] });
    caseContext.workspaceTestHarness.lspMocks.lspCodeActions.mockResolvedValue({ status, actions: [action] });

    const rendered = caseContext.workspaceTestHarness.renderWorkspace(workspace);
    await screen.findByTitle("app / src/main.ts");
    await waitFor(() => expect(caseContext.workspaceTestHarness.lspMocks.lspGetDiagnostics).toHaveBeenCalled());
    await waitFor(() => expect(rendered.container.querySelector(
      '[data-testid="code-workspace-lightbulb"]',
    )).toBeTruthy());

    const content = rendered.container.querySelector<HTMLElement>(".cm-content");
    expect(content).toBeTruthy();
    fireEvent.keyDown(content!, { key: "Enter", altKey: true });
    await waitFor(() => expect(caseContext.workspaceTestHarness.lspMocks.lspCodeActions).toHaveBeenCalledTimes(1));
    const keyboardCandidate = await screen.findByRole("button", { name: "Use shared candidate" });
    const keyboardCandidateId = keyboardCandidate.getAttribute("data-testid");
    expect(keyboardCandidateId).toMatch(/^code-workspace-intention-intention\.provider\./);
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("button", { name: "Use shared candidate" })).not.toBeInTheDocument());

    const bulb = rendered.container.querySelector('[data-testid="code-workspace-lightbulb"]');
    expect(bulb).toBeTruthy();
    fireEvent.mouseDown(bulb!);
    const gutterCandidate = await screen.findByRole("button", { name: "Use shared candidate" });
    expect(gutterCandidate.getAttribute("data-testid")).toBe(keyboardCandidateId);
    expect(caseContext.workspaceTestHarness.lspMocks.lspCodeActions).toHaveBeenCalledTimes(2);
  });
  it("keeps Problems and editor context-menu code actions on the frozen target", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-action-frozen-target",
      workspaceInstanceId: "instance-action-frozen-target",
      name: "Action frozen target",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/main.ts" },
    };
    const diagnostic = {
      range: { start: { line: 1, character: 0 }, end: { line: 1, character: 6 } },
      severity: 2,
      code: "shared-problem-entry",
      source: "typescript",
      message: "Target file diagnostic",
    };
    const action = {
      title: "Use target-file candidate",
      kind: "quickfix",
      isPreferred: true,
      edit: { documentEdits: [] },
      command: null,
      commandArguments: null,
      raw: { title: "Use target-file candidate", kind: "quickfix" },
    };
    const statusFor = (filePath: string) => caseContext.workspaceTestHarness.documentStatus({
      path: filePath,
      uri: `file://${filePath}`,
      presetId: "typescript-javascript",
      languageId: "typescript",
      displayName: "TypeScript / JavaScript",
      available: true,
      active: true,
      capabilities: caseContext.workspaceTestHarness.defaultCapabilities({ codeAction: true }),
    });
    window.localStorage.setItem("taomni.codeWorkspace.layout.v1.instance-action-frozen-target", JSON.stringify({
      version: 1,
      splitOrientation: "vertical",
      activeEditorGroupId: "primary",
      editorGroups: {
        primary: {
          openOrder: ["root:app:src/main.ts"],
          activeKey: "root:app:src/main.ts",
          previewKey: null,
          pinnedKeys: [],
        },
        secondary: {
          openOrder: ["root:app:src/util.ts"],
          activeKey: "root:app:src/util.ts",
          previewKey: null,
          pinnedKeys: [],
        },
      },
    }));
    caseContext.workspaceTestHarness.workspaceMocks.workspaceReadFile.mockImplementation(async (_root: string, path: string) => (
      caseContext.workspaceTestHarness.file(path, path === "src/util.ts" ? "first\ntarget" : "main")
    ));
    caseContext.workspaceTestHarness.lspMocks.lspOpenDocument.mockImplementation(async (descriptor: { filePath: string; }) => (
      statusFor(descriptor.filePath)
    ));
    caseContext.workspaceTestHarness.lspMocks.lspGetDiagnostics.mockImplementation(async (descriptor: { filePath: string; }) => ({
      status: statusFor(descriptor.filePath),
      diagnostics: descriptor.filePath.endsWith("src/main.ts") ? [diagnostic] : [],
    }));
    caseContext.workspaceTestHarness.lspMocks.lspCodeActions.mockImplementation(async (descriptor: { filePath: string; }) => ({
      status: statusFor(descriptor.filePath),
      actions: [action],
    }));

    const rendered = caseContext.workspaceTestHarness.renderWorkspace(workspace);
    await screen.findByTitle("app / src/main.ts");
    await screen.findByTitle("app / src/util.ts");
    const panes = screen.getAllByTestId("code-workspace-editor-pane");
    const primaryPane = panes.find((pane) => pane.getAttribute("data-editor-group-id") === "primary");
    const secondaryPane = panes.find((pane) => (
      pane.getAttribute("data-editor-group-id") === "secondary"
    ));
    fireEvent.mouseDown(primaryPane!);
    await waitFor(() => expect(caseContext.workspaceTestHarness.lspMocks.lspOpenDocument).toHaveBeenCalledWith(
      expect.objectContaining({ filePath: "src/main.ts" }),
      "main",
      expect.any(Number),
    ));
    await waitFor(() => expect(caseContext.workspaceTestHarness.lspMocks.lspGetDiagnostics).toHaveBeenCalledWith(
      expect.objectContaining({ filePath: "src/main.ts" }),
    ));
    fireEvent.click(screen.getByTestId("code-workspace-bottom-tab-problems"));
    const problem = await screen.findByRole("button", { name: /Target file diagnostic/ });
    fireEvent.contextMenu(problem, { clientX: 12, clientY: 18 });
    fireEvent.click(screen.getByRole("button", { name: "Quick Fix" }));
    const problemCandidate = await screen.findByRole("button", { name: "Use target-file candidate" });
    const problemCandidateId = problemCandidate.getAttribute("data-testid");
    expect(problemCandidateId).toMatch(/^code-workspace-intention-intention\.provider\./);
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("button", { name: "Use target-file candidate" })).not.toBeInTheDocument());

    const secondaryContent = secondaryPane?.querySelector<HTMLElement>(".cm-content");
    expect(secondaryContent).not.toBeNull();
    const secondaryView = EditorView.findFromDOM(secondaryContent!);
    expect(secondaryView).not.toBeNull();
    act(() => {
      secondaryView!.dispatch({ selection: { anchor: secondaryView!.state.doc.toString().indexOf("target") } });
    });
    vi.spyOn(secondaryView!, "posAtCoords").mockReturnValue(null);
    fireEvent.contextMenu(secondaryContent!, { clientX: 24, clientY: 36, button: 2 });
    fireEvent.click(await screen.findByTestId("editor-context-code-actions"));
    const contextCandidate = await screen.findByRole("button", { name: "Use target-file candidate" });

    expect(contextCandidate.getAttribute("data-testid")).toBe(problemCandidateId);
    expect(caseContext.workspaceTestHarness.lspMocks.lspCodeActions).toHaveBeenCalledTimes(2);
    expect(caseContext.workspaceTestHarness.lspMocks.lspCodeActions).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ filePath: "src/main.ts" }),
      diagnostic.range,
      [expect.objectContaining({ code: diagnostic.code, message: diagnostic.message })],
      undefined,
    );
    expect(caseContext.workspaceTestHarness.lspMocks.lspCodeActions).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ filePath: "src/util.ts" }),
      {
        start: { line: 1, character: 0 },
        end: { line: 1, character: 0 },
      },
      [],
      undefined,
    );
    expect(selectCodeWorkspaceUi(
      useCodeWorkspaceStore.getState(),
      "instance-action-frozen-target",
    ).activeEditorGroupId).toBe("primary");
    expect(rendered.container).toBeInTheDocument();
  });
  it("applies provider Java import quick fixes on Alt+Enter and inserts the import statement", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-java-import",
      workspaceInstanceId: "instance-java-import",
      name: "Java Import",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/Service.java" },
    };
    caseContext.workspaceTestHarness.workspaceMocks.workspaceListDir.mockResolvedValue([caseContext.workspaceTestHarness.entry("src", "src", "dir")]);
    caseContext.workspaceTestHarness.workspaceMocks.workspaceReadFile.mockResolvedValue(caseContext.workspaceTestHarness.file(
      "src/Service.java",
      "class Service { List items; }",
    ));
    const status = caseContext.workspaceTestHarness.documentStatus({
      path: "/repo/app/src/Service.java",
      uri: "file:///repo/app/src/Service.java",
      presetId: "java",
      languageId: "java",
      displayName: "Java",
      available: true,
      active: true,
      capabilities: {
        completion: true,
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
    caseContext.workspaceTestHarness.lspMocks.lspOpenDocument.mockResolvedValue(status);
    caseContext.workspaceTestHarness.lspMocks.lspCodeActions.mockResolvedValue({
      status,
      actions: [{
        title: "Import 'List' (java.util.List)",
        kind: "quickfix",
        isPreferred: true,
        edit: {
          documentEdits: [{
            uri: "file:///repo/app/src/Service.java",
            path: "/repo/app/src/Service.java",
            edits: [{
              range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
              newText: "import java.util.List;\n",
            }],
          }],
        },
        command: null,
        commandArguments: null,
        raw: { title: "Import 'List' (java.util.List)" },
      }],
    });

    caseContext.workspaceTestHarness.renderWorkspace(workspace);
    await screen.findByTitle("app / src/Service.java");
    await waitFor(() => expect(screen.queryByText("LSP idle")).not.toBeInTheDocument());

    // Trigger Alt+Enter
    fireEvent.keyDown(window, { key: "Enter", altKey: true });
    const importOption = await screen.findByRole("button", { name: "Import 'List' (java.util.List)" });
    expect(importOption).toBeInTheDocument();

    fireEvent.click(importOption);

    await waitFor(() => expect(selectCodeWorkspaceUi(
      useCodeWorkspaceStore.getState(),
      "instance-java-import",
    ).openFiles["root:app:src/Service.java"]?.text).toContain("import java.util.List;"));
  });
}
