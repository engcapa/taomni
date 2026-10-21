import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import mermaid from "mermaid";
import { expect, it, vi } from "vitest";
import { useAppStore } from "../../../../../../stores/appStore";
import { selectCodeWorkspaceUi, useCodeWorkspaceStore } from "../../../../../../stores/codeWorkspaceStore";
import type { CodeWorkspaceTabInfo } from "../../../../../../types";
import type { WorkspaceCommandRegistration } from "../../../workspaceCommands";
import { type registerInteractionCasesFixture } from "../../interaction.cases";

export interface registerinteractionNavigation2CasesContext {
  workspaceTestHarness: registerInteractionCasesFixture;
}

export function registerinteractionNavigation2Cases(caseContext: registerinteractionNavigation2CasesContext) {
  it("renders Mermaid diagrams in markdown preview with SVG and PNG export controls", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "",
      workspaceId: "ws-md",
      name: "Editor Workspace",
      roots: [],
      looseFiles: [{ id: "readme", name: "README.md", path: "/tmp/README.md" }],
      initialFile: { kind: "loose", id: "readme", path: "/tmp/README.md" },
    };
    caseContext.workspaceTestHarness.workspaceMocks.workspaceReadLooseFile.mockResolvedValue(caseContext.workspaceTestHarness.file(
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

    caseContext.workspaceTestHarness.renderWorkspace(workspace);

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
  it("shows Git gutter diffs and opt-in inline blame for the active line", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-git-editor",
      workspaceInstanceId: "instance-git-editor",
      name: "Git Editor",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/main.ts" },
    };
    caseContext.workspaceTestHarness.workspaceMocks.workspaceReadFile.mockResolvedValue(caseContext.workspaceTestHarness.file("src/main.ts", "const value = 1;"));
    caseContext.workspaceTestHarness.workspaceMocks.workspaceDetectGitRoots.mockResolvedValue([{
      id: "app",
      name: "app",
      path: "/repo/app",
      repoRoot: "/repo/app",
      rootIds: ["app"],
    }]);
    caseContext.workspaceTestHarness.gitMocks.gitSnapshot.mockResolvedValue({
      repoRoot: "/repo/app",
      currentBranch: "main",
      headOid: "0123456789abcdef",
      detached: false,
      upstream: null,
      ahead: 0,
      behind: 0,
      changes: [],
      remotes: [],
      branches: [],
      stashes: [],
      tags: [],
      settings: {
        userName: null,
        userEmail: null,
        httpProxy: null,
        httpsProxy: null,
        pullRebase: null,
        pushDefault: null,
        coreAutocrlf: null,
        coreFilemode: null,
        commitGpgsign: null,
      },
    });
    caseContext.workspaceTestHarness.gitMocks.gitBlobPair.mockResolvedValue({
      path: "src/main.ts",
      oldPath: null,
      oldText: "const previous = 1;",
      newText: null,
      oldExists: true,
      newExists: false,
      binary: false,
      image: false,
      oldImageB64: null,
      newImageB64: null,
      oversize: false,
      oldSize: 19,
      newSize: 0,
    });
    caseContext.workspaceTestHarness.gitMocks.gitBlameLines.mockResolvedValue([{
      line: 1,
      commit: "0123456789abcdef",
      author: "Ada",
      authorMail: "ada@example.test",
      authorTime: Math.floor(Date.now() / 1000) - 3_600,
      summary: "feat: seed main",
    }]);

    caseContext.workspaceTestHarness.renderWorkspace(workspace);
    await screen.findByTitle("app / src/main.ts");
    await waitFor(() => expect(caseContext.workspaceTestHarness.gitMocks.gitBlobPair).toHaveBeenCalledWith(
      "/repo/app",
      "src/main.ts",
      "HEAD",
      "",
    ));
    const marker = await screen.findByLabelText("modified Git change · show diff", {}, { timeout: 5_000 });
    fireEvent.mouseDown(marker);
    expect(screen.getByTestId("code-workspace-git-diff-peek")).toHaveTextContent("previous");
    expect(screen.getByTestId("code-workspace-git-diff-peek")).toHaveTextContent("value");

    const blameToggle = caseContext.workspaceTestHarness.toolbarControl("code-workspace-inline-blame-toggle");
    expect(blameToggle).not.toBeDisabled();
    fireEvent.click(blameToggle);
    await waitFor(() => expect(caseContext.workspaceTestHarness.gitMocks.gitBlameLines).toHaveBeenCalledWith("/repo/app", "src/main.ts", 1, 1));
    expect(await screen.findByText(/Ada, .* · feat: seed main/)).toBeInTheDocument();
  });
  it("resolves URI-only workspace symbols before opening their source range", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-symbol-resolve",
      workspaceInstanceId: "instance-symbol-resolve",
      name: "Symbol Resolve",
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
      workspaceSymbol: true,
      workspaceSymbolResolve: true,
      rename: false,
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
    const activeStatus = caseContext.workspaceTestHarness.documentStatus({ available: true, active: true, capabilities });
    const lifecycle: string[] = [];
    caseContext.workspaceTestHarness.workspaceMocks.workspaceReadFile.mockImplementation(async (_root: string, path: string) => {
      if (path === "src/target.ts") lifecycle.push("read-target");
      return caseContext.workspaceTestHarness.file(path, path === "src/target.ts" ? "\n".repeat(8) + "class DeferredType {}" : "const main = true;");
    });
    caseContext.workspaceTestHarness.lspMocks.lspOpenDocument.mockResolvedValue(activeStatus);
    caseContext.workspaceTestHarness.lspMocks.lspChangeDocument.mockResolvedValue(activeStatus);
    caseContext.workspaceTestHarness.lspMocks.lspGetDiagnostics.mockResolvedValue({ status: activeStatus, diagnostics: [] });
    caseContext.workspaceTestHarness.lspMocks.lspWorkspaceSymbols.mockResolvedValue({
      status: activeStatus,
      symbols: [{
        name: "DeferredType",
        kind: 5,
        containerName: "editor",
        uri: "file:///repo/app/src/target.ts",
        path: "/repo/app/src/target.ts",
        range: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 0 },
        },
        selectionRange: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 0 },
        },
        resolved: false,
        resolveToken: "0123456789abcdef0123456789abcdef:0",
      }, {
        name: "BrokenType",
        kind: 5,
        containerName: "editor",
        uri: "file:///repo/app/src/broken.ts",
        path: "/repo/app/src/broken.ts",
        range: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 0 },
        },
        selectionRange: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 0 },
        },
        resolved: false,
        resolveToken: null,
      }],
      sessionCount: 1,
      providerCount: 1,
      skippedProviderCount: 0,
      failedProviderCount: 0,
      complete: true,
      truncated: false,
      diagnostics: [],
    });
    caseContext.workspaceTestHarness.lspMocks.lspWorkspaceSymbolResolve.mockImplementation(async () => {
      lifecycle.push("resolve");
      return {
        name: "DeferredType",
        kind: 5,
        containerName: "editor",
        uri: "file:///repo/app/src/target.ts",
        path: "/repo/app/src/target.ts",
        range: {
          start: { line: 8, character: 0 },
          end: { line: 8, character: 21 },
        },
        selectionRange: {
          start: { line: 8, character: 6 },
          end: { line: 8, character: 18 },
        },
        resolved: true,
        resolveToken: null,
      };
    });
    const registrationRef: { current: WorkspaceCommandRegistration | null; } = { current: null };
    const onCommandsChange = vi.fn((_tabId: string, next: WorkspaceCommandRegistration | null) => {
      registrationRef.current = next;
    });

    caseContext.workspaceTestHarness.renderWorkspace(workspace, { onCommandsChange });
    await screen.findByTitle("app / src/main.ts");
    await waitFor(() => {
      expect(registrationRef.current?.items.find((item) => item.id === "workspace.goToSymbol")?.enabled)
        .toBe(true);
    });
    act(() => {
      expect(registrationRef.current?.execute("workspace.goToSymbol")).toBe(true);
    });
    const input = await screen.findByLabelText("Go to symbol");
    fireEvent.change(input, { target: { value: "Deferred" } });
    expect(await screen.findByText("DeferredType")).toBeInTheDocument();
    expect(screen.queryByText("editor · /repo/app/src/target.ts:1")).not.toBeInTheDocument();

    fireEvent.keyDown(input, { key: "Enter", ctrlKey: true });
    await waitFor(() => expect(caseContext.workspaceTestHarness.lspMocks.lspWorkspaceSymbolResolve).toHaveBeenCalledWith(
      "instance-symbol-resolve",
      "0123456789abcdef0123456789abcdef:0",
    ));
    expect(await screen.findByTitle("app / src/target.ts")).toBeInTheDocument();
    expect(lifecycle).toEqual(["resolve", "read-target"]);
    expect(selectCodeWorkspaceUi(
      useCodeWorkspaceStore.getState(),
      "instance-symbol-resolve",
    ).splitOrientation).toBe("vertical");

    act(() => {
      expect(registrationRef.current?.execute("workspace.goToSymbol")).toBe(true);
    });
    const brokenInput = await screen.findByLabelText("Go to symbol");
    fireEvent.change(brokenInput, { target: { value: "Broken" } });
    expect(await screen.findByText("BrokenType")).toBeInTheDocument();
    fireEvent.keyDown(brokenInput, { key: "Enter" });
    await waitFor(() => expect(useAppStore.getState().statusMessage).toContain(
      "did not provide a source location",
    ));
    expect(caseContext.workspaceTestHarness.lspMocks.lspWorkspaceSymbolResolve).toHaveBeenCalledTimes(1);
    expect(screen.queryByTitle("app / src/broken.ts")).not.toBeInTheDocument();
  });
  it("opens the persistent Outline pane and follows document symbols", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-outline",
      workspaceInstanceId: "instance-outline",
      name: "Outline",
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
      documentHighlight: false,
      callHierarchy: false,
      typeHierarchy: false,
      inlayHint: false,
      selectionRange: false,
      semanticTokens: false,
      completionTriggerCharacters: [],
      signatureTriggerCharacters: [],
    };
    const status = caseContext.workspaceTestHarness.documentStatus({ available: true, active: true, capabilities });
    caseContext.workspaceTestHarness.workspaceMocks.workspaceReadFile.mockResolvedValue(caseContext.workspaceTestHarness.file("src/main.ts", "function render() {}"));
    caseContext.workspaceTestHarness.lspMocks.lspOpenDocument.mockResolvedValue(status);
    caseContext.workspaceTestHarness.lspMocks.lspChangeDocument.mockResolvedValue(status);
    caseContext.workspaceTestHarness.lspMocks.lspGetDiagnostics.mockResolvedValue({ status, diagnostics: [] });
    caseContext.workspaceTestHarness.lspMocks.lspDocumentSymbols.mockResolvedValue({
      status,
      symbols: [{
        name: "render",
        detail: "() => void",
        kind: 12,
        depth: 0,
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 20 } },
        selectionRange: { start: { line: 0, character: 9 }, end: { line: 0, character: 15 } },
      }],
    });

    caseContext.workspaceTestHarness.renderWorkspace(workspace);
    await screen.findByTitle("app / src/main.ts");
    await waitFor(() => expect(caseContext.workspaceTestHarness.lspMocks.lspDocumentSymbols).toHaveBeenCalled());
    fireEvent.click(caseContext.workspaceTestHarness.toolbarControl("code-workspace-right-pane-toggle"));

    // ED-PARITY-024: IDEA Structure is its own tool window (left bottom by default).
    const structureWindow = await screen.findByTestId("code-workspace-tool-window-structure");
    expect(within(structureWindow).getByTestId("code-workspace-tool-window-title-structure")).toHaveTextContent("Structure");
    const outline = await screen.findByTestId("code-workspace-outline-pane");
    expect(outline).toHaveTextContent("render");
    fireEvent.click(within(outline).getByText("render"));
  });
  it("opens quick documentation with Ctrl+Q, navigates to its exact source, and pins it", async () => {
    const { EditorView } = await import("@codemirror/view");
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-qdoc",
      workspaceInstanceId: "instance-qdoc",
      name: "QuickDoc",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/main.ts" },
    };
    caseContext.workspaceTestHarness.workspaceMocks.workspaceListDir.mockResolvedValue([caseContext.workspaceTestHarness.entry("src", "src", "dir")]);
    caseContext.workspaceTestHarness.workspaceMocks.workspaceReadFile.mockResolvedValue(caseContext.workspaceTestHarness.file("src/main.ts", "openFile(path)"));
    const status = caseContext.workspaceTestHarness.documentStatus({
      path: "/repo/app/src/main.ts",
      uri: "file:///repo/app/src/main.ts",
      available: true,
      active: true,
    });
    caseContext.workspaceTestHarness.lspMocks.lspOpenDocument.mockResolvedValue(status);
    caseContext.workspaceTestHarness.lspMocks.lspHover.mockResolvedValue({
      status,
      contents: "**Opens** a workspace file.",
      range: {
        start: { line: 0, character: 9 },
        end: { line: 0, character: 13 },
      },
    });

    const rendered = caseContext.workspaceTestHarness.renderWorkspace(workspace);
    await screen.findByTitle("app / src/main.ts");
    await waitFor(() => expect(caseContext.workspaceTestHarness.lspMocks.lspOpenDocument).toHaveBeenCalled());
    const editorContent = rendered.container.querySelector<HTMLElement>(".cm-content");
    expect(editorContent).not.toBeNull();
    const view = EditorView.findFromDOM(editorContent!);
    expect(view).not.toBeNull();

    fireEvent.keyDown(window, { key: "q", ctrlKey: true });
    const popup = await screen.findByTestId("code-workspace-quick-doc");
    expect(popup).toHaveTextContent("Opens");
    expect(caseContext.workspaceTestHarness.lspMocks.lspHover).toHaveBeenCalled();

    fireEvent.click(within(popup).getByRole("button", { name: "Source" }));
    await waitFor(() => expect(view!.state.selection.main.head).toBe(9));

    fireEvent.keyDown(window, { key: "q", ctrlKey: true });
    await screen.findByTestId("code-workspace-quick-doc");
    fireEvent.click(screen.getByTestId("code-workspace-quick-doc-pin"));
    expect(screen.queryByTestId("code-workspace-quick-doc")).not.toBeInTheDocument();
    expect(screen.getByTestId("code-workspace-right-pane")).toBeInTheDocument();
    expect(screen.getByTestId("code-workspace-documentation-pane")).toHaveTextContent("Opens");
  });
  it("routes explicit QuickDoc to the unlocked Documentation pane when configured", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-qdoc-tool-window",
      workspaceInstanceId: "instance-qdoc-tool-window",
      name: "QuickDoc tool window",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/main.ts" },
    };
    window.localStorage.setItem(
      "taomni.codeWorkspace.intelligence.v1.instance-qdoc-tool-window",
      JSON.stringify({ quickDoc: { defaultTarget: "tool-window" } }),
    );
    caseContext.workspaceTestHarness.workspaceMocks.workspaceListDir.mockResolvedValue([caseContext.workspaceTestHarness.entry("src", "src", "dir")]);
    caseContext.workspaceTestHarness.workspaceMocks.workspaceReadFile.mockResolvedValue(caseContext.workspaceTestHarness.file("src/main.ts", "openFile(path)"));
    const status = caseContext.workspaceTestHarness.documentStatus({
      path: "/repo/app/src/main.ts",
      uri: "file:///repo/app/src/main.ts",
      available: true,
      active: true,
    });
    caseContext.workspaceTestHarness.lspMocks.lspOpenDocument.mockResolvedValue(status);
    caseContext.workspaceTestHarness.lspMocks.lspHover.mockResolvedValue({
      status,
      contents: "**Opens** a workspace file.",
      range: {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 8 },
      },
    });

    caseContext.workspaceTestHarness.renderWorkspace(workspace);
    await screen.findByTitle("app / src/main.ts");
    await waitFor(() => expect(caseContext.workspaceTestHarness.lspMocks.lspOpenDocument).toHaveBeenCalled());
    fireEvent.keyDown(window, { key: "q", ctrlKey: true });

    const pane = await screen.findByTestId("code-workspace-documentation-pane");
    expect(pane).toHaveTextContent("Opens");
    expect(await screen.findByTestId("code-workspace-tool-window-documentation")).toBeInTheDocument();
    expect(screen.queryByTestId("code-workspace-quick-doc")).not.toBeInTheDocument();
    expect(within(pane).queryByLabelText("Pinned")).not.toBeInTheDocument();
    expect(within(pane).queryByRole("button", { name: "Unpin documentation" })).not.toBeInTheDocument();
  });
}
