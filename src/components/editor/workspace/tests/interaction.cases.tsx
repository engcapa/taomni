import { EditorView } from "@codemirror/view";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import mermaid from "mermaid";
import { useCallback, useRef, useState, type ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";
import { confirmAppDialog } from "../../../../lib/appDialogs";
import { useAppStore } from "../../../../stores/appStore";
import { selectCodeWorkspaceUi, useCodeWorkspaceStore } from "../../../../stores/codeWorkspaceStore";
import type { CodeWorkspaceTabInfo } from "../../../../types";
import { CodeWorkspaceTab } from "../../CodeWorkspaceTab";
import type { WorkspaceTestFixture } from "../../CodeWorkspaceTab.test";
import { ACCEPTED_IDEA_KEYMAP_DIFFERENCES } from "../__fixtures__/ideaKeymapAcceptedDifferences";
import { IDEA_XWIN_KEYMAP } from "../__fixtures__/ideaXWinKeymap";
import { WorkspaceLocationController } from "../navigationHistoryModel";
import type { WorkspaceCommandRegistration } from "../workspaceCommands";
import { setKeymapPlatformOverride } from "../workspaceKeymapPlatform";
import { resetKeymapDefaultsMigrationNoticeForTests } from "../workspaceKeymapScheme";
import { WORKSPACE_RECOVERY_STORAGE_PREFIX } from "../workspaceRecovery";
import { registerNavigationCases } from "./navigation.cases";
import { registerExecutionCases } from "./execution.cases";
import { registerCompareCases } from "./compare.cases";

export type registerInteractionCasesFixture = Pick<WorkspaceTestFixture, "projectFactsMock" | "descriptorDiscoveryMock" | "renderWorkspace" | "clipboardMocks" | "workspaceMocks" | "entry" | "file" | "gitMocks" | "toolbarControl" | "documentStatus" | "lspMocks" | "defaultCapabilities" | "writeAck" | "runtimeState" | "dapMocks" | "ipcMocks" | "localHistoryMocks" | "confirmWorkspaceUndo">;

export function registerInteractionCases(workspaceTestHarness: registerInteractionCasesFixture) {
it("mounts project facts for the workspace root and routes status refresh to the store", async () => {
    workspaceTestHarness.projectFactsMock.state.status = "loading";
    workspaceTestHarness.projectFactsMock.state.reason = "Loading project build facts...";
    workspaceTestHarness.projectFactsMock.state.generation = 4;
    workspaceTestHarness.descriptorDiscoveryMock.state.status = "descriptor-only";
    workspaceTestHarness.descriptorDiscoveryMock.state.discovery = {
      status: "descriptor-only",
      generation: 1,
      descriptors: [{
        path: "/repo/app/pom.xml",
        buildSystem: "maven",
        name: "app",
        root: "/repo/app",
        rawContentSha256: "descriptor-hash",
        inferredExcludedRoots: ["/repo/app/target"],
      }],
      excludedRoots: ["/repo/app/target"],
      diagnostics: [],
    };

    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-project-facts",
      workspaceInstanceId: "instance-project-facts",
      name: "Project Facts",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
    };

    workspaceTestHarness.renderWorkspace(workspace);

    expect(await screen.findByTestId("project-facts-status-badge")).toHaveTextContent("Maven Discovered");
    expect(await screen.findByTestId("project-facts-status-badge")).toHaveTextContent("Loading Facts");
    expect(workspaceTestHarness.projectFactsMock.useProjectFacts).toHaveBeenCalledWith(
      "/repo/app",
      expect.objectContaining({ autoFetch: true }),
    );
    expect(workspaceTestHarness.descriptorDiscoveryMock.useProjectDescriptorDiscovery).toHaveBeenCalledWith(
      "/repo/app",
      { autoRefresh: true },
    );

    fireEvent.click(screen.getByTestId("project-facts-refresh-btn"));
    expect(workspaceTestHarness.projectFactsMock.refresh).toHaveBeenCalledTimes(1);
    expect(workspaceTestHarness.descriptorDiscoveryMock.refresh).toHaveBeenCalledTimes(1);
  });
it("keeps the analysis panel mounted when an imported baseline is invalid", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "",
      workspaceId: "ws-invalid-baseline",
      workspaceInstanceId: "instance-invalid-baseline",
      name: "Invalid Baseline",
      roots: [],
      looseFiles: [],
    };
    workspaceTestHarness.clipboardMocks.readText.mockResolvedValueOnce("not json");

    workspaceTestHarness.renderWorkspace(workspace);

    fireEvent.click(screen.getByTestId("code-workspace-bottom-tab-analysis"));
    expect(await screen.findByTestId("code-workspace-analysis-panel")).toBeVisible();
    fireEvent.click(screen.getByTestId("analysis-baseline-import"));

    await waitFor(() => expect(useAppStore.getState().statusMessage).toBe(
      "Inspection baseline is not valid JSON",
    ));
    expect(screen.getByTestId("analysis-inspection-suppressions")).toBeVisible();
    expect(screen.getByTestId("code-workspace-tab")).toBeVisible();
  });
