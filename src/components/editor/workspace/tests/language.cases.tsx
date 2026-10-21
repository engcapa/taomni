import { emit } from "@tauri-apps/api/event";
import { act,fireEvent,screen,waitFor } from "@testing-library/react";
import { describe,expect,it,vi } from "vitest";
import type { LspDocumentStatus } from "../../../../lib/editor/lsp";
import { useAppStore } from "../../../../stores/appStore";
import { selectCodeWorkspaceUi,useCodeWorkspaceStore } from "../../../../stores/codeWorkspaceStore";
import type { CodeWorkspaceTabInfo } from "../../../../types";
import type { WorkspaceTestFixture } from "../../CodeWorkspaceTab.test";
import type { WorkspaceCommandRegistration } from "../workspaceCommands";

export type registerLanguageCasesFixture = Pick<WorkspaceTestFixture, "workspaceMocks" | "entry" | "file" | "lspMocks" | "csharpStatus" | "documentStatus" | "renderWorkspace" | "settingsNavigationMocks" | "writeAck" | "defaultCapabilities" | "toolbarControl" | "runtimeState" | "dapMocks">;

export function registerLanguageCases(workspaceTestHarness: registerLanguageCasesFixture) {
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
    workspaceTestHarness.workspaceMocks.workspaceListDir.mockImplementation(async (rootPath: string) => (
      rootPath === "/repo/app"
        ? [workspaceTestHarness.entry("src", "src", "dir")]
        : [workspaceTestHarness.entry("README.md", "README.md")]
    ));
    workspaceTestHarness.workspaceMocks.workspaceReadFile.mockResolvedValue(workspaceTestHarness.file("src/Program.cs", "class Program {}"));
    workspaceTestHarness.lspMocks.lspDetectServers.mockResolvedValue([workspaceTestHarness.csharpStatus()]);
    workspaceTestHarness.lspMocks.lspOpenDocument.mockResolvedValue(workspaceTestHarness.documentStatus());

    workspaceTestHarness.renderWorkspace(workspace);

    expect(await screen.findByText("Code · Multi Repo")).toBeInTheDocument();
    expect(screen.getByText("2 roots")).toBeInTheDocument();
    expect(screen.getAllByText("app").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("lib").length).toBeGreaterThanOrEqual(1);
    // Language Servers UI moved to Settings — tree should stay free of it.
    expect(screen.queryByText("Language Servers")).toBeNull();
    expect(screen.queryByText("dotnet tool install -g csharp-ls")).toBeNull();

    await waitFor(() => {
      expect(workspaceTestHarness.lspMocks.lspOpenDocument).toHaveBeenCalledWith(
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
    workspaceTestHarness.workspaceMocks.workspaceReadFile.mockResolvedValue(workspaceTestHarness.file("src/Program.cs", "class Program {}"));
    workspaceTestHarness.lspMocks.lspDetectServers.mockResolvedValue([workspaceTestHarness.csharpStatus()]);
    workspaceTestHarness.lspMocks.lspOpenDocument.mockResolvedValue(workspaceTestHarness.documentStatus({ error: "csharp-ls failed to start" }));

    workspaceTestHarness.renderWorkspace(workspace);

    await screen.findByTitle("app / src/Program.cs");
    await waitFor(() => expect(workspaceTestHarness.lspMocks.lspOpenDocument).toHaveBeenCalled(), { timeout: 3_000 });

    const banner = await screen.findByTestId("code-workspace-banner-lsp-error:root:app:src/Program.cs:csharp");
    expect(banner).toHaveTextContent("Language Server Degraded");
    expect(banner).toHaveTextContent("csharp-ls failed to start");
    fireEvent.click(screen.getByTestId("banner-action-open-settings"));
    expect(workspaceTestHarness.settingsNavigationMocks.openSettingsSection).toHaveBeenCalledTimes(1);
    expect(workspaceTestHarness.settingsNavigationMocks.openSettingsSection).toHaveBeenCalledWith("language-servers", {
      presetId: "csharp",
    });

    const link = await screen.findByTestId("code-workspace-lsp-open-settings");
    expect(link).toBeInTheDocument();
    fireEvent.click(link);
    expect(workspaceTestHarness.settingsNavigationMocks.openSettingsSection).toHaveBeenCalledWith("language-servers", {
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
    workspaceTestHarness.workspaceMocks.workspaceReadFile.mockResolvedValue(workspaceTestHarness.file("src/Program.cs", "class Program {}"));
    workspaceTestHarness.lspMocks.lspDetectServers.mockResolvedValue([workspaceTestHarness.csharpStatus({ available: true, active: true })]);
    workspaceTestHarness.lspMocks.lspOpenDocument.mockResolvedValue(workspaceTestHarness.documentStatus({
      active: true,
      available: true,
      selectedCommand: "csharp-ls",
      installHint: null,
    }));
    workspaceTestHarness.lspMocks.lspGetDiagnostics.mockResolvedValue({
      status: workspaceTestHarness.documentStatus({
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

    workspaceTestHarness.renderWorkspace(workspace);

    await screen.findByTitle("app / src/Program.cs");
    await waitFor(() => expect(workspaceTestHarness.lspMocks.lspOpenDocument).toHaveBeenCalled(), { timeout: 3_000 });
    await waitFor(() => expect(workspaceTestHarness.lspMocks.lspGetDiagnostics).toHaveBeenCalled(), { timeout: 3_000 });
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
    workspaceTestHarness.lspMocks.lspCodeActions.mockResolvedValue({
      status: workspaceTestHarness.documentStatus({ available: true, active: true }),
      actions: [insertSpaceAction],
    });
    workspaceTestHarness.lspMocks.lspCodeActionResolve.mockResolvedValue({
      status: workspaceTestHarness.documentStatus({ available: true, active: true }),
      action: insertSpaceAction,
    });

    workspaceTestHarness.renderWorkspace(workspace);
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
    const status = workspaceTestHarness.documentStatus({
      path: "/repo/app/src/main.ts",
      available: true,
      active: true,
      capabilities: workspaceTestHarness.defaultCapabilities({ codeAction: true }),
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
    let releaseOlder!: (value: { status: LspDocumentStatus; actions: typeof olderAction[] }) => void;
    workspaceTestHarness.lspMocks.lspCodeActions
      .mockImplementationOnce(() => new Promise((resolve) => {
        releaseOlder = resolve;
      }))
      .mockResolvedValueOnce({ status, actions: [newerAction] });
    workspaceTestHarness.workspaceMocks.workspaceListDir.mockResolvedValue([workspaceTestHarness.entry("src", "src", "dir")]);
    workspaceTestHarness.workspaceMocks.workspaceReadFile.mockResolvedValue(workspaceTestHarness.file("src/main.ts", "x"));
    workspaceTestHarness.lspMocks.lspOpenDocument.mockResolvedValue(status);
    workspaceTestHarness.lspMocks.lspGetDiagnostics.mockResolvedValue({ status, diagnostics: [diagnostic] });

    const rendered = workspaceTestHarness.renderWorkspace(workspace);
    await screen.findByTitle("app / src/main.ts");
    await waitFor(() => expect(workspaceTestHarness.lspMocks.lspGetDiagnostics).toHaveBeenCalled());
    await waitFor(() => expect(rendered.container.querySelector(
      '[data-testid="code-workspace-lightbulb"]',
    )).toBeTruthy());

    fireEvent.keyDown(window, { key: "Enter", altKey: true });
    await waitFor(() => expect(workspaceTestHarness.lspMocks.lspCodeActions).toHaveBeenCalledTimes(1));
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
    const status = workspaceTestHarness.documentStatus({
      path: "/repo/app/src/main.ts",
      available: true,
      active: true,
      capabilities: workspaceTestHarness.defaultCapabilities({ codeAction: true }),
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
    let releaseResolve!: (value: { status: LspDocumentStatus; action: typeof resolvedOldAction }) => void;
    workspaceTestHarness.lspMocks.lspCodeActions
      .mockResolvedValueOnce({ status, actions: [oldAction] })
      .mockResolvedValueOnce({ status, actions: [newAction] });
    workspaceTestHarness.lspMocks.lspCodeActionResolve.mockImplementationOnce(() => new Promise((resolve) => {
      releaseResolve = resolve;
    }));
    workspaceTestHarness.workspaceMocks.workspaceListDir.mockResolvedValue([workspaceTestHarness.entry("src", "src", "dir")]);
    workspaceTestHarness.workspaceMocks.workspaceReadFile.mockResolvedValue(workspaceTestHarness.file("src/main.ts", "x=1"));
    workspaceTestHarness.lspMocks.lspOpenDocument.mockResolvedValue(status);
    workspaceTestHarness.lspMocks.lspGetDiagnostics.mockResolvedValue({ status, diagnostics: [diagnostic] });

    const rendered = workspaceTestHarness.renderWorkspace(workspace);
    await screen.findByTitle("app / src/main.ts");
    await waitFor(() => expect(workspaceTestHarness.lspMocks.lspGetDiagnostics).toHaveBeenCalled());
    await waitFor(() => expect(rendered.container.querySelector(
      '[data-testid="code-workspace-lightbulb"]',
    )).toBeTruthy());

    fireEvent.keyDown(window, { key: "Enter", altKey: true });
    await waitFor(() => expect(workspaceTestHarness.lspMocks.lspCodeActions).toHaveBeenCalledTimes(1));
    fireEvent.click(await screen.findByRole(
      "button",
      { name: "Deferred old fix" },
      { timeout: 5_000 },
    ));
    await waitFor(() => expect(workspaceTestHarness.lspMocks.lspCodeActionResolve).toHaveBeenCalledTimes(1));
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
it("keeps provider diagnostics unchanged when inspection severity affects editor chrome", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-profile-actions",
      workspaceInstanceId: "instance-profile-actions",
      name: "Profile actions",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/main.ts" },
    };
    const providerDiagnostic = {
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
      severity: 2,
      code: "unused-value",
      source: "typescript",
      message: "Value is never read",
      data: { providerToken: "original" },
    };
    window.localStorage.setItem(
      "taomni.codeWorkspace.inspectionProfile.v1.instance-profile-actions",
      JSON.stringify({
        version: 1,
        rules: { "typescript:unused-value": { enabled: true, severity: 1 } },
      }),
    );
    workspaceTestHarness.workspaceMocks.workspaceReadFile.mockResolvedValue(workspaceTestHarness.file("src/main.ts", "x"));
    const status = workspaceTestHarness.documentStatus({
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
    workspaceTestHarness.lspMocks.lspOpenDocument.mockResolvedValue(status);
    workspaceTestHarness.lspMocks.lspGetDiagnostics.mockResolvedValue({ status, diagnostics: [providerDiagnostic] });

    const rendered = workspaceTestHarness.renderWorkspace(workspace);
    await waitFor(() => expect(workspaceTestHarness.lspMocks.lspGetDiagnostics).toHaveBeenCalled(), { timeout: 3_000 });
    await waitFor(() => expect(rendered.container.querySelector(".cm-lsp-diagnostic-error")).toBeTruthy());
    const bulb = rendered.container.querySelector('[data-testid="code-workspace-lightbulb"]');
    expect(bulb).toBeTruthy();
    fireEvent.mouseDown(bulb!);

    await waitFor(() => expect(workspaceTestHarness.lspMocks.lspCodeActions).toHaveBeenCalled());
    expect(workspaceTestHarness.lspMocks.lspCodeActions.mock.calls.at(-1)?.[2]).toEqual([
      expect.objectContaining({
        severity: 2,
        code: "unused-value",
        data: { providerToken: "original" },
      }),
    ]);
  });
it("formats the active document through LSP when formatting is advertised", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-format",
      workspaceInstanceId: "instance-format",
      name: "Format",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/main.ts" },
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
      capabilities: {
        completion: true,
        signatureHelp: true,
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
        completionTriggerCharacters: ["."],
        signatureTriggerCharacters: ["(", ","],
      },
    }));
    workspaceTestHarness.lspMocks.lspFormatting.mockResolvedValue({
      status: workspaceTestHarness.documentStatus({ active: true, available: true }),
      edits: [{
        range: {
          start: { line: 0, character: 7 },
          end: { line: 0, character: 7 },
        },
        newText: " ",
      }],
    });

    workspaceTestHarness.renderWorkspace(workspace);
    await screen.findByTitle("app / src/main.ts");
    await waitFor(() => expect(screen.getByTestId("code-workspace-file-status").getAttribute("title")).toContain("9 B"));
    await waitFor(() => expect(workspaceTestHarness.lspMocks.lspOpenDocument).toHaveBeenCalled());
    // Wait until the LSP status is no longer idle so capabilities are in state.
    await waitFor(() => expect(screen.queryByText("LSP idle")).not.toBeInTheDocument());

    fireEvent.keyDown(window, { key: "l", ctrlKey: true, altKey: true, shiftKey: false, metaKey: false });
    await waitFor(() => expect(workspaceTestHarness.lspMocks.lspFormatting).toHaveBeenCalled());
    // Formatting inserts a space into "const x=1" → dirty buffer.
    await waitFor(() => {
      expect(screen.getByText(/unsaved/)).toBeInTheDocument();
    });
    expect(workspaceTestHarness.lspMocks.lspFormatting).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "instance-format",
        filePath: "src/main.ts",
      }),
      expect.objectContaining({
        tabSize: 2,
        insertSpaces: true,
      }),
    );
  });
it("requests usage highlights, viewport inlay hints, and semantic selection ranges", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-intelligence",
      workspaceInstanceId: "instance-intelligence",
      name: "Intelligence",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/main.ts" },
    };
    const capabilities = {
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
      codeAction: false,
      documentHighlight: true,
      callHierarchy: false,
      typeHierarchy: false,
      inlayHint: true,
      selectionRange: true,
      semanticTokens: false,
      completionTriggerCharacters: [],
      signatureTriggerCharacters: [],
    };
    const activeStatus = workspaceTestHarness.documentStatus({
      path: "/repo/app/src/main.ts",
      uri: "file:///repo/app/src/main.ts",
      available: true,
      active: true,
      capabilities,
    });
    workspaceTestHarness.workspaceMocks.workspaceReadFile.mockResolvedValue(workspaceTestHarness.file("src/main.ts", "const value = value;"));
    workspaceTestHarness.lspMocks.lspOpenDocument.mockResolvedValue(activeStatus);
    workspaceTestHarness.lspMocks.lspChangeDocument.mockResolvedValue(activeStatus);
    workspaceTestHarness.lspMocks.lspGetDiagnostics.mockResolvedValue({ status: activeStatus, diagnostics: [] });
    workspaceTestHarness.lspMocks.lspDocumentHighlights.mockResolvedValue({
      status: activeStatus,
      highlights: [{
        range: { start: { line: 0, character: 6 }, end: { line: 0, character: 11 } },
        kind: 2,
      }],
    });
    workspaceTestHarness.lspMocks.lspInlayHints.mockResolvedValue({
      status: activeStatus,
      hints: [{
        position: { line: 0, character: 11 },
        label: ": number",
        kind: 1,
        tooltip: null,
        paddingLeft: true,
        paddingRight: false,
      }],
    });
    workspaceTestHarness.lspMocks.lspSelectionRanges.mockResolvedValue({
      status: activeStatus,
      ranges: [{
        start: { line: 0, character: 0 },
        end: { line: 0, character: 20 },
      }],
    });

    const rendered = workspaceTestHarness.renderWorkspace(workspace);
    await screen.findByTitle("app / src/main.ts");
    await waitFor(() => expect(workspaceTestHarness.lspMocks.lspDocumentHighlights).toHaveBeenCalled());

    const inlayHintsToggle = workspaceTestHarness.toolbarControl("code-workspace-inlay-hints-toggle");
    expect(inlayHintsToggle).not.toBeDisabled();
    fireEvent.click(inlayHintsToggle);
    await waitFor(() => expect(workspaceTestHarness.toolbarControl("code-workspace-inlay-hints-toggle")).toHaveAttribute("aria-pressed", "true"));
    await waitFor(() => expect(workspaceTestHarness.lspMocks.lspInlayHints).toHaveBeenCalled());
    expect(window.localStorage.getItem("taomni.codeWorkspace.intelligence.v1.instance-intelligence"))
      .toContain('"inlayHintsEnabled":true');

    const content = rendered.container.querySelector<HTMLElement>(".cm-content");
    expect(content).not.toBeNull();
    fireEvent.keyDown(content!, { key: "w", code: "KeyW", ctrlKey: true });
    await waitFor(() => expect(workspaceTestHarness.lspMocks.lspSelectionRanges).toHaveBeenCalled());
  });
it("syncs edits before idle intelligence work and ignores an older semantic-token response", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-lsp-scheduler",
      workspaceInstanceId: "instance-lsp-scheduler",
      name: "LSP scheduler",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/main.ts" },
    };
    const capabilities = {
      completion: false,
      signatureHelp: false,
      hover: false,
      definition: false,
      typeDefinition: false,
      implementation: false,
      references: false,
      documentSymbol: true,
      workspaceSymbol: false,
      rename: false,
      formatting: false,
      rangeFormatting: false,
      codeAction: false,
      documentHighlight: true,
      callHierarchy: false,
      typeHierarchy: false,
      inlayHint: false,
      selectionRange: false,
      semanticTokens: true,
      completionTriggerCharacters: [],
      signatureTriggerCharacters: [],
    };
    const status = workspaceTestHarness.documentStatus({
      path: "/repo/app/src/main.ts",
      uri: "file:///repo/app/src/main.ts",
      available: true,
      active: true,
      capabilities,
    });
    workspaceTestHarness.workspaceMocks.workspaceReadFile.mockResolvedValue(workspaceTestHarness.file("src/main.ts", "const alpha = 1;"));
    workspaceTestHarness.lspMocks.lspOpenDocument.mockResolvedValue(status);
    workspaceTestHarness.lspMocks.lspChangeDocument.mockResolvedValue(status);
    workspaceTestHarness.lspMocks.lspGetDiagnostics.mockResolvedValue({ status, diagnostics: [] });
    workspaceTestHarness.lspMocks.lspDocumentHighlights.mockResolvedValue({ status, highlights: [] });
    workspaceTestHarness.lspMocks.lspDocumentSymbols.mockResolvedValue({ status, symbols: [] });

    const rendered = workspaceTestHarness.renderWorkspace(workspace);
    const fileKey = "root:app:src/main.ts";
    await screen.findByTitle("app / src/main.ts");
    await waitFor(() => expect(
      selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "instance-lsp-scheduler")
        .lspFiles[fileKey]?.syncedText,
    ).toBe("const alpha = 1;"));

    workspaceTestHarness.lspMocks.lspChangeDocument.mockClear();
    workspaceTestHarness.lspMocks.lspDocumentHighlights.mockClear();
    workspaceTestHarness.lspMocks.lspDocumentSymbols.mockClear();
    workspaceTestHarness.lspMocks.lspSemanticTokens.mockClear();
    let resolveOldSemantic: ((value: { status: LspDocumentStatus; tokens: unknown[] }) => void) | null = null;
    workspaceTestHarness.lspMocks.lspSemanticTokens.mockImplementationOnce(() => new Promise((resolve) => {
      resolveOldSemantic = resolve;
    }));

    act(() => {
      useCodeWorkspaceStore.getState().updateOpenFiles("instance-lsp-scheduler", (current) => ({
        ...current,
        [fileKey]: {
          ...current[fileKey]!,
          text: "const beta = 2;",
          dirty: true,
        },
      }));
    });

    await waitFor(() => expect(workspaceTestHarness.lspMocks.lspChangeDocument).toHaveBeenCalledOnce());
    await waitFor(() => expect(workspaceTestHarness.lspMocks.lspDocumentHighlights).toHaveBeenCalledOnce());
    await waitFor(() => expect(workspaceTestHarness.lspMocks.lspDocumentSymbols).toHaveBeenCalledOnce());
    await waitFor(() => expect(workspaceTestHarness.lspMocks.lspSemanticTokens).toHaveBeenCalledOnce());
    const changeOrder = workspaceTestHarness.lspMocks.lspChangeDocument.mock.invocationCallOrder[0]!;
    expect(changeOrder).toBeLessThan(workspaceTestHarness.lspMocks.lspDocumentHighlights.mock.invocationCallOrder[0]!);
    expect(changeOrder).toBeLessThan(workspaceTestHarness.lspMocks.lspDocumentSymbols.mock.invocationCallOrder[0]!);
    expect(changeOrder).toBeLessThan(workspaceTestHarness.lspMocks.lspSemanticTokens.mock.invocationCallOrder[0]!);

    act(() => {
      useCodeWorkspaceStore.getState().updateOpenFiles("instance-lsp-scheduler", (current) => ({
        ...current,
        [fileKey]: {
          ...current[fileKey]!,
          text: "const gamma = 3;",
          dirty: true,
        },
      }));
    });
    await waitFor(() => expect(workspaceTestHarness.lspMocks.lspChangeDocument).toHaveBeenCalledTimes(2));

    expect(resolveOldSemantic).not.toBeNull();
    await act(async () => {
      resolveOldSemantic!({
        status,
        tokens: [{
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
          tokenType: "function",
          modifiers: [],
        }],
      });
      await Promise.resolve();
    });
    expect(rendered.container.querySelector(".cm-lsp-sem-function")).toBeNull();
  });
it("launches on a clean build even when stale workspace diagnostics report errors", async () => {
    // Regression: the barrier swept EVERY published diagnostic in the workspace
    // instance, so a stale or foreign-language severity-1 entry blocked the
    // launch and flipped the bottom dock onto Problems for projects that
    // compile clean. The build status is the compiler verdict — trust it.
    workspaceTestHarness.runtimeState.tauri = true;
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-java-debug-stale-diags",
      workspaceInstanceId: "instance-java-debug-stale-diags",
      name: "Java debug stale diags",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/main/java/com/acme/App.java" },
    };
    workspaceTestHarness.workspaceMocks.workspaceReadFile.mockResolvedValue(workspaceTestHarness.file(
      "src/main/java/com/acme/App.java",
      "package com.acme; class App { public static void main(String[] args) {} }",
    ));
    workspaceTestHarness.lspMocks.lspBuildWorkspace.mockResolvedValue("succeed");
    workspaceTestHarness.lspMocks.lspWorkspaceDiagnostics.mockResolvedValue([
      {
        path: "/repo/app/legacy/Stale.java",
        uri: "file:///repo/app/legacy/Stale.java",
        diagnostics: [{
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
          severity: 1,
          code: null,
          source: "jdtls",
          message: "stale unresolved import",
        }],
      },
    ]);
    workspaceTestHarness.dapMocks.dapResolveJavaMainClasses.mockResolvedValue({
      kind: "resolved",
      main: {
        mainClass: "com.acme.App",
        projectName: "app",
        filePath: "/repo/app/src/main/java/com/acme/App.java",
      },
    });
    workspaceTestHarness.dapMocks.dapStartSession.mockResolvedValue({
      sessionId: "sess-1",
      capabilities: {},
      request: "launch",
      arguments: { mainClass: "com.acme.App" },
    });

    workspaceTestHarness.renderWorkspace(workspace, {}, { strict: true });
    await screen.findByTitle("app / src/main/java/com/acme/App.java");
    fireEvent.click(screen.getByTestId("code-workspace-debug-target"));

    await waitFor(() => expect(workspaceTestHarness.dapMocks.dapStartSession).toHaveBeenCalledWith(
      "java",
      expect.objectContaining({ mainClass: "com.acme.App" }),
    ));
    // The dock stays on the Debug console; Problems is not hijacked.
    await waitFor(() => expect(
      screen.getByTestId("code-workspace-bottom-tab-debug"),
    ).toHaveAttribute("aria-selected", "true"));
    expect(screen.getByTestId("code-workspace-bottom-tab-problems")).not.toHaveAttribute("data-active");
  });
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
    workspaceTestHarness.workspaceMocks.workspaceListDir.mockImplementation(async (_root: string, path = "") => (
      path === "src"
        ? [workspaceTestHarness.entry("main.ts", "src/main.ts"), workspaceTestHarness.entry("use.ts", "src/use.ts")]
        : []
    ));
    workspaceTestHarness.workspaceMocks.workspaceReadFile.mockImplementation(async (_root: string, path: string) => {
      const text = disk.get(path);
      if (text === undefined) throw new Error(`missing fixture ${path}`);
      return workspaceTestHarness.file(path, text, { hash: `hash-${path}` });
    });
    workspaceTestHarness.workspaceMocks.workspaceWriteFileEncoded.mockImplementation(async (
      _root: string,
      path: string,
      text: string,
    ) => {
      disk.set(path, text);
      return workspaceTestHarness.writeAck(workspaceTestHarness.file(path, text, { hash: `hash-${path}-${text}` }));
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
    const activeStatus = workspaceTestHarness.documentStatus({
      path: "/repo/app/src/main.ts",
      uri: "file:///repo/app/src/main.ts",
      available: true,
      active: true,
      capabilities,
    });
    workspaceTestHarness.lspMocks.lspOpenDocument.mockResolvedValue(activeStatus);
    workspaceTestHarness.lspMocks.lspChangeDocument.mockResolvedValue(activeStatus);
    workspaceTestHarness.lspMocks.lspSaveDocument.mockResolvedValue(activeStatus);
    const declarationRange = {
      start: { line: 0, character: 6 },
      end: { line: 0, character: 12 },
    };
    workspaceTestHarness.lspMocks.lspPrepareRename.mockResolvedValue({
      status: activeStatus,
      allowed: true,
      range: declarationRange,
      placeholder: "answer",
      message: null,
    });
    workspaceTestHarness.lspMocks.lspDefinition.mockResolvedValue({
      status: activeStatus,
      locations: [{
        uri: "file:///repo/app/src/main.ts",
        path: "/repo/app/src/main.ts",
        range: declarationRange,
      }],
    });
    workspaceTestHarness.lspMocks.lspReferences.mockResolvedValue({
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
    const registrationRef: { current: WorkspaceCommandRegistration | null } = { current: null };
    const onCommandsChange = vi.fn((_tabId: string, next: WorkspaceCommandRegistration | null) => {
      if (next) registrationRef.current = next;
    });

    const rendered = workspaceTestHarness.renderWorkspace(workspace, { onCommandsChange });
    await screen.findByTitle("app / src/main.ts");
    const content = rendered.container.querySelector<HTMLElement>(".cm-content");
    expect(content).not.toBeNull();
    await waitFor(() => expect(registrationRef.current).not.toBeNull());
    const safeDeleteCmd = registrationRef.current?.items.find((item) => item.id === "workspace.safeDeleteSymbol");
    expect(safeDeleteCmd?.enabled).toBe(false);
    expect(registrationRef.current?.execute("workspace.safeDeleteSymbol")).toBe(false);

    const execResult = await registrationRef.current?.executeAction("workspace.safeDeleteSymbol");
    expect(execResult?.kind).toBe("no-op");
    expect(execResult?.message).toContain("Language provider does not attest complete Safe Delete coverage");
    expect(workspaceTestHarness.lspMocks.lspPrepareRename).not.toHaveBeenCalled();
    expect(workspaceTestHarness.lspMocks.lspReferences).not.toHaveBeenCalled();
    expect(workspaceTestHarness.lspMocks.lspDefinition).not.toHaveBeenCalled();
    expect(workspaceTestHarness.workspaceMocks.workspaceWriteFileEncoded).not.toHaveBeenCalled();
    expect(disk.get("src/main.ts")).toBe("const answer = 42;");
    expect(disk.get("src/use.ts")).toBe("use(answer);");
  });
it("navigates diagnostics with F2 / Shift+F2 and executes parameter info, quick definition, and optimize imports commands", async () => {
    workspaceTestHarness.runtimeState.tauri = true;
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-parity",
      workspaceInstanceId: "instance-parity",
      name: "Parity commands",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/Program.cs" },
    };
    workspaceTestHarness.workspaceMocks.workspaceReadFile.mockResolvedValue(workspaceTestHarness.file(
      "src/Program.cs",
      "using System;\nclass Program { static void Main() {} }\n",
    ));
    workspaceTestHarness.lspMocks.lspDetectServers.mockResolvedValue([workspaceTestHarness.csharpStatus({ available: true, active: true })]);
    const activeStatus = workspaceTestHarness.documentStatus({
      available: true,
      active: true,
      selectedCommand: "csharp-ls",
      capabilities: workspaceTestHarness.defaultCapabilities({
        codeAction: true,
        definition: true,
        typeDefinition: true,
        implementation: true,
        signatureHelp: true,
      }),
    });
    workspaceTestHarness.lspMocks.lspOpenDocument.mockResolvedValue(activeStatus);
    workspaceTestHarness.lspMocks.lspChangeDocument.mockResolvedValue(activeStatus);
    workspaceTestHarness.lspMocks.lspSaveDocument.mockResolvedValue(activeStatus);
    workspaceTestHarness.lspMocks.lspGetDiagnostics.mockResolvedValue({
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
    workspaceTestHarness.lspMocks.lspDefinition.mockResolvedValue({
      status: activeStatus,
      locations: [{
        uri: "file:///repo/app/src/Lib.cs",
        path: "/repo/app/src/Lib.cs",
        range: { start: { line: 10, character: 0 }, end: { line: 10, character: 10 } },
      }],
    });
    workspaceTestHarness.lspMocks.lspSignatureHelp.mockResolvedValue({
      status: activeStatus,
      signatures: [{
        label: "Main(): void",
        parameters: [],
      }],
      activeSignature: 0,
      activeParameter: 0,
    });
    workspaceTestHarness.lspMocks.lspCodeActions.mockResolvedValue({
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

    const registrationRef: { current: WorkspaceCommandRegistration | null } = { current: null };
    const onCommandsChange = vi.fn((_tabId: string, next: WorkspaceCommandRegistration | null) => {
      if (next) registrationRef.current = next;
    });

    workspaceTestHarness.renderWorkspace(workspace, { onCommandsChange });
    await screen.findByTitle("app / src/Program.cs");
    await waitFor(() => expect(screen.queryByText("LSP idle")).not.toBeInTheDocument());
    await waitFor(() => expect(workspaceTestHarness.lspMocks.lspGetDiagnostics).toHaveBeenCalled(), { timeout: 3_000 });

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
    await waitFor(() => expect(workspaceTestHarness.lspMocks.lspSignatureHelp).toHaveBeenCalled());
    expect(await screen.findByRole("dialog", { name: "Parameter info" })).toHaveTextContent("Main(): void");

    // 3. Ctrl+Shift+I Quick Definition Peek
    expect(registrationRef.current?.items.find((item) => item.id === "workspace.quickDefinition")?.enabled).toBe(true);
    await act(async () => {
      registrationRef.current?.execute("workspace.quickDefinition");
    });
    await waitFor(() => expect(workspaceTestHarness.lspMocks.lspDefinition).toHaveBeenCalled());

    // 4. Ctrl+Alt+O Optimize Imports
    expect(registrationRef.current?.items.find((item) => item.id === "workspace.optimizeImports")?.enabled).toBe(true);
    await act(async () => {
      registrationRef.current?.execute("workspace.optimizeImports");
    });
    await waitFor(() => expect(workspaceTestHarness.lspMocks.lspCodeActions).toHaveBeenCalledWith(
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
    const activeStatus = workspaceTestHarness.documentStatus({
      path: "/repo/app/src/Program.cs",
      uri: "file:///repo/app/src/Program.cs",
      available: true,
      active: true,
      capabilities: workspaceTestHarness.defaultCapabilities({
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
    workspaceTestHarness.workspaceMocks.workspaceReadFile.mockResolvedValue(workspaceTestHarness.file(
      "src/Program.cs",
      "class Program {\n  void Main() {}\n}\n",
    ));
    workspaceTestHarness.lspMocks.lspDetectServers.mockResolvedValue([workspaceTestHarness.csharpStatus({ available: true, active: true })]);
    workspaceTestHarness.lspMocks.lspOpenDocument.mockResolvedValue(activeStatus);
    workspaceTestHarness.lspMocks.lspChangeDocument.mockResolvedValue(activeStatus);
    workspaceTestHarness.lspMocks.lspGetDiagnostics.mockResolvedValue({ status: activeStatus, diagnostics: [] });
    workspaceTestHarness.lspMocks.lspDefinition.mockResolvedValue({ status: activeStatus, locations: [target] });
    workspaceTestHarness.lspMocks.lspDeclaration.mockResolvedValue({ status: activeStatus, locations: [target] });
    workspaceTestHarness.lspMocks.lspTypeDefinition.mockResolvedValue({ status: activeStatus, locations: [target] });
    workspaceTestHarness.lspMocks.lspImplementation.mockResolvedValue({ status: activeStatus, locations: [target] });
    workspaceTestHarness.lspMocks.lspReferences.mockResolvedValue({ status: activeStatus, locations: [target] });

    const registrationRef: { current: WorkspaceCommandRegistration | null } = { current: null };
    const onCommandsChange = vi.fn((_tabId: string, next: WorkspaceCommandRegistration | null) => {
      if (next) registrationRef.current = next;
    });

    workspaceTestHarness.renderWorkspace(workspace, { onCommandsChange });
    await screen.findByTitle("app / src/Program.cs");
    await waitFor(() => expect(registrationRef.current).not.toBeNull());
    await waitFor(() => expect(registrationRef.current?.items.find(
      (item) => item.id === "workspace.gotoDeclaration",
    )?.enabled).toBe(true));

    workspaceTestHarness.lspMocks.lspDefinition.mockClear();
    workspaceTestHarness.lspMocks.lspDeclaration.mockClear();
    workspaceTestHarness.lspMocks.lspTypeDefinition.mockClear();
    workspaceTestHarness.lspMocks.lspImplementation.mockClear();
    workspaceTestHarness.lspMocks.lspReferences.mockClear();

    const queryCommands = [
      ["workspace.gotoDefinition", workspaceTestHarness.lspMocks.lspDefinition],
      ["workspace.gotoDeclaration", workspaceTestHarness.lspMocks.lspDeclaration],
      ["workspace.gotoTypeDefinition", workspaceTestHarness.lspMocks.lspTypeDefinition],
      ["workspace.gotoImplementation", workspaceTestHarness.lspMocks.lspImplementation],
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
    await waitFor(() => expect(workspaceTestHarness.lspMocks.lspReferences).toHaveBeenCalled());
    expect(workspaceTestHarness.lspMocks.lspReferences).toHaveBeenCalledWith(
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
describe("P0-J1 completion identity host containment", () => {
    it("lets the completion popup own Arrow keys and Tab in the workspace capture phase", async () => {
      const { EditorView } = await import("@codemirror/view");
      const { startCompletion } = await import("@codemirror/autocomplete");
      const workspace: CodeWorkspaceTabInfo = {
        repoRoot: "/repo/app",
        workspaceId: "ws-completion-keyboard",
        workspaceInstanceId: "instance-completion-keyboard",
        name: "Completion Keyboard",
        roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
        looseFiles: [],
        initialFile: { kind: "root", rootId: "app", path: "src/App.java" },
      };
      workspaceTestHarness.workspaceMocks.workspaceListDir.mockResolvedValue([workspaceTestHarness.entry("src", "src", "dir")]);
      workspaceTestHarness.workspaceMocks.workspaceReadFile.mockResolvedValue(workspaceTestHarness.file("src/App.java", "sout"));

      const rendered = workspaceTestHarness.renderWorkspace(workspace);
      await screen.findByTitle("app / src/App.java");
      const content = rendered.container.querySelector<HTMLElement>(".cm-content");
      expect(content).not.toBeNull();
      const view = EditorView.findFromDOM(content!);
      expect(view).not.toBeNull();
      act(() => {
        view!.dispatch({ selection: { anchor: view!.state.doc.length } });
        startCompletion(view!);
      });
      await waitFor(() => {
        const element = document.querySelector(".cm-tooltip-autocomplete");
        expect(element).not.toBeNull();
        return element!;
      });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
      });
      const selectedId = () => content!.getAttribute("aria-activedescendant");
      const before = selectedId();

      fireEvent.keyDown(content!, { key: "ArrowDown", code: "ArrowDown" });
      await waitFor(() => expect(selectedId()).not.toBe(before));
      fireEvent.keyDown(content!, { key: "Tab", code: "Tab" });

      await waitFor(() => expect(view!.state.doc.toString()).toContain("System.out"));
      expect(document.querySelector(".cm-tooltip-autocomplete")).toBeNull();
    });

    it("never renders inactive-provider completion candidates in a mounted editor", async () => {
      const { EditorView } = await import("@codemirror/view");
      const { startCompletion } = await import("@codemirror/autocomplete");
      workspaceTestHarness.lspMocks.lspCompletion.mockResolvedValue({
        status: {
          path: "src/main.ts",
          uri: "file:///repo/app/src/main.ts",
          presetId: null,
          languageId: "typescript",
          displayName: "TypeScript",
          available: true,
          active: false,
          selectedCommandId: null,
          selectedCommand: null,
          installHint: null,
          error: null,
        } satisfies LspDocumentStatus,
        isIncomplete: false,
        items: [{
          label: "StaleServerCandidate",
          kind: 7,
          detail: null,
          documentation: null,
          insertText: "StaleServerCandidate",
          insertTextFormat: 1,
          filterText: null,
          sortText: null,
          textEdit: null,
          additionalTextEdits: [],
          raw: {},
        }],
      });

      const workspace: CodeWorkspaceTabInfo = {
        repoRoot: "/repo/app",
        workspaceId: "ws-completion-inactive",
        workspaceInstanceId: "instance-completion-inactive",
        name: "Completion Inactive",
        roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
        looseFiles: [],
        initialFile: { kind: "root", rootId: "app", path: "src/main.ts" },
      };
      workspaceTestHarness.workspaceMocks.workspaceListDir.mockResolvedValue([workspaceTestHarness.entry("src", "src", "dir")]);
      workspaceTestHarness.workspaceMocks.workspaceReadFile.mockResolvedValue(workspaceTestHarness.file("src/main.ts", "const value = 1;\n"));

      const rendered = workspaceTestHarness.renderWorkspace(workspace);
      await screen.findByTitle("app / src/main.ts");
      const content = rendered.container.querySelector<HTMLElement>(".cm-content");
      expect(content).not.toBeNull();

      const view = EditorView.findFromDOM(content!);
      expect(view).not.toBeNull();
      act(() => {
        view!.dispatch({
          changes: { from: view!.state.doc.length, insert: "valu" },
          selection: { anchor: view!.state.doc.length + 4 },
          userEvent: "input.type",
        });
        startCompletion(view!);
      });

      // Give the deferred provider response (inactive + stale items) time to
      // settle; whatever the popup shows, stale provider labels must not be
      // among the options.
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 400));
      });
      const optionEls = rendered.container.querySelectorAll(".cm-tooltip-autocomplete li, .cm-completionLabel");
      for (const optionEl of optionEls) {
        expect(optionEl.textContent).not.toContain("StaleServerCandidate");
      }
    });

    it.each([false, true])("keeps a post-save member completion pending until the live document sync finishes (edit while waiting: %s)", async (editWhileWaiting) => {
      const { EditorView } = await import("@codemirror/view");
      const workspace: CodeWorkspaceTabInfo = {
        repoRoot: "/repo/app",
        workspaceId: `ws-completion-delayed-sync-${editWhileWaiting}`,
        workspaceInstanceId: `instance-completion-delayed-sync-${editWhileWaiting}`,
        name: "Completion Delayed Sync",
        roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
        looseFiles: [],
        initialFile: { kind: "root", rootId: "app", path: "src/App.java" },
      };
      workspaceTestHarness.workspaceMocks.workspaceListDir.mockResolvedValue([workspaceTestHarness.entry("src", "src", "dir")]);
      workspaceTestHarness.workspaceMocks.workspaceReadFile.mockResolvedValue(workspaceTestHarness.file("src/App.java", "System.out.println();"));
      workspaceTestHarness.workspaceMocks.workspaceWriteFileEncoded.mockResolvedValue(workspaceTestHarness.writeAck(workspaceTestHarness.file(
        "src/App.java", "System.out.println();\n", { hash: "hash-delayed-sync" },
      )));
      const javaStatus = workspaceTestHarness.documentStatus({
        path: "src/App.java", uri: "file:///repo/app/src/App.java", presetId: "jdtls",
        languageId: "java", displayName: "Java", available: true, active: true,
        capabilities: workspaceTestHarness.defaultCapabilities({ completion: true, completionTriggerCharacters: ["."] }),
      });
      workspaceTestHarness.lspMocks.lspOpenDocument.mockResolvedValue(javaStatus);
      workspaceTestHarness.lspMocks.lspChangeDocument.mockResolvedValue(javaStatus);
      workspaceTestHarness.lspMocks.lspCompletion.mockResolvedValue({
        status: javaStatus, isIncomplete: false,
        items: [{
          label: "println", kind: 2, detail: null, documentation: null,
          insertText: "println", insertTextFormat: 1, filterText: null, sortText: null,
          textEdit: null, additionalTextEdits: [], raw: {},
        }],
      });
      const rendered = workspaceTestHarness.renderWorkspace(workspace);
      await screen.findByTitle("app / src/App.java");
      await waitFor(() => expect(rendered.container.querySelector(".cm-content")).not.toBeNull());
      const content = rendered.container.querySelector<HTMLElement>(".cm-content")!;
      const view = EditorView.findFromDOM(content)!;
      await waitFor(() => expect(workspaceTestHarness.lspMocks.lspOpenDocument).toHaveBeenCalled());
      act(() => {
        view.focus();
        view.dispatch({
          changes: { from: view.state.doc.length, insert: "\n" },
          selection: { anchor: view.state.doc.length + 1 }, userEvent: "input.type",
        });
      });
      await waitFor(() => expect(screen.getByTestId("code-workspace-save-observation")).toHaveAttribute("data-dirty", "true"));
      fireEvent.keyDown(window, { key: "s", code: "KeyS", ctrlKey: true });
      await waitFor(() => expect(screen.getByTestId("code-workspace-save-observation")).toHaveAttribute("data-dirty", "false"));
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 250)); });

      let acknowledgeSync!: () => void;
      const pendingSync = new Promise<typeof javaStatus>((resolve) => {
        acknowledgeSync = () => resolve(javaStatus);
      });
      workspaceTestHarness.lspMocks.lspChangeDocument.mockClear();
      workspaceTestHarness.lspMocks.lspChangeDocument.mockImplementation(() => pendingSync);
      workspaceTestHarness.lspMocks.lspCompletion.mockClear();
      act(() => {
        view.focus();
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: "System.out." },
          selection: { anchor: 11 }, userEvent: "input.type",
        });
      });
      await waitFor(() => expect(workspaceTestHarness.lspMocks.lspChangeDocument).toHaveBeenCalled());
      // The provider is active, but its real document acknowledgment can be
      // slower than the feature's 400ms best-effort wait. It must receive no
      // query for stale text, and the final dot must not require another key.
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 650)); });
      expect(workspaceTestHarness.lspMocks.lspCompletion).not.toHaveBeenCalled();
      if (editWhileWaiting) {
        act(() => view.dispatch({
          changes: { from: 11, insert: "p" }, selection: { anchor: 12 }, userEvent: "input.type",
        }));
      }
      await act(async () => { acknowledgeSync(); });
      await waitFor(() => expect(workspaceTestHarness.lspMocks.lspCompletion).toHaveBeenCalledWith(
        expect.anything(), { line: 0, character: editWhileWaiting ? 12 : 11 },
        editWhileWaiting ? null : ".", expect.anything(),
      ));
      expect(workspaceTestHarness.lspMocks.lspCompletion.mock.calls.every((call) => call[1].character === (editWhileWaiting ? 12 : 11))).toBe(true);
      await waitFor(() => expect(document.querySelector("li.cm-completion-type-method")).toHaveTextContent("println"));
      expect(workspaceTestHarness.lspMocks.lspSaveDocument).not.toHaveBeenCalled();
    });

    it("never notifies jdtls with didSave and completes on the fast path after saving", async () => {
      const { EditorView } = await import("@codemirror/view");
      const { startCompletion } = await import("@codemirror/autocomplete");
      const workspace: CodeWorkspaceTabInfo = {
        repoRoot: "/repo/app",
        workspaceId: "ws-completion-after-save",
        workspaceInstanceId: "instance-completion-after-save",
        name: "Completion After Save",
        roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
        looseFiles: [],
        initialFile: { kind: "root", rootId: "app", path: "src/App.java" },
      };
      workspaceTestHarness.workspaceMocks.workspaceListDir.mockResolvedValue([workspaceTestHarness.entry("src", "src", "dir")]);
      workspaceTestHarness.workspaceMocks.workspaceReadFile.mockResolvedValue(workspaceTestHarness.file("src/App.java", "System."));
      workspaceTestHarness.workspaceMocks.workspaceWriteFileEncoded.mockResolvedValue(workspaceTestHarness.writeAck(workspaceTestHarness.file(
        "src/App.java",
        "System.out.",
        { hash: "hash-system" },
      )));

      const javaStatus = workspaceTestHarness.documentStatus({
        path: "src/App.java",
        uri: "file:///repo/app/src/App.java",
        presetId: "jdtls",
        languageId: "java",
        displayName: "Java",
        available: true,
        active: true,
      });
      workspaceTestHarness.lspMocks.lspOpenDocument.mockResolvedValue(javaStatus);
      workspaceTestHarness.lspMocks.lspChangeDocument.mockResolvedValue(javaStatus);

      workspaceTestHarness.lspMocks.lspCompletion.mockResolvedValue({
        status: javaStatus,
        isIncomplete: false,
        items: [{
          label: "out",
          kind: 7,
          detail: "PrintStream",
          documentation: null,
          insertText: "out",
          insertTextFormat: 1,
          filterText: null,
          sortText: null,
          textEdit: null,
          additionalTextEdits: [],
          raw: {},
        }],
      });

      const rendered = workspaceTestHarness.renderWorkspace(workspace);
      await screen.findByTitle("app / src/App.java");
      const content = rendered.container.querySelector<HTMLElement>(".cm-content");
      expect(content).not.toBeNull();
      const view = EditorView.findFromDOM(content!);
      expect(view).not.toBeNull();

      // First completion before save
      act(() => {
        view!.dispatch({ selection: { anchor: view!.state.doc.length } });
        startCompletion(view!);
      });
      await waitFor(() => {
        expect(workspaceTestHarness.lspMocks.lspCompletion).toHaveBeenCalled();
      });

      // Make document dirty and save via Ctrl+S
      act(() => {
        view!.dispatch({
          changes: { from: view!.state.doc.length, insert: "out." },
          selection: { anchor: view!.state.doc.length + 4 },
          userEvent: "input.type",
        });
      });
      await waitFor(() => expect(screen.getByTestId("code-workspace-save-observation")).toHaveAttribute("data-dirty", "true"));

      const changesAtSave = workspaceTestHarness.lspMocks.lspChangeDocument.mock.calls.length;
      fireEvent.keyDown(window, { key: "s", code: "KeyS", ctrlKey: true });
      await waitFor(() =>
        expect(screen.getByTestId("code-workspace-save-observation")).toHaveAttribute("data-dirty", "false"),
      );
      // Eclipse JDT LS degrades completions after didSave and can answer the
      // first post-save query from the pre-edit document. The save flow's
      // workspace/didChangeWatchedFiles notification owns the provider rebuild,
      // so didSave must never be sent and no recovery didChange is needed.
      expect(workspaceTestHarness.lspMocks.lspSaveDocument).not.toHaveBeenCalled();
      const changesAfterRecovery = workspaceTestHarness.lspMocks.lspChangeDocument.mock.calls.length;

      // Trigger completion after saving without typing any new characters:
      // the buffer is already synced, so completion must reach lspCompletion
      // directly (fast path) without another didChange round trip.
      act(() => {
        startCompletion(view!);
      });

      await waitFor(() => {
        expect(workspaceTestHarness.lspMocks.lspCompletion.mock.calls.length).toBeGreaterThan(1);
      });
      expect(workspaceTestHarness.lspMocks.lspChangeDocument.mock.calls.length).toBe(changesAfterRecovery);
      expect(workspaceTestHarness.lspMocks.lspChangeDocument.mock.calls.length).toBeGreaterThanOrEqual(changesAtSave);
    });
  });
}
