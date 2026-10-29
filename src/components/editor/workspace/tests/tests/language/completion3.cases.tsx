import { findEditorByTitle } from "../../editorReadiness";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { useAppStore } from "../../../../../../stores/appStore";
import type { CodeWorkspaceTabInfo } from "../../../../../../types";
import type { WorkspaceCommandRegistration } from "../../../workspaceCommands";
import { type registerLanguageCasesFixture } from "../../language.cases";

export interface registerlanguageCompletion3CasesContext {
  workspaceTestHarness: registerLanguageCasesFixture;
}

export function registerlanguageCompletion3Cases(caseContext: registerlanguageCompletion3CasesContext) {
  it("blocks Safe Delete when provider does not attest complete coverage and performs 0 disk writes", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-safe-delete",
      workspaceInstanceId: "instance-safe-delete",
      name: "Safe Delete",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/main.ts" },
    };
    const disk = new Map([
      ["src/main.ts", "const answer = 42;"],
      ["src/use.ts", "use(answer);"],
    ]);
    caseContext.workspaceTestHarness.workspaceMocks.workspaceListDir.mockImplementation(async (_root: string, path = "") => (
      path === "src"
        ? [caseContext.workspaceTestHarness.entry("main.ts", "src/main.ts"), caseContext.workspaceTestHarness.entry("use.ts", "src/use.ts")]
        : []
    ));
    caseContext.workspaceTestHarness.workspaceMocks.workspaceReadFile.mockImplementation(async (_root: string, path: string) => {
      const text = disk.get(path);
      if (text === undefined) throw new Error(`missing fixture ${path}`);
      return caseContext.workspaceTestHarness.file(path, text, { hash: `hash-${path}` });
    });
    caseContext.workspaceTestHarness.workspaceMocks.workspaceWriteFileEncoded.mockImplementation(async (
      _root: string,
      path: string,
      text: string,
    ) => {
      disk.set(path, text);
      return caseContext.workspaceTestHarness.writeAck(caseContext.workspaceTestHarness.file(path, text, { hash: `hash-${path}-${text}` }));
    });
    const capabilities = {
      completion: false,
      signatureHelp: false,
      hover: false,
      definition: true,
      typeDefinition: false,
      implementation: false,
      references: true,
      documentSymbol: false,
      workspaceSymbol: false,
      rename: true,
      formatting: false,
      rangeFormatting: false,
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
    const activeStatus = caseContext.workspaceTestHarness.documentStatus({
      path: "/repo/app/src/main.ts",
      uri: "file:///repo/app/src/main.ts",
      available: true,
      active: true,
      capabilities,
    });
    caseContext.workspaceTestHarness.lspMocks.lspOpenDocument.mockResolvedValue(activeStatus);
    caseContext.workspaceTestHarness.lspMocks.lspChangeDocument.mockResolvedValue(activeStatus);
    caseContext.workspaceTestHarness.lspMocks.lspSaveDocument.mockResolvedValue(activeStatus);
    const declarationRange = {
      start: { line: 0, character: 6 },
      end: { line: 0, character: 12 },
    };
    caseContext.workspaceTestHarness.lspMocks.lspPrepareRename.mockResolvedValue({
      status: activeStatus,
      allowed: true,
      range: declarationRange,
      placeholder: "answer",
      message: null,
    });
    caseContext.workspaceTestHarness.lspMocks.lspDefinition.mockResolvedValue({
      status: activeStatus,
      locations: [{
        uri: "file:///repo/app/src/main.ts",
        path: "/repo/app/src/main.ts",
        range: declarationRange,
      }],
    });
    caseContext.workspaceTestHarness.lspMocks.lspReferences.mockResolvedValue({
      status: activeStatus,
      locations: [
        {
          uri: "file:///repo/app/src/main.ts",
          path: "/repo/app/src/main.ts",
          range: declarationRange,
        },
        {
          uri: "file:///repo/app/src/use.ts",
          path: "/repo/app/src/use.ts",
          range: {
            start: { line: 0, character: 4 },
            end: { line: 0, character: 10 },
          },
        },
      ],
    });
    const registrationRef: { current: WorkspaceCommandRegistration | null; } = { current: null };
    const onCommandsChange = vi.fn((_tabId: string, next: WorkspaceCommandRegistration | null) => {
      if (next) registrationRef.current = next;
    });

    const rendered = caseContext.workspaceTestHarness.renderWorkspace(workspace, { onCommandsChange });
    await findEditorByTitle("app / src/main.ts");
    const content = rendered.container.querySelector<HTMLElement>(".cm-content");
    expect(content).not.toBeNull();
    await waitFor(() => expect(registrationRef.current).not.toBeNull());
    const safeDeleteCmd = registrationRef.current?.items.find((item) => item.id === "workspace.safeDeleteSymbol");
    expect(safeDeleteCmd?.enabled).toBe(false);
    expect(registrationRef.current?.execute("workspace.safeDeleteSymbol")).toBe(false);

    const execResult = await registrationRef.current?.executeAction("workspace.safeDeleteSymbol");
    expect(execResult?.kind).toBe("no-op");
    expect(execResult?.message).toContain("Language provider does not attest complete Safe Delete coverage");
    expect(caseContext.workspaceTestHarness.lspMocks.lspPrepareRename).not.toHaveBeenCalled();
    expect(caseContext.workspaceTestHarness.lspMocks.lspReferences).not.toHaveBeenCalled();
    expect(caseContext.workspaceTestHarness.lspMocks.lspDefinition).not.toHaveBeenCalled();
    expect(caseContext.workspaceTestHarness.workspaceMocks.workspaceWriteFileEncoded).not.toHaveBeenCalled();
    expect(disk.get("src/main.ts")).toBe("const answer = 42;");
    expect(disk.get("src/use.ts")).toBe("use(answer);");
  });
  it("navigates diagnostics with F2 / Shift+F2 and executes parameter info, quick definition, and optimize imports commands", async () => {
    caseContext.workspaceTestHarness.runtimeState.tauri = true;
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-parity",
      workspaceInstanceId: "instance-parity",
      name: "Parity commands",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/Program.cs" },
    };
    caseContext.workspaceTestHarness.workspaceMocks.workspaceReadFile.mockResolvedValue(caseContext.workspaceTestHarness.file(
      "src/Program.cs",
      "using System;\nclass Program { static void Main() {} }\n",
    ));
    caseContext.workspaceTestHarness.lspMocks.lspDetectServers.mockResolvedValue([caseContext.workspaceTestHarness.csharpStatus({ available: true, active: true })]);
    const activeStatus = caseContext.workspaceTestHarness.documentStatus({
      available: true,
      active: true,
      selectedCommand: "csharp-ls",
      capabilities: caseContext.workspaceTestHarness.defaultCapabilities({
        codeAction: true,
        definition: true,
        typeDefinition: true,
        implementation: true,
        signatureHelp: true,
      }),
    });
    caseContext.workspaceTestHarness.lspMocks.lspOpenDocument.mockResolvedValue(activeStatus);
    caseContext.workspaceTestHarness.lspMocks.lspChangeDocument.mockResolvedValue(activeStatus);
    caseContext.workspaceTestHarness.lspMocks.lspSaveDocument.mockResolvedValue(activeStatus);
    caseContext.workspaceTestHarness.lspMocks.lspGetDiagnostics.mockResolvedValue({
      status: activeStatus,
      diagnostics: [
        {
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 12 } },
          severity: 2,
          message: "Unnecessary using directive",
        },
        {
          range: { start: { line: 1, character: 6 }, end: { line: 1, character: 13 } },
          severity: 1,
          message: "Type error on Program",
        },
        {
          range: { start: { line: 2, character: 0 }, end: { line: 2, character: 5 } },
          severity: 1,
          message: "Missing return statement",
        },
      ],
    });
    caseContext.workspaceTestHarness.lspMocks.lspDefinition.mockResolvedValue({
      status: activeStatus,
      locations: [{
        uri: "file:///repo/app/src/Lib.cs",
        path: "/repo/app/src/Lib.cs",
        range: { start: { line: 10, character: 0 }, end: { line: 10, character: 10 } },
      }],
    });
    caseContext.workspaceTestHarness.lspMocks.lspSignatureHelp.mockResolvedValue({
      status: activeStatus,
      signatures: [{
        label: "Main(): void",
        parameters: [],
      }],
      activeSignature: 0,
      activeParameter: 0,
    });
    caseContext.workspaceTestHarness.lspMocks.lspCodeActions.mockResolvedValue({
      status: activeStatus,
      actions: [{
        title: "Organize Imports",
        kind: "source.organizeImports",
        edit: {
          changes: {
            "file:///repo/app/src/Program.cs": [
              { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 13 } }, newText: "" },
            ],
          },
        },
      }],
    });

    const registrationRef: { current: WorkspaceCommandRegistration | null; } = { current: null };
    const onCommandsChange = vi.fn((_tabId: string, next: WorkspaceCommandRegistration | null) => {
      if (next) registrationRef.current = next;
    });

    caseContext.workspaceTestHarness.renderWorkspace(workspace, { onCommandsChange });
    await findEditorByTitle("app / src/Program.cs");
    await waitFor(() => expect(screen.queryByText("LSP idle")).not.toBeInTheDocument());
    await waitFor(() => expect(caseContext.workspaceTestHarness.lspMocks.lspGetDiagnostics).toHaveBeenCalled(), { timeout: 3_000 });

    // 1. F2 Next error & Shift+F2 Prev error (wrapping)
    expect(registrationRef.current?.items.find((item) => item.id === "workspace.nextError")?.enabled).toBe(true);
    await act(async () => {
      registrationRef.current?.execute("workspace.nextError");
    });
    expect(useAppStore.getState().statusMessage).toBe("Error: Type error on Program");

    expect(registrationRef.current?.items.find((item) => item.id === "workspace.prevError")?.enabled).toBe(true);
    await act(async () => {
      registrationRef.current?.execute("workspace.prevError");
    });
    expect(useAppStore.getState().statusMessage).toBe("Warning: Unnecessary using directive");

    // 2. Ctrl+P Parameter Info
    expect(registrationRef.current?.items.find((item) => item.id === "workspace.parameterInfo")?.enabled).toBe(true);
    await act(async () => {
      registrationRef.current?.execute("workspace.parameterInfo");
    });
    await waitFor(() => expect(caseContext.workspaceTestHarness.lspMocks.lspSignatureHelp).toHaveBeenCalled());
    expect(await screen.findByRole("dialog", { name: "Parameter info" })).toHaveTextContent("Main(): void");

    // 3. Ctrl+Shift+I Quick Definition Peek
    expect(registrationRef.current?.items.find((item) => item.id === "workspace.quickDefinition")?.enabled).toBe(true);
    await act(async () => {
      registrationRef.current?.execute("workspace.quickDefinition");
    });
    await waitFor(() => expect(caseContext.workspaceTestHarness.lspMocks.lspDefinition).toHaveBeenCalled());

    // 4. Ctrl+Alt+O Optimize Imports
    expect(registrationRef.current?.items.find((item) => item.id === "workspace.optimizeImports")?.enabled).toBe(true);
    await act(async () => {
      registrationRef.current?.execute("workspace.optimizeImports");
    });
    await waitFor(() => expect(caseContext.workspaceTestHarness.lspMocks.lspCodeActions).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      ["source.organizeImports"],
    ));
    expect(useAppStore.getState().statusMessage).toBe("Imports organized");

    // 5. Ctrl+Shift+F10 Run Context Configuration
    expect(registrationRef.current?.items.find((item) => item.id === "workspace.runContextConfiguration")?.enabled).toBe(true);

    // 6. Ctrl+Alt+Shift+T Refactor This
    expect(registrationRef.current?.items.find((item) => item.id === "workspace.refactorThis")?.enabled).toBe(true);

    // 7. Breakpoints: Ctrl+F8, Ctrl+Shift+F8, Mute
    expect(registrationRef.current?.items.find((item) => item.id === "workspace.toggleBreakpoint")?.enabled).toBe(true);
    expect(registrationRef.current?.items.find((item) => item.id === "workspace.viewBreakpoints")?.enabled).toBe(true);
    expect(registrationRef.current?.items.find((item) => item.id === "workspace.toggleMuteBreakpoints")?.enabled).toBe(true);
    await act(async () => {
      registrationRef.current?.execute("workspace.toggleMuteBreakpoints");
    });
    expect(useAppStore.getState().statusMessage).toBe("Breakpoints muted");

    // 8. Ctrl+Shift+F9 Recompile Active File
    expect(registrationRef.current?.items.find((item) => item.id === "workspace.recompileActiveFile")?.enabled).toBe(true);

    // 9. ED-STYLE-002: Rearrange Code & Code Cleanup fail-closed with honest unavailable reasons
    // (live discovery: the mock provider returns no arrangement/cleanup kinds).
    expect(registrationRef.current?.items.find((item) => item.id === "workspace.rearrangeCode")?.enabled).toBe(true);
    await act(async () => {
      registrationRef.current?.execute("workspace.rearrangeCode");
    });
    expect(useAppStore.getState().statusMessage).toContain("Provider returned no rearrange action");

    expect(registrationRef.current?.items.find((item) => item.id === "workspace.codeCleanup")?.enabled).toBe(true);
    await act(async () => {
      registrationRef.current?.execute("workspace.codeCleanup");
    });
    expect(useAppStore.getState().statusMessage).toContain("Provider returned no cleanup action");
  });
  it("routes every common semantic navigation command through the provider host", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-query-routing",
      workspaceInstanceId: "instance-query-routing",
      name: "Query routing",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/Program.cs" },
    };
    const activeStatus = caseContext.workspaceTestHarness.documentStatus({
      path: "/repo/app/src/Program.cs",
      uri: "file:///repo/app/src/Program.cs",
      available: true,
      active: true,
      capabilities: caseContext.workspaceTestHarness.defaultCapabilities({
        definition: true,
        declaration: true,
        typeDefinition: true,
        implementation: true,
        references: true,
      }),
    });
    const target = {
      uri: "file:///repo/app/src/Program.cs",
      path: "/repo/app/src/Program.cs",
      range: { start: { line: 1, character: 6 }, end: { line: 1, character: 13 } },
    };
    caseContext.workspaceTestHarness.workspaceMocks.workspaceReadFile.mockResolvedValue(caseContext.workspaceTestHarness.file(
      "src/Program.cs",
      "class Program {\n  void Main() {}\n}\n",
    ));
    caseContext.workspaceTestHarness.lspMocks.lspDetectServers.mockResolvedValue([caseContext.workspaceTestHarness.csharpStatus({ available: true, active: true })]);
    caseContext.workspaceTestHarness.lspMocks.lspOpenDocument.mockResolvedValue(activeStatus);
    caseContext.workspaceTestHarness.lspMocks.lspChangeDocument.mockResolvedValue(activeStatus);
    caseContext.workspaceTestHarness.lspMocks.lspGetDiagnostics.mockResolvedValue({ status: activeStatus, diagnostics: [] });
    caseContext.workspaceTestHarness.lspMocks.lspDefinition.mockResolvedValue({ status: activeStatus, locations: [target] });
    caseContext.workspaceTestHarness.lspMocks.lspDeclaration.mockResolvedValue({ status: activeStatus, locations: [target] });
    caseContext.workspaceTestHarness.lspMocks.lspTypeDefinition.mockResolvedValue({ status: activeStatus, locations: [target] });
    caseContext.workspaceTestHarness.lspMocks.lspImplementation.mockResolvedValue({ status: activeStatus, locations: [target] });
    caseContext.workspaceTestHarness.lspMocks.lspReferences.mockResolvedValue({ status: activeStatus, locations: [target] });

    const registrationRef: { current: WorkspaceCommandRegistration | null; } = { current: null };
    const onCommandsChange = vi.fn((_tabId: string, next: WorkspaceCommandRegistration | null) => {
      if (next) registrationRef.current = next;
    });

    caseContext.workspaceTestHarness.renderWorkspace(workspace, { onCommandsChange });
    await findEditorByTitle("app / src/Program.cs");
    await waitFor(() => expect(registrationRef.current).not.toBeNull());
    await waitFor(() => expect(registrationRef.current?.items.find(
      (item) => item.id === "workspace.gotoDeclaration",
    )?.enabled).toBe(true));

    caseContext.workspaceTestHarness.lspMocks.lspDefinition.mockClear();
    caseContext.workspaceTestHarness.lspMocks.lspDeclaration.mockClear();
    caseContext.workspaceTestHarness.lspMocks.lspTypeDefinition.mockClear();
    caseContext.workspaceTestHarness.lspMocks.lspImplementation.mockClear();
    caseContext.workspaceTestHarness.lspMocks.lspReferences.mockClear();

    const queryCommands = [
      ["workspace.gotoDefinition", caseContext.workspaceTestHarness.lspMocks.lspDefinition],
      ["workspace.gotoDeclaration", caseContext.workspaceTestHarness.lspMocks.lspDeclaration],
      ["workspace.gotoTypeDefinition", caseContext.workspaceTestHarness.lspMocks.lspTypeDefinition],
      ["workspace.gotoImplementation", caseContext.workspaceTestHarness.lspMocks.lspImplementation],
    ] as const;
    for (const [commandId, provider] of queryCommands) {
      await act(async () => {
        await registrationRef.current?.executeAction(commandId);
      });
      await waitFor(() => expect(provider).toHaveBeenCalled());
      expect(provider).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.objectContaining({
          signal: expect.anything(),
          cancelKey: "instance-query-routing|root:app:src/Program.cs",
          requestSeq: expect.any(Number),
        }),
      );
    }

    await act(async () => {
      await registrationRef.current?.executeAction("workspace.findReferences");
    });
    fireEvent.click(await screen.findByTestId("usages-scope-confirm"));
    await waitFor(() => expect(caseContext.workspaceTestHarness.lspMocks.lspReferences).toHaveBeenCalled());
    expect(caseContext.workspaceTestHarness.lspMocks.lspReferences).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      true,
      expect.objectContaining({
        signal: expect.anything(),
        cancelKey: "instance-query-routing|root:app:src/Program.cs",
        requestSeq: expect.any(Number),
      }),
    );
  });
}