it("persists editor intelligence settings per workspace and reloads defaults after rebinding", async () => {
    const first: CodeWorkspaceTabInfo = {
      repoRoot: "",
      workspaceId: "ws-intelligence-settings-a",
      workspaceInstanceId: "instance-intelligence-settings-a",
      name: "Intelligence Settings A",
      roots: [],
      looseFiles: [],
    };
    const second: CodeWorkspaceTabInfo = {
      ...first,
      workspaceId: "ws-intelligence-settings-b",
      workspaceInstanceId: "instance-intelligence-settings-b",
      name: "Intelligence Settings B",
    };
    const registrationRef: { current: WorkspaceCommandRegistration | null } = { current: null };
    const onCommandsChange = vi.fn((_tabId: string, next: WorkspaceCommandRegistration | null) => {
      if (next) registrationRef.current = next;
    });
    const rendered = workspaceTestHarness.renderWorkspace(first, { onCommandsChange });
    await screen.findByText("Code · Intelligence Settings A");
    await waitFor(() => expect(
      registrationRef.current?.items.some((item) => item.id === "workspace.intelligenceSettings"),
    ).toBe(true));

    act(() => {
      expect(registrationRef.current?.execute("workspace.intelligenceSettings")).toBe(true);
    });
    await screen.findByTestId("workspace-intelligence-settings-dialog");
    fireEvent.click(screen.getByTestId("workspace-quick-doc-hover-enabled"));
    fireEvent.change(screen.getByTestId("workspace-quick-doc-hover-delay"), {
      target: { value: "825" },
    });
    fireEvent.change(screen.getByTestId("workspace-quick-doc-default-target"), {
      target: { value: "tool-window" },
    });
    fireEvent.click(screen.getByTestId("workspace-parameter-info-auto-popup"));
    fireEvent.change(screen.getByTestId("workspace-parameter-info-delay"), {
      target: { value: "275" },
    });
    fireEvent.click(screen.getByTestId("workspace-intelligence-settings-apply"));

    expect(JSON.parse(
      window.localStorage.getItem(
        "taomni.codeWorkspace.intelligence.v1.instance-intelligence-settings-a",
      ) ?? "null",
    )).toEqual(expect.objectContaining({
      quickDoc: {
        showOnHover: false,
        hoverDelayMs: 825,
        defaultTarget: "tool-window",
      },
      parameterInfo: {
        autoPopup: false,
        delayMs: 275,
        showFullSignatures: false,
      },
    }));
    expect(window.localStorage.getItem(
      "taomni.codeWorkspace.intelligence.v1.instance-intelligence-settings-b",
    )).toBeNull();

    rendered.rerender(
      <CodeWorkspaceTab
        tabId="tab-code"
        workspace={second}
        visible
        onCommandsChange={onCommandsChange}
      />,
    );
    await screen.findByText("Code · Intelligence Settings B");
    await waitFor(() => expect(
      registrationRef.current?.items.some((item) => item.id === "workspace.intelligenceSettings"),
    ).toBe(true));
    act(() => {
      expect(registrationRef.current?.execute("workspace.intelligenceSettings")).toBe(true);
    });

    await screen.findByTestId("workspace-intelligence-settings-dialog");
    expect(screen.getByTestId("workspace-quick-doc-hover-enabled")).toBeChecked();
    expect(screen.getByTestId("workspace-quick-doc-hover-delay")).toHaveValue(300);
    expect(screen.getByTestId("workspace-quick-doc-default-target")).toHaveValue("popup");
    expect(screen.getByTestId("workspace-parameter-info-auto-popup")).toBeChecked();
    expect(screen.getByTestId("workspace-parameter-info-delay")).toHaveValue(0);
  });
it("settles when the parent stores command registrations in state", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "",
      workspaceId: "ws-registration-feedback",
      workspaceInstanceId: "instance-registration-feedback",
      name: "Registration Feedback Workspace",
      roots: [],
      looseFiles: [],
    };
    let parentRenderCount = 0;

    function RegistrationHost() {
      const renderCount = useRef(0);
      renderCount.current += 1;
      parentRenderCount = Math.max(parentRenderCount, renderCount.current);
      if (renderCount.current > 20) {
        throw new Error("Command registration feedback did not settle");
      }

      const [, setRegistrations] = useState<Record<string, unknown>>({});
      const handleCommandsChange = useCallback<
        NonNullable<ComponentProps<typeof CodeWorkspaceTab>["onCommandsChange"]>
      >((tabId, registration) => {
        setRegistrations((current) => {
          if (registration) {
            return current[tabId] === registration
              ? current
              : { ...current, [tabId]: registration };
          }
          if (!(tabId in current)) return current;
          const next = { ...current };
          delete next[tabId];
          return next;
        });
      }, []);

      return (
        <CodeWorkspaceTab
          tabId="tab-code-feedback"
          workspace={workspace}
          visible
          onCommandsChange={handleCommandsChange}
        />
      );
    }

    render(<RegistrationHost />);

    expect(await screen.findByText("Code · Registration Feedback Workspace")).toBeInTheDocument();
    await act(async () => {
      await Promise.resolve();
    });
    expect(parentRenderCount).toBeGreaterThan(1);
    expect(parentRenderCount).toBeLessThan(20);
  });
it("ED-FINDFOCUS-001 leaves Find Enter and Escape to the real panel in the workspace capture phase", async () => {
    const { EditorView } = await import("@codemirror/view");
    const source = "Project tree example\nThe editor buffer should survive tree navigation.\n";
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app", workspaceId: "ws-find-focus", workspaceInstanceId: "instance-find-focus",
      name: "Find Focus", roots: [{ id: "app", name: "app", path: "/repo/app", kind: "folder" }],
      looseFiles: [], initialFile: { kind: "root", rootId: "app", path: "example.txt" },
    };
    workspaceTestHarness.workspaceMocks.workspaceListDir.mockResolvedValue([workspaceTestHarness.entry("example.txt", "example.txt")]);
    workspaceTestHarness.workspaceMocks.workspaceReadFile.mockResolvedValue(workspaceTestHarness.file("example.txt", source));
    const rendered = workspaceTestHarness.renderWorkspace(workspace);
    await screen.findByTitle("app / example.txt");
    const content = rendered.container.querySelector<HTMLElement>(".cm-content")!;
    const view = EditorView.findFromDOM(content)!;
    act(() => { content.focus(); });
    fireEvent.keyDown(content, { key: "f", code: "KeyF", ctrlKey: true });
    const field = await screen.findByRole("searchbox", { name: "Find" });
    await waitFor(() => expect(field).toHaveFocus());
    fireEvent.input(field, { target: { value: "tree" } });
    expect(view.state.selection.main).toMatchObject({ from: 8, to: 12 });
    fireEvent.keyDown(field, { key: "Enter", code: "Enter" });
    expect(view.state.selection.main).toMatchObject({ from: 54, to: 58 });
    expect(view.state.doc.toString()).toBe(source);
    expect(field).toHaveFocus();
    fireEvent.keyDown(field, { key: "Enter", code: "Enter", shiftKey: true });
    expect(view.state.selection.main).toMatchObject({ from: 8, to: 12 });
    fireEvent.keyDown(field, { key: "Escape", code: "Escape" });
    expect(view.hasFocus).toBe(true);
    expect(view.state.doc.toString()).toBe(source);
    expect(screen.queryByTestId("code-workspace-editor-search")).toBeNull();
  });
