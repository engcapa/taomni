import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import mermaid from "mermaid";
import { useAppStore } from "../../stores/appStore";
import type { CodeWorkspaceTabInfo } from "../../types";
import type {
  LspDocumentStatus,
  LspServerStatus,
} from "../../lib/editor/lsp";
import type { WorkspaceEntry, WorkspaceFile } from "../../lib/editor/workspace";
import { CodeWorkspaceTab } from "./CodeWorkspaceTab";

const workspaceMocks = vi.hoisted(() => ({
  workspaceListDir: vi.fn(),
  workspaceReadFile: vi.fn(),
  workspaceReadLooseFile: vi.fn(),
  workspaceWriteFile: vi.fn(),
  workspaceWriteLooseFile: vi.fn(),
  workspaceCreateFile: vi.fn(),
  workspaceCreateDir: vi.fn(),
  workspaceDeletePath: vi.fn(),
  workspaceRenamePath: vi.fn(),
}));

const lspMocks = vi.hoisted(() => ({
  lspDetectServers: vi.fn(),
  lspOpenDocument: vi.fn(),
  lspChangeDocument: vi.fn(),
  lspSaveDocument: vi.fn(),
  lspCloseDocument: vi.fn(),
  lspGetDiagnostics: vi.fn(),
  lspHover: vi.fn(),
  lspDefinition: vi.fn(),
  lspReferences: vi.fn(),
}));

const ipcMocks = vi.hoisted(() => ({
  selectFilePath: vi.fn(),
  selectFolderPath: vi.fn(),
}));

vi.mock("../../lib/editor/workspace", () => workspaceMocks);

vi.mock("../../lib/editor/lsp", () => lspMocks);

vi.mock("../../lib/ipc", () => ipcMocks);

vi.mock("../git/diffLanguage", () => ({
  languageForPath: vi.fn(async () => null),
}));

function file(
  path: string,
  text: string,
  overrides: Partial<WorkspaceFile> = {},
): WorkspaceFile {
  return {
    path,
    text,
    size: text.length,
    mtime: 1_788_888_888,
    hash: `hash-${path}`,
    ...overrides,
  };
}

function entry(
  name: string,
  path: string,
  fileType: WorkspaceEntry["fileType"] = "file",
): WorkspaceEntry {
  return {
    name,
    path,
    fileType,
    size: fileType === "file" ? 42 : 0,
    mtime: 1_788_888_888,
    isHidden: false,
  };
}

function csharpStatus(overrides: Partial<LspServerStatus> = {}): LspServerStatus {
  return {
    presetId: "csharp",
    displayName: "C#",
    documentLanguageIds: ["csharp"],
    available: false,
    active: false,
    selectedCommandId: "csharp-ls",
    selectedCommand: "csharp-ls",
    installHint: "dotnet tool install -g csharp-ls",
    error: null,
    commands: [
      {
        id: "csharp-ls",
        label: "csharp-ls",
        command: "csharp-ls",
        args: [],
        installHint: "dotnet tool install -g csharp-ls",
        fallback: false,
        available: false,
      },
      {
        id: "omnisharp",
        label: "OmniSharp",
        command: "omnisharp",
        args: ["--languageserver"],
        installHint: "Install OmniSharp and ensure `omnisharp` is on PATH",
        fallback: true,
        available: false,
      },
    ],
    ...overrides,
  };
}

function documentStatus(overrides: Partial<LspDocumentStatus> = {}): LspDocumentStatus {
  return {
    path: "/repo/app/src/Program.cs",
    uri: "file:///repo/app/src/Program.cs",
    presetId: "csharp",
    languageId: "csharp",
    displayName: "C#",
    available: false,
    active: false,
    selectedCommandId: "csharp-ls",
    selectedCommand: "csharp-ls",
    installHint: "dotnet tool install -g csharp-ls",
    error: null,
    ...overrides,
  };
}

function renderWorkspace(workspace: CodeWorkspaceTabInfo) {
  return render(<CodeWorkspaceTab tabId="tab-code" workspace={workspace} visible />);
}

