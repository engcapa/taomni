import { emit } from "@tauri-apps/api/event";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { expect, it } from "vitest";
import type { LspDocumentStatus } from "../../../../../../lib/editor/lsp";
import { useAppStore } from "../../../../../../stores/appStore";
import { selectCodeWorkspaceUi, useCodeWorkspaceStore } from "../../../../../../stores/codeWorkspaceStore";
import type { CodeWorkspaceTabInfo } from "../../../../../../types";
import { type registerLanguageCasesFixture } from "../../language.cases";

export interface registerlanguageLifecycle1CasesContext {
  workspaceTestHarness: registerLanguageCasesFixture;
}

export function registerlanguageLifecycle1Cases(caseContext: registerlanguageLifecycle1CasesContext) {
  it("opens a multi-root workspace without embedding Language Servers in the tree", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-multi",
      workspaceInstanceId: "instance-multi",
      name: "Multi Repo",
      roots: [
        { id: "app", name: "app", path: "/repo/app", kind: "git" },
        { id: "lib", name: "lib", path: "/repo/lib", kind: "folder" },
      ],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/Program.cs" },
    };
    caseContext.workspaceTestHarness.workspaceMocks.workspaceListDir.mockImplementation(async (rootPath: string) => (
      rootPath === "/repo/app"
        ? [caseContext.workspaceTestHarness.entry("src", "src", "dir")]
        : [caseContext.workspaceTestHarness.entry("README.md", "README.md")]
    ));
    caseContext.workspaceTestHarness.workspaceMocks.workspaceReadFile.mockResolvedValue(caseContext.workspaceTestHarness.file("src/Program.cs", "class Program {}"));
    caseContext.workspaceTestHarness.lspMocks.lspDetectServers.mockResolvedValue([caseContext.workspaceTestHarness.csharpStatus()]);
    caseContext.workspaceTestHarness.lspMocks.lspOpenDocument.mockResolvedValue(caseContext.workspaceTestHarness.documentStatus());

    caseContext.workspaceTestHarness.renderWorkspace(workspace);

    expect(await screen.findByText("Code · Multi Repo")).toBeInTheDocument();
    expect(screen.getByText("2 roots")).toBeInTheDocument();
    expect(screen.getAllByText("app").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("lib").length).toBeGreaterThanOrEqual(1);
    // Language Servers UI moved to Settings — tree should stay free of it.
    expect(screen.queryByText("Language Servers")).toBeNull();
    expect(screen.queryByText("dotnet tool install -g csharp-ls")).toBeNull();

    await waitFor(() => {
      expect(caseContext.workspaceTestHarness.lspMocks.lspOpenDocument).toHaveBeenCalledWith(
        {
          workspaceId: "instance-multi",
          rootPath: "/repo/app",
          filePath: "src/Program.cs",
          documentUri: null,
          serverCommandId: null,
          customServerCommand: null,
          javaHome: null,
        },
        "class Program {}",
        1,
      );
    });
  });
  it("offers a settings link when opening a file without an active language server", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-lsp-settings",
      name: "LSP Settings",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/Program.cs" },
    };
    caseContext.workspaceTestHarness.workspaceMocks.workspaceReadFile.mockResolvedValue(caseContext.workspaceTestHarness.file("src/Program.cs", "class Program {}"));
    caseContext.workspaceTestHarness.lspMocks.lspDetectServers.mockResolvedValue([caseContext.workspaceTestHarness.csharpStatus()]);
    caseContext.workspaceTestHarness.lspMocks.lspOpenDocument.mockResolvedValue(caseContext.workspaceTestHarness.documentStatus({ error: "csharp-ls failed to start" }));

    caseContext.workspaceTestHarness.renderWorkspace(workspace);

    await screen.findByTitle("app / src/Program.cs");
    await waitFor(() => expect(caseContext.workspaceTestHarness.lspMocks.lspOpenDocument).toHaveBeenCalled(), { timeout: 3_000 });

    const banner = await screen.findByTestId("code-workspace-banner-lsp-error:root:app:src/Program.cs:csharp");
    expect(banner).toHaveTextContent("Language Server Degraded");
    expect(banner).toHaveTextContent("csharp-ls failed to start");
    fireEvent.click(screen.getByTestId("banner-action-open-settings"));
    expect(caseContext.workspaceTestHarness.settingsNavigationMocks.openSettingsSection).toHaveBeenCalledTimes(1);
    expect(caseContext.workspaceTestHarness.settingsNavigationMocks.openSettingsSection).toHaveBeenCalledWith("language-servers", {
      presetId: "csharp",
    });

    const link = await screen.findByTestId("code-workspace-lsp-open-settings");
    expect(link).toBeInTheDocument();
    fireEvent.click(link);
    expect(caseContext.workspaceTestHarness.settingsNavigationMocks.openSettingsSection).toHaveBeenCalledWith("language-servers", {
      presetId: "csharp",
    });
  });
  it("mirrors active files, loose files, and diagnostics into agent workspace context", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-context",
      name: "Context",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/Program.cs" },
    };
    caseContext.workspaceTestHarness.workspaceMocks.workspaceReadFile.mockResolvedValue(caseContext.workspaceTestHarness.file("src/Program.cs", "class Program {}"));
    caseContext.workspaceTestHarness.lspMocks.lspDetectServers.mockResolvedValue([caseContext.workspaceTestHarness.csharpStatus({ available: true, active: true })]);
    caseContext.workspaceTestHarness.lspMocks.lspOpenDocument.mockResolvedValue(caseContext.workspaceTestHarness.documentStatus({
      active: true,
      available: true,
      selectedCommand: "csharp-ls",
      installHint: null,
    }));
    caseContext.workspaceTestHarness.lspMocks.lspGetDiagnostics.mockResolvedValue({
      status: caseContext.workspaceTestHarness.documentStatus({
        active: true,
        available: true,
        selectedCommand: "csharp-ls",
        installHint: null,
      }),
      diagnostics: [
        {
          range: {
            start: { line: 0, character: 6 },
            end: { line: 0, character: 13 },
          },
          severity: 1,
          code: "CS1001",
          source: "csharp-ls",
          message: "Identifier expected",
        },
      ],
    });

    caseContext.workspaceTestHarness.renderWorkspace(workspace);

    await screen.findByTitle("app / src/Program.cs");
    await waitFor(() => expect(caseContext.workspaceTestHarness.lspMocks.lspOpenDocument).toHaveBeenCalled(), { timeout: 3_000 });
    await waitFor(() => expect(caseContext.workspaceTestHarness.lspMocks.lspGetDiagnostics).toHaveBeenCalled(), { timeout: 3_000 });
    await waitFor(() => {
      const context = useAppStore.getState().codeWorkspaceByTab["tab-code"];
      expect(context).toMatchObject({
        repoRoot: "/repo/app",
        activePath: "src/Program.cs",
        openPaths: ["src/Program.cs"],
        roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
        activeFile: {
          kind: "root",
          rootId: "app",
          rootName: "app",
          rootPath: "/repo/app",
          path: "src/Program.cs",
        },
        lsp: {
          activeStatus: {
            displayName: "C#",
            languageId: "csharp",
            active: true,
            available: true,
            selectedCommand: "csharp-ls",
          },
          diagnostics: [
            {
              file: {
                kind: "root",
                rootId: "app",
                rootName: "app",
                rootPath: "/repo/app",
                path: "src/Program.cs",
              },
              errorCount: 1,
              warningCount: 0,
              infoCount: 0,
              messages: ["Identifier expected"],
            },
          ],
        },
      });
    });

    fireEvent.click(screen.getByRole("tab", { name: /Problems/ }));
    expect(await screen.findByText("Identifier expected")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Show error diagnostics" })).toHaveTextContent("1");
  });
  it("opens the intention menu and applies the quick fix while provider work-done progress is active", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-actions-progress",
      workspaceInstanceId: "instance-actions-progress",
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
    const insertSpaceAction = {
      title: "Insert space",
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
      command: null,
      commandArguments: null,
      raw: { title: "Insert space" },
    };
    caseContext.workspaceTestHarness.lspMocks.lspCodeActions.mockResolvedValue({
      status: caseContext.workspaceTestHarness.documentStatus({ available: true, active: true }),
      actions: [insertSpaceAction],
    });
    caseContext.workspaceTestHarness.lspMocks.lspCodeActionResolve.mockResolvedValue({
      status: caseContext.workspaceTestHarness.documentStatus({ available: true, active: true }),
      action: insertSpaceAction,
    });

    caseContext.workspaceTestHarness.renderWorkspace(workspace);
    await screen.findByTitle("app / src/main.ts");
    await waitFor(() => expect(screen.queryByText("LSP idle")).not.toBeInTheDocument());

    // jdtls begins a long-running task (Maven import); after the 150ms
    // progress flush the semantic snapshot stays "building" with an active
    // provider for the rest of the scenario.
    await act(async () => {
      await emit("lsp://work-done-progress", {
        workspaceId: "instance-actions-progress",
        presetId: "app",
        serverLabel: "jdt.ls",
        rootUri: "file:///repo/app",
        token: "qa008-progress",
        kind: "begin",
        title: "Building",
        message: null,
        percentage: null,
        cancellable: false,
      });
    });
    await act(() => new Promise((resolve) => setTimeout(resolve, 250)));

    fireEvent.keyDown(window, { key: "Enter", altKey: true });
    fireEvent.click(await screen.findByRole("button", { name: "Insert space" }));

    await waitFor(() => expect(useAppStore.getState().statusMessage).toContain("Applied code action"));
    expect(selectCodeWorkspaceUi(
      useCodeWorkspaceStore.getState(),
      "instance-actions-progress",
    ).openFiles["root:app:src/main.ts"]?.text).toBe("x =1");
    // ED-AUDIT-008: the commit must reach the VISIBLE editor, not only the
    // store. The import quick fix is a pure insertion; its replaceDocument
    // delta used to be rejected by the owner's deleted-equality guard, the
    // sync effect swallowed the store change, and the native editor kept the
    // pre-apply text while the disk already held the import.
    await waitFor(() => {
      const content = document.querySelector<HTMLElement>(".cm-content");
      expect(content?.textContent).toContain("x =1");
    });
  });
  it("supersedes an older intention request when another entry opens", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-action-supersede",
      workspaceInstanceId: "instance-action-supersede",
      name: "Action supersede",
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
      code: "supersede-entry",
      source: "typescript",
      message: "Supersede entry diagnostic",
    };
    const olderAction = {
      title: "Older candidate",
      kind: "quickfix",
      isPreferred: false,
      edit: { documentEdits: [] },
      command: null,
      commandArguments: null,
      raw: { title: "Older candidate" },
    };
    const newerAction = { ...olderAction, title: "Newer candidate", raw: { title: "Newer candidate" } };
    let releaseOlder!: (value: { status: LspDocumentStatus; actions: typeof olderAction[]; }) => void;
    caseContext.workspaceTestHarness.lspMocks.lspCodeActions
      .mockImplementationOnce(() => new Promise((resolve) => {
        releaseOlder = resolve;
      }))
      .mockResolvedValueOnce({ status, actions: [newerAction] });
    caseContext.workspaceTestHarness.workspaceMocks.workspaceListDir.mockResolvedValue([caseContext.workspaceTestHarness.entry("src", "src", "dir")]);
    caseContext.workspaceTestHarness.workspaceMocks.workspaceReadFile.mockResolvedValue(caseContext.workspaceTestHarness.file("src/main.ts", "x"));
    caseContext.workspaceTestHarness.lspMocks.lspOpenDocument.mockResolvedValue(status);
    caseContext.workspaceTestHarness.lspMocks.lspGetDiagnostics.mockResolvedValue({ status, diagnostics: [diagnostic] });

    const rendered = caseContext.workspaceTestHarness.renderWorkspace(workspace);
    await screen.findByTitle("app / src/main.ts");
    await waitFor(() => expect(caseContext.workspaceTestHarness.lspMocks.lspGetDiagnostics).toHaveBeenCalled());
    await waitFor(() => expect(rendered.container.querySelector(
      '[data-testid="code-workspace-lightbulb"]',
    )).toBeTruthy());

    fireEvent.keyDown(window, { key: "Enter", altKey: true });
    await waitFor(() => expect(caseContext.workspaceTestHarness.lspMocks.lspCodeActions).toHaveBeenCalledTimes(1));
    fireEvent.mouseDown(rendered.container.querySelector('[data-testid="code-workspace-lightbulb"]')!);
    expect(await screen.findByRole(
      "button",
      { name: "Newer candidate" },
      { timeout: 5_000 },
    )).toBeInTheDocument();

    await act(async () => {
      releaseOlder({ status, actions: [olderAction] });
      await Promise.resolve();
    });
    expect(screen.getByRole("button", { name: "Newer candidate" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Older candidate" })).not.toBeInTheDocument();
    expect(useAppStore.getState().statusMessage).not.toContain("No code actions");
  });
  it("discards a resolved action when a newer intention session owns the menu", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-action-resolve-owner",
      workspaceInstanceId: "instance-action-resolve-owner",
      name: "Action resolve owner",
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
      code: "resolve-owner",
      source: "typescript",
      message: "Resolve owner diagnostic",
    };
    const oldAction = {
      title: "Deferred old fix",
      kind: "quickfix",
      isPreferred: true,
      edit: null,
      command: null,
      commandArguments: null,
      raw: { title: "Deferred old fix", data: { fixId: "old" } },
    };
    const newAction = {
      title: "Current fix",
      kind: "quickfix",
      isPreferred: true,
      edit: { documentEdits: [] },
      command: null,
      commandArguments: null,
      raw: { title: "Current fix" },
    };
    const resolvedOldAction = {
      ...oldAction,
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
    };
    let releaseResolve!: (value: { status: LspDocumentStatus; action: typeof resolvedOldAction; }) => void;
    caseContext.workspaceTestHarness.lspMocks.lspCodeActions
      .mockResolvedValueOnce({ status, actions: [oldAction] })
      .mockResolvedValueOnce({ status, actions: [newAction] });
    caseContext.workspaceTestHarness.lspMocks.lspCodeActionResolve.mockImplementationOnce(() => new Promise((resolve) => {
      releaseResolve = resolve;
    }));
    caseContext.workspaceTestHarness.workspaceMocks.workspaceListDir.mockResolvedValue([caseContext.workspaceTestHarness.entry("src", "src", "dir")]);
    caseContext.workspaceTestHarness.workspaceMocks.workspaceReadFile.mockResolvedValue(caseContext.workspaceTestHarness.file("src/main.ts", "x=1"));
    caseContext.workspaceTestHarness.lspMocks.lspOpenDocument.mockResolvedValue(status);
    caseContext.workspaceTestHarness.lspMocks.lspGetDiagnostics.mockResolvedValue({ status, diagnostics: [diagnostic] });

    const rendered = caseContext.workspaceTestHarness.renderWorkspace(workspace);
    await screen.findByTitle("app / src/main.ts");
    await waitFor(() => expect(caseContext.workspaceTestHarness.lspMocks.lspGetDiagnostics).toHaveBeenCalled());
    await waitFor(() => expect(rendered.container.querySelector(
      '[data-testid="code-workspace-lightbulb"]',
    )).toBeTruthy());

    fireEvent.keyDown(window, { key: "Enter", altKey: true });
    await waitFor(() => expect(caseContext.workspaceTestHarness.lspMocks.lspCodeActions).toHaveBeenCalledTimes(1));
    fireEvent.click(await screen.findByRole(
      "button",
      { name: "Deferred old fix" },
      { timeout: 5_000 },
    ));
    await waitFor(() => expect(caseContext.workspaceTestHarness.lspMocks.lspCodeActionResolve).toHaveBeenCalledTimes(1));
    fireEvent.mouseDown(rendered.container.querySelector('[data-testid="code-workspace-lightbulb"]')!);
    expect(await screen.findByRole("button", { name: "Current fix" })).toBeInTheDocument();

    await act(async () => {
      releaseResolve({ status, action: resolvedOldAction });
      await Promise.resolve();
    });
    expect(screen.getByRole("button", { name: "Current fix" })).toBeInTheDocument();
    expect(selectCodeWorkspaceUi(
      useCodeWorkspaceStore.getState(),
      "instance-action-resolve-owner",
    ).openFiles["root:app:src/main.ts"]?.text).toBe("x=1");
  });
}