registerNavigationCases(workspaceTestHarness);
it("renders Mermaid diagrams in markdown preview with SVG and PNG export controls", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "",
      workspaceId: "ws-md",
      name: "Editor Workspace",
      roots: [],
      looseFiles: [{ id: "readme", name: "README.md", path: "/tmp/README.md" }],
      initialFile: { kind: "loose", id: "readme", path: "/tmp/README.md" },
    };
    workspaceTestHarness.workspaceMocks.workspaceReadLooseFile.mockResolvedValue(workspaceTestHarness.file(
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

    workspaceTestHarness.renderWorkspace(workspace);

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
    workspaceTestHarness.workspaceMocks.workspaceReadFile.mockResolvedValue(workspaceTestHarness.file("src/main.ts", "const value = 1;"));
    workspaceTestHarness.workspaceMocks.workspaceDetectGitRoots.mockResolvedValue([{
      id: "app",
      name: "app",
      path: "/repo/app",
      repoRoot: "/repo/app",
      rootIds: ["app"],
    }]);
    workspaceTestHarness.gitMocks.gitSnapshot.mockResolvedValue({
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
    workspaceTestHarness.gitMocks.gitBlobPair.mockResolvedValue({
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
    workspaceTestHarness.gitMocks.gitBlameLines.mockResolvedValue([{
      line: 1,
      commit: "0123456789abcdef",
      author: "Ada",
      authorMail: "ada@example.test",
      authorTime: Math.floor(Date.now() / 1000) - 3_600,
      summary: "feat: seed main",
    }]);

    workspaceTestHarness.renderWorkspace(workspace);
    await screen.findByTitle("app / src/main.ts");
    await waitFor(() => expect(workspaceTestHarness.gitMocks.gitBlobPair).toHaveBeenCalledWith(
      "/repo/app",
      "src/main.ts",
      "HEAD",
      "",
    ));
    const marker = await screen.findByLabelText("modified Git change · show diff", {}, { timeout: 5_000 });
    fireEvent.mouseDown(marker);
    expect(screen.getByTestId("code-workspace-git-diff-peek")).toHaveTextContent("previous");
    expect(screen.getByTestId("code-workspace-git-diff-peek")).toHaveTextContent("value");

    const blameToggle = workspaceTestHarness.toolbarControl("code-workspace-inline-blame-toggle");
    expect(blameToggle).not.toBeDisabled();
    fireEvent.click(blameToggle);
    await waitFor(() => expect(workspaceTestHarness.gitMocks.gitBlameLines).toHaveBeenCalledWith("/repo/app", "src/main.ts", 1, 1));
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
    const activeStatus = workspaceTestHarness.documentStatus({ available: true, active: true, capabilities });
    const lifecycle: string[] = [];
    workspaceTestHarness.workspaceMocks.workspaceReadFile.mockImplementation(async (_root: string, path: string) => {
      if (path === "src/target.ts") lifecycle.push("read-target");
      return workspaceTestHarness.file(path, path === "src/target.ts" ? "\n".repeat(8) + "class DeferredType {}" : "const main = true;");
    });
    workspaceTestHarness.lspMocks.lspOpenDocument.mockResolvedValue(activeStatus);
    workspaceTestHarness.lspMocks.lspChangeDocument.mockResolvedValue(activeStatus);
    workspaceTestHarness.lspMocks.lspGetDiagnostics.mockResolvedValue({ status: activeStatus, diagnostics: [] });
    workspaceTestHarness.lspMocks.lspWorkspaceSymbols.mockResolvedValue({
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
    workspaceTestHarness.lspMocks.lspWorkspaceSymbolResolve.mockImplementation(async () => {
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
    const registrationRef: { current: WorkspaceCommandRegistration | null } = { current: null };
    const onCommandsChange = vi.fn((_tabId: string, next: WorkspaceCommandRegistration | null) => {
      registrationRef.current = next;
    });

    workspaceTestHarness.renderWorkspace(workspace, { onCommandsChange });
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
    await waitFor(() => expect(workspaceTestHarness.lspMocks.lspWorkspaceSymbolResolve).toHaveBeenCalledWith(
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
    expect(workspaceTestHarness.lspMocks.lspWorkspaceSymbolResolve).toHaveBeenCalledTimes(1);
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
    const status = workspaceTestHarness.documentStatus({ available: true, active: true, capabilities });
    workspaceTestHarness.workspaceMocks.workspaceReadFile.mockResolvedValue(workspaceTestHarness.file("src/main.ts", "function render() {}"));
    workspaceTestHarness.lspMocks.lspOpenDocument.mockResolvedValue(status);
    workspaceTestHarness.lspMocks.lspChangeDocument.mockResolvedValue(status);
    workspaceTestHarness.lspMocks.lspGetDiagnostics.mockResolvedValue({ status, diagnostics: [] });
    workspaceTestHarness.lspMocks.lspDocumentSymbols.mockResolvedValue({
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

    workspaceTestHarness.renderWorkspace(workspace);
    await screen.findByTitle("app / src/main.ts");
    await waitFor(() => expect(workspaceTestHarness.lspMocks.lspDocumentSymbols).toHaveBeenCalled());
    fireEvent.click(workspaceTestHarness.toolbarControl("code-workspace-right-pane-toggle"));

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
    workspaceTestHarness.workspaceMocks.workspaceListDir.mockResolvedValue([workspaceTestHarness.entry("src", "src", "dir")]);
    workspaceTestHarness.workspaceMocks.workspaceReadFile.mockResolvedValue(workspaceTestHarness.file("src/main.ts", "openFile(path)"));
    const status = workspaceTestHarness.documentStatus({
      path: "/repo/app/src/main.ts",
      uri: "file:///repo/app/src/main.ts",
      available: true,
      active: true,
    });
    workspaceTestHarness.lspMocks.lspOpenDocument.mockResolvedValue(status);
    workspaceTestHarness.lspMocks.lspHover.mockResolvedValue({
      status,
      contents: "**Opens** a workspace file.",
      range: {
        start: { line: 0, character: 9 },
        end: { line: 0, character: 13 },
      },
    });

    const rendered = workspaceTestHarness.renderWorkspace(workspace);
    await screen.findByTitle("app / src/main.ts");
    await waitFor(() => expect(workspaceTestHarness.lspMocks.lspOpenDocument).toHaveBeenCalled());
    const editorContent = rendered.container.querySelector<HTMLElement>(".cm-content");
    expect(editorContent).not.toBeNull();
    const view = EditorView.findFromDOM(editorContent!);
    expect(view).not.toBeNull();

    fireEvent.keyDown(window, { key: "q", ctrlKey: true });
    const popup = await screen.findByTestId("code-workspace-quick-doc");
    expect(popup).toHaveTextContent("Opens");
    expect(workspaceTestHarness.lspMocks.lspHover).toHaveBeenCalled();

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
    workspaceTestHarness.workspaceMocks.workspaceListDir.mockResolvedValue([workspaceTestHarness.entry("src", "src", "dir")]);
    workspaceTestHarness.workspaceMocks.workspaceReadFile.mockResolvedValue(workspaceTestHarness.file("src/main.ts", "openFile(path)"));
    const status = workspaceTestHarness.documentStatus({
      path: "/repo/app/src/main.ts",
      uri: "file:///repo/app/src/main.ts",
      available: true,
      active: true,
    });
    workspaceTestHarness.lspMocks.lspOpenDocument.mockResolvedValue(status);
    workspaceTestHarness.lspMocks.lspHover.mockResolvedValue({
      status,
      contents: "**Opens** a workspace file.",
      range: {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 8 },
      },
    });

    workspaceTestHarness.renderWorkspace(workspace);
    await screen.findByTitle("app / src/main.ts");
    await waitFor(() => expect(workspaceTestHarness.lspMocks.lspOpenDocument).toHaveBeenCalled());
    fireEvent.keyDown(window, { key: "q", ctrlKey: true });

    const pane = await screen.findByTestId("code-workspace-documentation-pane");
    expect(pane).toHaveTextContent("Opens");
    expect(await screen.findByTestId("code-workspace-tool-window-documentation")).toBeInTheDocument();
    expect(screen.queryByTestId("code-workspace-quick-doc")).not.toBeInTheDocument();
    expect(within(pane).queryByLabelText("Pinned")).not.toBeInTheDocument();
    expect(within(pane).queryByRole("button", { name: "Unpin documentation" })).not.toBeInTheDocument();
  });
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
    workspaceTestHarness.workspaceMocks.workspaceListDir.mockResolvedValue([workspaceTestHarness.entry("src", "src", "dir")]);
    workspaceTestHarness.workspaceMocks.workspaceReadFile.mockResolvedValue(workspaceTestHarness.file("src/main.ts", "x=1"));
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
        title: "Vanishing fix",
        kind: "quickfix",
        isPreferred: true,
        edit: null,
        command: null,
        commandArguments: null,
        raw: { title: "Vanishing fix", data: { fixId: "vanish" } },
      }],
    });
    workspaceTestHarness.lspMocks.lspCodeActionResolve.mockResolvedValue({
      status: workspaceTestHarness.documentStatus({ available: true, active: true }),
      action: null,
    });

    workspaceTestHarness.renderWorkspace(workspace);
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
    const status = workspaceTestHarness.documentStatus({
      path: "/repo/app/src/main.ts",
      uri: "file:///repo/app/src/main.ts",
      available: true,
      active: true,
      capabilities: workspaceTestHarness.defaultCapabilities({ codeAction: true }),
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
    workspaceTestHarness.workspaceMocks.workspaceListDir.mockResolvedValue([workspaceTestHarness.entry("src", "src", "dir")]);
    workspaceTestHarness.workspaceMocks.workspaceReadFile.mockResolvedValue(workspaceTestHarness.file("src/main.ts", "x=1"));
    workspaceTestHarness.workspaceMocks.workspaceWriteFileEncoded.mockImplementation(async (
      _rootPath: string,
      path: string,
      text: string,
    ) => workspaceTestHarness.writeAck(workspaceTestHarness.file(path, text, { hash: `hash-${text}` })));
    workspaceTestHarness.lspMocks.lspOpenDocument.mockResolvedValue(status);
    workspaceTestHarness.lspMocks.lspCodeActions.mockResolvedValue({ status, actions: [deferredAction] });
    workspaceTestHarness.lspMocks.lspCodeActionResolve
      .mockRejectedValueOnce(new Error("resolve transport unavailable"))
      .mockResolvedValueOnce({ status, action: resolvedAction });

    workspaceTestHarness.renderWorkspace(workspace);
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
    expect(workspaceTestHarness.lspMocks.lspCodeActionResolve).toHaveBeenCalledTimes(1);

    fireEvent.click(retry);
    await waitFor(() => expect(workspaceTestHarness.lspMocks.lspCodeActionResolve).toHaveBeenCalledTimes(2));
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
    const status = workspaceTestHarness.documentStatus({
      path: "/repo/app/src/main.ts",
      available: true,
      active: true,
      capabilities: workspaceTestHarness.defaultCapabilities({ codeAction: true }),
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
    workspaceTestHarness.workspaceMocks.workspaceListDir.mockResolvedValue([workspaceTestHarness.entry("src", "src", "dir")]);
    workspaceTestHarness.workspaceMocks.workspaceReadFile.mockResolvedValue(workspaceTestHarness.file("src/main.ts", "x"));
    workspaceTestHarness.lspMocks.lspOpenDocument.mockResolvedValue(status);
    workspaceTestHarness.lspMocks.lspGetDiagnostics.mockResolvedValue({ status, diagnostics: [diagnostic] });
    workspaceTestHarness.lspMocks.lspCodeActions.mockResolvedValue({ status, actions: [action] });

    const rendered = workspaceTestHarness.renderWorkspace(workspace);
    await screen.findByTitle("app / src/main.ts");
    await waitFor(() => expect(workspaceTestHarness.lspMocks.lspGetDiagnostics).toHaveBeenCalled());
    await waitFor(() => expect(rendered.container.querySelector(
      '[data-testid="code-workspace-lightbulb"]',
    )).toBeTruthy());

    const content = rendered.container.querySelector<HTMLElement>(".cm-content");
    expect(content).toBeTruthy();
    fireEvent.keyDown(content!, { key: "Enter", altKey: true });
    await waitFor(() => expect(workspaceTestHarness.lspMocks.lspCodeActions).toHaveBeenCalledTimes(1));
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
    expect(workspaceTestHarness.lspMocks.lspCodeActions).toHaveBeenCalledTimes(2);
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
    const statusFor = (filePath: string) => workspaceTestHarness.documentStatus({
      path: filePath,
      uri: `file://${filePath}`,
      presetId: "typescript-javascript",
      languageId: "typescript",
      displayName: "TypeScript / JavaScript",
      available: true,
      active: true,
      capabilities: workspaceTestHarness.defaultCapabilities({ codeAction: true }),
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
    workspaceTestHarness.workspaceMocks.workspaceReadFile.mockImplementation(async (_root: string, path: string) => (
      workspaceTestHarness.file(path, path === "src/util.ts" ? "first\ntarget" : "main")
    ));
    workspaceTestHarness.lspMocks.lspOpenDocument.mockImplementation(async (descriptor: { filePath: string }) => (
      statusFor(descriptor.filePath)
    ));
    workspaceTestHarness.lspMocks.lspGetDiagnostics.mockImplementation(async (descriptor: { filePath: string }) => ({
      status: statusFor(descriptor.filePath),
      diagnostics: descriptor.filePath.endsWith("src/main.ts") ? [diagnostic] : [],
    }));
    workspaceTestHarness.lspMocks.lspCodeActions.mockImplementation(async (descriptor: { filePath: string }) => ({
      status: statusFor(descriptor.filePath),
      actions: [action],
    }));

    const rendered = workspaceTestHarness.renderWorkspace(workspace);
    await screen.findByTitle("app / src/main.ts");
    await screen.findByTitle("app / src/util.ts");
    const panes = screen.getAllByTestId("code-workspace-editor-pane");
    const primaryPane = panes.find((pane) => pane.getAttribute("data-editor-group-id") === "primary");
    const secondaryPane = panes.find((pane) => (
      pane.getAttribute("data-editor-group-id") === "secondary"
    ));
    fireEvent.mouseDown(primaryPane!);
    await waitFor(() => expect(workspaceTestHarness.lspMocks.lspOpenDocument).toHaveBeenCalledWith(
      expect.objectContaining({ filePath: "src/main.ts" }),
      "main",
      expect.any(Number),
    ));
    await waitFor(() => expect(workspaceTestHarness.lspMocks.lspGetDiagnostics).toHaveBeenCalledWith(
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
    expect(workspaceTestHarness.lspMocks.lspCodeActions).toHaveBeenCalledTimes(2);
    expect(workspaceTestHarness.lspMocks.lspCodeActions).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ filePath: "src/main.ts" }),
      diagnostic.range,
      [expect.objectContaining({ code: diagnostic.code, message: diagnostic.message })],
      undefined,
    );
    expect(workspaceTestHarness.lspMocks.lspCodeActions).toHaveBeenNthCalledWith(
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
    workspaceTestHarness.workspaceMocks.workspaceListDir.mockResolvedValue([workspaceTestHarness.entry("src", "src", "dir")]);
    workspaceTestHarness.workspaceMocks.workspaceReadFile.mockResolvedValue(workspaceTestHarness.file(
      "src/Service.java",
      "class Service { List items; }",
    ));
    const status = workspaceTestHarness.documentStatus({
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
    workspaceTestHarness.lspMocks.lspOpenDocument.mockResolvedValue(status);
    workspaceTestHarness.lspMocks.lspCodeActions.mockResolvedValue({
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

    workspaceTestHarness.renderWorkspace(workspace);
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
    workspaceTestHarness.workspaceMocks.workspaceListDir.mockResolvedValue([workspaceTestHarness.entry("src", "src", "dir")]);
    workspaceTestHarness.workspaceMocks.workspaceReadFile.mockResolvedValue(workspaceTestHarness.file("src/main.ts", "const value = 1;"));
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
    let finishResourceOperation!: (value: { ignored: boolean }) => void;
    workspaceTestHarness.workspaceMocks.workspaceApplyResourceOperation.mockReturnValue(new Promise((resolve) => {
      finishResourceOperation = resolve;
    }));

    workspaceTestHarness.renderWorkspace(workspace);
    await screen.findByTitle("app / src/main.ts");
    // The document must be open with the provider before Alt+Enter asks it.
    await waitFor(() => expect(workspaceTestHarness.lspMocks.lspOpenDocument).toHaveBeenCalled());
    fireEvent.keyDown(window, { key: "Enter", altKey: true });
    fireEvent.click(await screen.findByRole("button", { name: "Rename file" }));

    await waitFor(() => expect(confirmAppDialog).toHaveBeenCalled());
    await waitFor(() => expect(workspaceTestHarness.workspaceMocks.workspaceApplyResourceOperation).toHaveBeenCalled());
    await waitFor(() => expect(
      screen.getByTestId("code-workspace-editor").querySelector(".cm-content"),
    ).toHaveAttribute("aria-readonly", "true"));

    await act(async () => finishResourceOperation({ ignored: false }));
    await waitFor(() => expect(
      screen.getByTestId("code-workspace-editor").querySelector(".cm-content"),
    ).not.toHaveAttribute("aria-readonly"));
    expect(workspaceTestHarness.workspaceMocks.workspaceApplyResourceOperation).toHaveBeenCalledWith("/repo/app", {
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
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-format-context-menu",
      workspaceInstanceId: "instance-format-context-menu",
      name: "Format context menu",
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
      capabilities: workspaceTestHarness.defaultCapabilities({ formatting: true, rangeFormatting: true }),
    }));
    workspaceTestHarness.lspMocks.lspFormatting.mockResolvedValue({
      status: workspaceTestHarness.documentStatus({ active: true, available: true }),
      edits: [{
        range: { start: { line: 0, character: 7 }, end: { line: 0, character: 7 } },
        newText: " ",
      }],
    });

    const rendered = workspaceTestHarness.renderWorkspace(workspace);
    await screen.findByTitle("app / src/main.ts");
    await waitFor(() => expect(screen.queryByText("LSP idle")).not.toBeInTheDocument());
    const content = rendered.container.querySelector<HTMLElement>(".cm-content");
    expect(content).not.toBeNull();
    const view = EditorView.findFromDOM(content!);
    expect(view).not.toBeNull();
    vi.spyOn(view!, "posAtCoords").mockReturnValue(null);

    fireEvent.contextMenu(content!, { clientX: 20, clientY: 30, button: 2 });
    fireEvent.click(await screen.findByTestId("editor-context-format"));

    await waitFor(() => expect(workspaceTestHarness.lspMocks.lspFormatting).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(selectCodeWorkspaceUi(
      useCodeWorkspaceStore.getState(),
      "instance-format-context-menu",
    ).openFiles["root:app:src/main.ts"]?.text).toBe("const x =1"));
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
      capabilities: workspaceTestHarness.defaultCapabilities(),
    }));

    workspaceTestHarness.renderWorkspace(workspace);
    await screen.findByTitle("app / src/main.ts");
    await waitFor(() => expect(screen.queryByText("LSP idle")).not.toBeInTheDocument());

    fireEvent.keyDown(window, { key: "l", ctrlKey: true, altKey: true });

    // AC-FMT-04: capability false is a visible reason, never a silent no-op.
    await waitFor(() => expect(useAppStore.getState().statusMessage).toContain(
      "No formatter provider for typescript is running",
    ));
    expect(workspaceTestHarness.lspMocks.lspFormatting).not.toHaveBeenCalled();
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
      capabilities: workspaceTestHarness.defaultCapabilities({ formatting: true, rangeFormatting: true }),
    }));
    workspaceTestHarness.lspMocks.lspFormatting.mockRejectedValue(new Error("provider transport failed"));

    workspaceTestHarness.renderWorkspace(workspace);
    await screen.findByTitle("app / src/main.ts");
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
    workspaceTestHarness.workspaceMocks.workspaceListDir.mockResolvedValue([workspaceTestHarness.entry("src", "src", "dir")]);
    workspaceTestHarness.workspaceMocks.workspaceReadFile.mockResolvedValue(workspaceTestHarness.file("src/main.ts", "const value = 1;", { hash: "disk-hash" }));
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

    workspaceTestHarness.renderWorkspace(workspace);
    await screen.findByTitle("app / src/main.ts");
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
    workspaceTestHarness.workspaceMocks.workspaceListDir.mockResolvedValue([workspaceTestHarness.entry("notes.txt", "notes.txt")]);
    workspaceTestHarness.workspaceMocks.workspaceReadFile.mockResolvedValue(workspaceTestHarness.file("notes.txt", "item\nsecond item\nthird item"));
    const registrationRef: { current: WorkspaceCommandRegistration | null } = { current: null };
    const onCommandsChange = vi.fn((_tabId: string, next: WorkspaceCommandRegistration | null) => {
      if (next) registrationRef.current = next;
    });
    const rendered = workspaceTestHarness.renderWorkspace(workspace, { onCommandsChange });
    await screen.findByTitle("app / notes.txt");
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
    workspaceTestHarness.workspaceMocks.workspaceReadFile.mockResolvedValue(workspaceTestHarness.file("src/main.ts", "one\ntwo"));

    const rendered = workspaceTestHarness.renderWorkspace(workspace);
    await screen.findByTitle("app / src/main.ts");
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
registerExecutionCases(workspaceTestHarness);
it("resolves and runs the active Java main class from the workspace toolbar", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-java-run",
      workspaceInstanceId: "instance-java-run",
      name: "Java run",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/main/java/com/acme/App.java" },
    };
    workspaceTestHarness.workspaceMocks.workspaceReadFile.mockResolvedValue(workspaceTestHarness.file(
      "src/main/java/com/acme/App.java",
      "package com.acme; class App { public static void main(String[] args) {} }",
    ));
    workspaceTestHarness.workspaceMocks.workspaceJavaRunTarget.mockResolvedValue({
      id: "java-main:src/main/java/com/acme/App.java",
      label: "com.acme.App",
      mainClass: "com.acme.App",
      filePath: "/repo/app/src/main/java/com/acme/App.java",
      command: "./mvnw -q -Dexec.mainClass='com.acme.App' compile exec:java",
      cwd: "/repo/app",
      buildSystem: "maven",
      modulePath: ".",
    });

    workspaceTestHarness.renderWorkspace(workspace);
    await screen.findByTitle("app / src/main/java/com/acme/App.java");
    fireEvent.click(screen.getByTestId("code-workspace-run-target"));

    await waitFor(() => expect(workspaceTestHarness.workspaceMocks.workspaceJavaRunTarget).toHaveBeenCalledWith(
      "/repo/app",
      "src/main/java/com/acme/App.java",
      undefined,
    ));
    expect(screen.getByRole("tab", { name: /Terminal/, selected: true })).toBeInTheDocument();
    expect(await screen.findByTestId("mock-workspace-terminal")).toHaveAttribute(
      "data-initial-cwd",
      "/repo/app",
    );
  });

it("jumps to a mnemonic bookmark and uses Back to restore the origin", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-bookmark-history",
      workspaceInstanceId: "instance-bookmark-history",
      name: "Bookmark history",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/one.ts" },
    };
    workspaceTestHarness.workspaceMocks.workspaceListDir.mockResolvedValue([
      workspaceTestHarness.entry("one.ts", "src/one.ts"),
      workspaceTestHarness.entry("two.ts", "src/two.ts"),
    ]);
    workspaceTestHarness.workspaceMocks.workspaceReadFile.mockImplementation(async (_root: string, path: string) => (
      path === "src/two.ts"
        ? workspaceTestHarness.file(path, "zero\nmarked\n")
        : workspaceTestHarness.file(path, "origin\n")
    ));
    window.localStorage.setItem(
      "taomni.codeWorkspace.bookmarks.v1.instance-bookmark-history",
      JSON.stringify([{
        id: "bookmark-two",
        fileKey: "root:app:src/two.ts",
        pathLabel: "app / src/two.ts",
        line: 1,
        character: 0,
        label: "marked",
        mnemonic: "J",
        group: "Mnemonic",
        state: "current",
        createdAt: 1,
      }]),
    );
    const registrationRef: { current: WorkspaceCommandRegistration | null } = { current: null };
    const onCommandsChange = vi.fn((_tabId: string, next: WorkspaceCommandRegistration | null) => {
      registrationRef.current = next;
    });

    workspaceTestHarness.renderWorkspace(workspace, { onCommandsChange });
    await screen.findByTitle("app / src/one.ts");
    await waitFor(() => expect(registrationRef.current).not.toBeNull());

    expect(registrationRef.current?.execute("workspace.jumpToBookmarkJ")).toBe(true);
    await waitFor(() => expect(
      selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "instance-bookmark-history").activeKey,
    ).toBe("root:app:src/two.ts"));
    const backButton = workspaceTestHarness.toolbarControl("code-workspace-nav-back");
    await waitFor(() => expect(backButton).not.toBeDisabled());
    fireEvent.click(backButton);
    await waitFor(() => expect(
      selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "instance-bookmark-history").activeKey,
    ).toBe("root:app:src/one.ts"));
  });
it("routes editor actions through ActionHost to the active recursive leaf", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-editor-actions",
      workspaceInstanceId: "instance-editor-actions",
      name: "Editor Actions",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/main.ts" },
    };
    workspaceTestHarness.workspaceMocks.workspaceReadFile.mockImplementation(async (_root: string, path: string) => (
      path === "src/util.ts"
        ? workspaceTestHarness.file("src/util.ts", "alpha\nbeta")
        : workspaceTestHarness.file("src/main.ts", "first\nsecond")
    ));
    window.localStorage.setItem("taomni.codeWorkspace.layout.v1.instance-editor-actions", JSON.stringify({
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
    const registrationRef: { current: WorkspaceCommandRegistration | null } = { current: null };
    const onCommandsChange = vi.fn((_tabId: string, next: WorkspaceCommandRegistration | null) => {
      registrationRef.current = next;
    });

    workspaceTestHarness.renderWorkspace(workspace, { onCommandsChange });
    await screen.findByTitle("app / src/main.ts");
    await screen.findByTitle("app / src/util.ts");
    const { EditorView } = await import("@codemirror/view");
    const panes = screen.getAllByTestId("code-workspace-editor-pane");
    const primaryPane = panes.find((pane) => pane.getAttribute("data-editor-group-id") === "primary");
    const secondaryPane = panes.find((pane) => pane.getAttribute("data-editor-group-id") === "secondary");
    const primaryEditor = primaryPane?.querySelector<HTMLElement>(".cm-editor");
    const secondaryEditor = secondaryPane?.querySelector<HTMLElement>(".cm-editor");
    expect(primaryEditor).not.toBeNull();
    expect(secondaryEditor).not.toBeNull();
    const primaryView = EditorView.findFromDOM(primaryEditor!);
    const secondaryView = EditorView.findFromDOM(secondaryEditor!);
    expect(primaryView).not.toBeNull();
    expect(secondaryView).not.toBeNull();

    fireEvent.mouseDown(primaryPane!);
    await waitFor(() => expect(
      selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "instance-editor-actions")
        .activeEditorGroupId,
    ).toBe("primary"));
    await waitFor(() => expect(
      registrationRef.current?.items.find((item) => item.id === "workspace.editor.cloneCaretBelow")?.enabled,
    ).toBe(true));
    await act(async () => {
      expect((await registrationRef.current?.executeAction(
        "workspace.editor.cloneCaretBelow",
      ))?.kind).toBe("applied");
    });
    expect(primaryView!.state.selection.ranges).toHaveLength(2);
    expect(secondaryView!.state.selection.ranges).toHaveLength(1);

    fireEvent.mouseDown(secondaryPane!);
    await waitFor(() => expect(
      selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "instance-editor-actions")
        .activeEditorGroupId,
    ).toBe("secondary"));
    await act(async () => {
      expect((await registrationRef.current?.executeAction(
        "workspace.editor.cloneCaretBelow",
      ))?.kind).toBe("applied");
    });
    expect(primaryView!.state.selection.ranges).toHaveLength(2);
    expect(secondaryView!.state.selection.ranges).toHaveLength(2);
  });

registerCompareCases(workspaceTestHarness);
describe("ED-PARITY-013 IDEA keymap alignment", () => {
    const javaWorkspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-parity-013",
      workspaceInstanceId: "instance-parity-013",
      name: "Parity 013",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/App.java" },
    };

    let mountCounter = 0;
    let instanceId = "";
    async function mountJava() {
      workspaceTestHarness.workspaceMocks.workspaceReadFile.mockResolvedValue(
        workspaceTestHarness.file("src/App.java", "public class App {\n  int total = 1;\n}\n"),
      );
      const onCommandsChange = vi.fn();
      mountCounter += 1;
      instanceId = `instance-parity-013-${mountCounter}`;
      const rendered = workspaceTestHarness.renderWorkspace(
        { ...javaWorkspace, workspaceId: `ws-parity-013-${mountCounter}`, workspaceInstanceId: instanceId },
        { onCommandsChange },
      );
      await screen.findByTitle("app / src/App.java");
      const latest = () => {
        const calls = onCommandsChange.mock.calls;
        return (calls[calls.length - 1]?.[1] as WorkspaceCommandRegistration).snapshot;
      };
      await waitFor(() => expect(latest().some((item) => item.id === "editor.find")).toBe(true));
      return { rendered, latest };
    }

    it("A4.2: every mapped action's Linux bindings match IDEA XWin, except accepted DEC differences", async () => {
      setKeymapPlatformOverride("linux");
      const { latest } = await mountJava();
      const snapshot = latest();
      const report: string[] = [];
      for (const entry of IDEA_XWIN_KEYMAP) {
        const item = snapshot.find((candidate) => candidate.id === entry.taomniActionId);
        const taomni = item?.keybindings ?? [];
        const idea = entry.ideaBindings;
        const primaryPresent = idea.length === 0 || taomni.includes(idea[0]!);
        const extras = taomni.filter((label) => !idea.includes(label));
        const accepted = ACCEPTED_IDEA_KEYMAP_DIFFERENCES[entry.taomniActionId];
        if ((!item || !primaryPresent || extras.length > 0) && !accepted) {
          report.push(`${entry.taomniActionId} (${entry.ideaActionId}): taomni=[${taomni.join(", ")}] idea=[${idea.join(", ")}]`);
        }
      }
      expect(report).toEqual([]);
    });
    it("A4.1/A1.1: Ctrl+Shift+A opens Find Action without editing; Alt+Enter assigns a shortcut", async () => {
      setKeymapPlatformOverride("linux");
      const { rendered } = await mountJava();
      const content = rendered.container.querySelector<HTMLElement>(".cm-content")!;
      const before = content.textContent;
      await act(async () => {
        fireEvent.keyDown(content, { key: "A", code: "KeyA", ctrlKey: true, shiftKey: true });
      });
      const overlay = await screen.findByTestId("code-workspace-search-everywhere");
      expect(within(overlay).getByRole("tab", { name: "Actions" })).toHaveAttribute("aria-selected", "true");
      const input = within(overlay).getByRole("searchbox");
      fireEvent.change(input, { target: { value: "reformat" } });
      expect(content.textContent).toBe(before);
      expect(within(overlay).getByTestId("search-everywhere-shortcut-workspace.format")).toHaveTextContent("Ctrl+Alt+L");
      expect(overlay.textContent).not.toMatch(/ARROW|ENTER|SPACE|Meta\+/);
      await act(async () => {
        fireEvent.keyDown(input, { key: "Enter", altKey: true });
      });
      await screen.findByTestId("workspace-keymap-settings-dialog");
      expect(screen.getByTestId("keymap-recorder")).toBeInTheDocument();
      expect(screen.getByTestId("keymap-action-filter")).toHaveValue("Format Document");
      // An unbound Ctrl+Shift+letter never edits the document (DEC-013-04).
      fireEvent.keyDown(screen.getByTestId("keymap-recorder"), { key: "Escape" });
      fireEvent.keyDown(window, { key: "Escape" });
      await waitFor(() => expect(screen.queryByTestId("workspace-keymap-settings-dialog")).not.toBeInTheDocument());
      fireEvent.keyDown(content, { key: "Q", code: "KeyQ", ctrlKey: true, shiftKey: true });
      expect(content.textContent).toBe(before);
    });

    it("A4.2: F12 jumps to the last tool window, Shift+Esc hides it, Ctrl+Shift+F12 toggles all", async () => {
      setKeymapPlatformOverride("linux");
      const { rendered } = await mountJava();
      const content = rendered.container.querySelector<HTMLElement>(".cm-content")!;
      await act(async () => {
        fireEvent.keyDown(content, { key: "6", code: "Digit6", altKey: true });
      });
      await waitFor(() => expect(selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), instanceId).bottomDockOpen).toBe(true));
      await act(async () => {
        useCodeWorkspaceStore.getState().patchInstance(instanceId, { bottomDockOpen: false });
      });
      await act(async () => {
        fireEvent.keyDown(content, { key: "F12", code: "F12" });
      });
      await waitFor(() => {
        const ui = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), instanceId);
        expect(ui.bottomDockOpen).toBe(true);
        expect(ui.bottomDockTab).toBe("problems");
      });
      const ui = () => selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), instanceId);
      // Shift+Esc from the editor hides that last active tool window.
      await act(async () => {
        fireEvent.keyDown(content, { key: "Escape", code: "Escape", shiftKey: true });
      });
      await waitFor(() => expect(ui().bottomDockOpen).toBe(false));
      // Ctrl+Shift+F12 hides every tool window, and the second press restores them.
      expect(ui().languagePanelOpen).toBe(true);
      await act(async () => {
        fireEvent.keyDown(content, { key: "F12", code: "F12", ctrlKey: true, shiftKey: true });
      });
      await waitFor(() => expect(ui().languagePanelOpen).toBe(false));
      await act(async () => {
        fireEvent.keyDown(content, { key: "F12", code: "F12", ctrlKey: true, shiftKey: true });
      });
      await waitFor(() => expect(ui().languagePanelOpen).toBe(true));
    });

    it("A4.2b: Shift+Esc in a tool window hands focus to the editor as it hides", async () => {
      setKeymapPlatformOverride("linux");
      const { rendered } = await mountJava();
      const content = rendered.container.querySelector<HTMLElement>(".cm-content")!;
      const ui = () => selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), instanceId);
      await act(async () => {
        fireEvent.keyDown(content, { key: "6", code: "Digit6", altKey: true });
      });
      await waitFor(() => expect(ui().bottomDockOpen).toBe(true));
      const dock = await screen.findByTestId("code-workspace-bottom-dock");
      const inside = dock.querySelector<HTMLElement>("button")!;
      act(() => inside.focus());
      expect(dock.contains(document.activeElement)).toBe(true);
      act(() => {
        fireEvent.keyDown(inside, { key: "Escape", code: "Escape", shiftKey: true });
      });
      // No frame has run yet: the editor already owns focus.
      expect(document.activeElement?.classList.contains("cm-content")).toBe(true);
      await waitFor(() => expect(ui().bottomDockOpen).toBe(false));
    });

    it("DEC-013-06: migration notice shows once for a profile with prior workspace data", async () => {
      resetKeymapDefaultsMigrationNoticeForTests();
      window.localStorage.removeItem("taomni.codeWorkspace.keymap.v3:defaults-revision");
      // Seeded settings alone (e.g. a JDK path) are not prior workspace use.
      window.localStorage.setItem("taomni.codeWorkspace.lspJavaHome.v1", "/jdk");
      await mountJava();
      expect(screen.queryByTestId("keymap-migration-notice")).not.toBeInTheDocument();
      cleanup();
      resetKeymapDefaultsMigrationNoticeForTests();
      window.localStorage.removeItem("taomni.codeWorkspace.keymap.v3:defaults-revision");
      window.localStorage.setItem("taomni.codeWorkspace.layout.v2.previous-session", "{}");
      await mountJava();
      const notice = await screen.findByTestId("keymap-migration-notice");
      expect(notice).toHaveTextContent("Taomni Classic");
      fireEvent.click(screen.getByTestId("keymap-migration-dismiss"));
      expect(screen.queryByTestId("keymap-migration-notice")).not.toBeInTheDocument();
      expect(window.localStorage.getItem("taomni.codeWorkspace.keymap.v3:defaults-revision")).toBe("2");
      cleanup();
      resetKeymapDefaultsMigrationNoticeForTests();
      await mountJava();
      expect(screen.queryByTestId("keymap-migration-notice")).not.toBeInTheDocument();
    });
  });
}