describe("CodeWorkspaceTab", () => {
  beforeEach(() => {
    window.localStorage.clear();
    useAppStore.setState({
      statusMessage: "Ready",
      codeWorkspaceByTab: {},
    });
    workspaceMocks.workspaceListDir.mockReset();
    workspaceMocks.workspaceReadFile.mockReset();
    workspaceMocks.workspaceReadLooseFile.mockReset();
    workspaceMocks.workspaceWriteFile.mockReset();
    workspaceMocks.workspaceWriteLooseFile.mockReset();
    workspaceMocks.workspaceCreateFile.mockReset();
    workspaceMocks.workspaceCreateDir.mockReset();
    workspaceMocks.workspaceDeletePath.mockReset();
    workspaceMocks.workspaceRenamePath.mockReset();
    lspMocks.lspDetectServers.mockReset();
    lspMocks.lspOpenDocument.mockReset();
    lspMocks.lspChangeDocument.mockReset();
    lspMocks.lspSaveDocument.mockReset();
    lspMocks.lspCloseDocument.mockReset();
    lspMocks.lspGetDiagnostics.mockReset();
    lspMocks.lspHover.mockReset();
    lspMocks.lspDefinition.mockReset();
    lspMocks.lspReferences.mockReset();
    ipcMocks.selectFilePath.mockReset();
    ipcMocks.selectFolderPath.mockReset();
    vi.mocked(mermaid.initialize).mockClear();
    vi.mocked(mermaid.render).mockClear();
    lspMocks.lspDetectServers.mockResolvedValue([]);
    lspMocks.lspOpenDocument.mockResolvedValue(documentStatus());
    lspMocks.lspChangeDocument.mockResolvedValue(documentStatus({ active: true, available: true }));
    lspMocks.lspSaveDocument.mockResolvedValue(documentStatus({ active: true, available: true }));
    lspMocks.lspCloseDocument.mockResolvedValue(documentStatus());
    lspMocks.lspGetDiagnostics.mockResolvedValue({
      status: documentStatus(),
      diagnostics: [],
    });
    workspaceMocks.workspaceListDir.mockResolvedValue([]);
  });

  afterEach(() => {
    cleanup();
  });

  it("opens a multi-root workspace and shows missing C# language server commands", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-multi",
      name: "Multi Repo",
      roots: [
        { id: "app", name: "app", path: "/repo/app", kind: "git" },
        { id: "lib", name: "lib", path: "/repo/lib", kind: "folder" },
      ],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/Program.cs" },
    };
    workspaceMocks.workspaceListDir.mockImplementation(async (rootPath: string) => (
      rootPath === "/repo/app"
        ? [entry("src", "src", "dir")]
        : [entry("README.md", "README.md")]
    ));
    workspaceMocks.workspaceReadFile.mockResolvedValue(file("src/Program.cs", "class Program {}"));
    lspMocks.lspDetectServers.mockResolvedValue([csharpStatus()]);
    lspMocks.lspOpenDocument.mockResolvedValue(documentStatus());

    renderWorkspace(workspace);

    expect(await screen.findByText("Code · Multi Repo")).toBeInTheDocument();
    expect(screen.getByText("2 roots")).toBeInTheDocument();
    expect(screen.getByText("app")).toBeInTheDocument();
    expect(screen.getByText("lib")).toBeInTheDocument();
    expect(await screen.findByText("Language Servers")).toBeInTheDocument();
    expect(await screen.findByText("C#")).toBeInTheDocument();
    expect(screen.getAllByText("dotnet tool install -g csharp-ls")[0]).toBeInTheDocument();

    const commandSelect = screen.getByRole("combobox");
    expect(commandSelect).toHaveValue("csharp-ls");
    expect(within(commandSelect).getByRole("option", { name: "OmniSharp fallback" })).toBeInTheDocument();

    fireEvent.change(commandSelect, { target: { value: "omnisharp" } });
    expect(window.localStorage.getItem("taomni.codeWorkspace.lspCommandPrefs.v1")).toBe(
      JSON.stringify({ csharp: "omnisharp" }),
    );

    fireEvent.change(commandSelect, { target: { value: "__custom__" } });
    fireEvent.change(screen.getByLabelText("C# custom command"), {
      target: { value: "/opt/lsp/csharp-ls" },
    });
    fireEvent.change(screen.getByLabelText("C# custom args"), {
      target: { value: "--stdio --logLevel Debug" },
    });
    expect(window.localStorage.getItem("taomni.codeWorkspace.lspCommandPrefs.v1")).toBe(
      JSON.stringify({ csharp: "__custom__" }),
    );
    expect(window.localStorage.getItem("taomni.codeWorkspace.lspCustomCommands.v1")).toBe(
      JSON.stringify({ csharp: { command: "/opt/lsp/csharp-ls", args: "--stdio --logLevel Debug" } }),
    );

    await waitFor(() => {
      expect(lspMocks.lspOpenDocument).toHaveBeenCalledWith(
        {
          workspaceId: "ws-multi",
          rootPath: "/repo/app",
          filePath: "src/Program.cs",
          serverCommandId: null,
          customServerCommand: null,
        },
        "class Program {}",
        1,
      );
    });
  });

  it("renders Mermaid diagrams in markdown preview with SVG and PNG export controls", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "",
      workspaceId: "ws-md",
      name: "Editor Workspace",
      roots: [],
      looseFiles: [{ id: "readme", name: "README.md", path: "/tmp/README.md" }],
      initialFile: { kind: "loose", id: "readme", path: "/tmp/README.md" },
    };
    workspaceMocks.workspaceReadLooseFile.mockResolvedValue(file(
      "/tmp/README.md",
      [
        "# Diagram",
        "",
        "```mermaid",
        "graph TD",
        "  A-->B",
        "```",
      ].join("\n"),
    ));

    renderWorkspace(workspace);

    await waitFor(() => expect(screen.getAllByText("README.md").length).toBeGreaterThan(0));
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));

    await waitFor(() => {
      const preview = screen.getByTestId("code-workspace-markdown-preview");
      expect(within(preview).getByText("Diagram")).toBeInTheDocument();
      expect(within(preview).getByText("Mermaid 1")).toBeInTheDocument();
      expect(within(preview).getByRole("button", { name: "SVG" })).toBeInTheDocument();
      expect(within(preview).getByRole("button", { name: "PNG" })).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(mermaid.render).toHaveBeenCalledWith(
        expect.stringContaining("taomni-mermaid-"),
        expect.stringContaining("graph TD"),
      );
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
    workspaceMocks.workspaceReadFile.mockResolvedValue(file("src/Program.cs", "class Program {}"));
    lspMocks.lspDetectServers.mockResolvedValue([csharpStatus({ available: true, active: true })]);
    lspMocks.lspOpenDocument.mockResolvedValue(documentStatus({
      active: true,
      available: true,
      selectedCommand: "csharp-ls",
      installHint: null,
    }));
    lspMocks.lspGetDiagnostics.mockResolvedValue({
      status: documentStatus({
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

    renderWorkspace(workspace);

    await waitFor(() => expect(lspMocks.lspGetDiagnostics).toHaveBeenCalled());
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
  });
});
