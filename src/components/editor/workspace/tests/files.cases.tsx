import { EditorSelection } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { emit } from "@tauri-apps/api/event";
import { act,fireEvent,render,screen,waitFor,within } from "@testing-library/react";
import { describe,expect,it,vi } from "vitest";
import { promptAppDialog } from "../../../../lib/appDialogs";
import { useAppStore } from "../../../../stores/appStore";
import { selectCodeWorkspaceUi,useCodeWorkspaceStore } from "../../../../stores/codeWorkspaceStore";
import type { CodeWorkspaceTabInfo } from "../../../../types";
import { CodeWorkspaceTab } from "../../CodeWorkspaceTab";
import type { WorkspaceTestFixture } from "../../CodeWorkspaceTab.test";
import { editorAppearanceProfileStorageKey } from "../editorAppearanceProfile";
import type { WorkspaceCommandRegistration } from "../workspaceCommands";
import { setKeymapPlatformOverride } from "../workspaceKeymapPlatform";

export type registerFilesCasesFixture = Pick<WorkspaceTestFixture, "renderWorkspace" | "workspaceMocks" | "file" | "toolbarControl" | "entry" | "gitMocks" | "lspMocks" | "documentStatus" | "defaultCapabilities" | "clipboardMocks" | "writeAck" | "confirmWorkspaceUndo">;

export function registerFilesCases(workspaceTestHarness: registerFilesCasesFixture) {
it("keeps command registration stable across unrelated parent rerenders", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "",
      workspaceId: "ws-registration",
      workspaceInstanceId: "instance-registration",
      name: "Registration Workspace",
      roots: [],
      looseFiles: [],
    };
    const onCommandsChange = vi.fn();
    const rendered = workspaceTestHarness.renderWorkspace(workspace, { onCommandsChange });

    await waitFor(() => {
      expect(onCommandsChange).toHaveBeenCalledWith(
        "tab-code",
        expect.objectContaining({
          items: expect.any(Array),
          snapshot: expect.any(Array),
          executeAction: expect.any(Function),
          execute: expect.any(Function),
        }),
      );
    });

    onCommandsChange.mockClear();
    rendered.rerender(
      <CodeWorkspaceTab
        tabId="tab-code"
        workspace={workspace}
        visible
        onCommandsChange={onCommandsChange}
      />,
    );
    expect(onCommandsChange).not.toHaveBeenCalled();

    rendered.unmount();
    expect(onCommandsChange).toHaveBeenCalledTimes(1);
    expect(onCommandsChange).toHaveBeenCalledWith("tab-code", null);
  });
it("keeps file tree zoom separate from editor zoom", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-appearance",
      name: "Appearance",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/main.ts" },
    };
    workspaceTestHarness.workspaceMocks.workspaceReadFile.mockResolvedValue(workspaceTestHarness.file("src/main.ts", "export const answer = 42;"));

    workspaceTestHarness.renderWorkspace(workspace);

    expect(await screen.findByText("Code · Appearance")).toBeInTheDocument();

    // The tree's font size must be bound to the zoom variable (not just row
    // height), so zooming the left pane actually resizes its text.
    expect(screen.getByTestId("code-workspace-tree").style.fontSize).toBe(
      "var(--taomni-code-tree-font-size)",
    );

    fireEvent.click(screen.getByTestId("code-workspace-tree-toolbar-more"));
    fireEvent.click(screen.getByTestId("code-workspace-tree-menu-appearance"));
    fireEvent.click(screen.getByTestId("code-workspace-tree-zoom-in"));
    expect(window.localStorage.getItem("taomni.codeWorkspace.treeFontSize.v1")).toBe("13");
    expect(screen.getByTestId("code-workspace-tree-pane").style.getPropertyValue("--taomni-code-tree-font-size")).toBe("13px");
    expect(window.localStorage.getItem("taomni.codeViewProfile.v1")).toBeNull();

    const appearanceKey = editorAppearanceProfileStorageKey("ws-appearance");
    fireEvent.click(workspaceTestHarness.toolbarControl("code-workspace-zoom-in"));
    let saved = JSON.parse(window.localStorage.getItem(appearanceKey) ?? "{}");
    expect(saved.profile.fontSizePx).toBe(14);
    expect(document.documentElement.style.getPropertyValue("--taomni-code-font-size")).toBe("");
    expect(window.localStorage.getItem("taomni.codeViewProfile.v1")).toBeNull();
    expect(window.localStorage.getItem("taomni.codeWorkspace.treeFontSize.v1")).toBe("13");

    fireEvent.wheel(screen.getByTestId("code-workspace-tree-pane"), { ctrlKey: true, deltaY: -100 });
    expect(window.localStorage.getItem("taomni.codeWorkspace.treeFontSize.v1")).toBe("14");
    saved = JSON.parse(window.localStorage.getItem(appearanceKey) ?? "{}");
    expect(saved.profile.fontSizePx).toBe(14);

    fireEvent.wheel(screen.getByTestId("code-workspace-editor-pane"), { ctrlKey: true, deltaY: -100 });
    saved = JSON.parse(window.localStorage.getItem(appearanceKey) ?? "{}");
    expect(saved.profile.fontSizePx).toBe(15);
    expect(window.localStorage.getItem("taomni.codeWorkspace.treeFontSize.v1")).toBe("14");

    fireEvent.click(workspaceTestHarness.toolbarControl("code-workspace-zoom-out"));
    saved = JSON.parse(window.localStorage.getItem(appearanceKey) ?? "{}");
    expect(saved.profile.fontSizePx).toBe(14);

    fireEvent.click(screen.getByTestId("code-workspace-tree-toolbar-more"));
    fireEvent.click(screen.getByTestId("code-workspace-tree-menu-appearance"));
    fireEvent.click(screen.getByTestId("code-workspace-tree-zoom-out"));
    expect(window.localStorage.getItem("taomni.codeWorkspace.treeFontSize.v1")).toBe("13");
  });
it("opens successive tree files as permanent tabs without closing the previous one", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-tabs",
      workspaceInstanceId: "instance-tabs",
      name: "Tabs",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: null,
    };
    workspaceTestHarness.workspaceMocks.workspaceListDir.mockResolvedValue([
      workspaceTestHarness.entry("main.ts", "src/main.ts"),
      workspaceTestHarness.entry("util.ts", "src/util.ts"),
    ]);
    workspaceTestHarness.workspaceMocks.workspaceReadFile.mockImplementation(async (_root: string, path: string) => (
      workspaceTestHarness.file(path, path === "src/main.ts" ? "export const main = 1;" : "export const util = 2;")
    ));

    workspaceTestHarness.renderWorkspace(workspace);
    expect(await screen.findByText("Code · Tabs")).toBeInTheDocument();

    const rows = await screen.findAllByTestId("code-workspace-tree-file");
    fireEvent.doubleClick(rows[0]);
    await waitFor(() => {
      expect(workspaceTestHarness.workspaceMocks.workspaceReadFile).toHaveBeenCalledWith("/repo/app", "src/main.ts");
    });
    fireEvent.doubleClick(rows[1]);
    await waitFor(() => {
      expect(workspaceTestHarness.workspaceMocks.workspaceReadFile).toHaveBeenCalledWith("/repo/app", "src/util.ts");
    });

    await waitFor(() => {
      const ui = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "instance-tabs");
      expect(ui.editorGroups.primary.openOrder).toEqual([
        "root:app:src/main.ts",
        "root:app:src/util.ts",
      ]);
      expect(ui.editorGroups.primary.activeKey).toBe("root:app:src/util.ts");
      expect(ui.editorGroups.primary.previewKey).toBeNull();
    });
    expect(screen.getByTitle("app / src/main.ts")).toBeInTheDocument();
    expect(screen.getByTitle("app / src/util.ts")).toBeInTheDocument();
  });
it("renders compact directory chains and expands the endpoint", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-compact",
      name: "Compact",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: null,
    };
    workspaceTestHarness.workspaceMocks.workspaceListDir.mockResolvedValue([workspaceTestHarness.entry("src", "src", "dir")]);
    workspaceTestHarness.workspaceMocks.workspaceCompactChain.mockResolvedValue({
      path: "src/main/java/com/example",
      entries: [workspaceTestHarness.entry("UserService.java", "src/main/java/com/example/UserService.java")],
    });
    workspaceTestHarness.workspaceMocks.workspaceReadFile.mockResolvedValue(workspaceTestHarness.file(
      "src/main/java/com/example/UserService.java",
      "class UserService {}",
    ));

    workspaceTestHarness.renderWorkspace(workspace);

    expect(await screen.findByText("Code · Compact")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("code-workspace-tree-toolbar-more"));
    fireEvent.click(screen.getByTestId("code-workspace-tree-menu-appearance"));
    fireEvent.click(screen.getByTestId("code-workspace-tree-menu-compact"));

    const compactDir = await screen.findByText("src/main/java/com/example");
    fireEvent.doubleClick(compactDir);
    expect(await screen.findByText("UserService.java")).toBeInTheDocument();

    fireEvent.doubleClick(screen.getByText("UserService.java"));
    await waitFor(() => {
      expect(workspaceTestHarness.workspaceMocks.workspaceReadFile).toHaveBeenCalledWith(
        "/repo/app",
        "src/main/java/com/example/UserService.java",
      );
    });
  });
it("detects git roots, decorates file changes, and opens the Git tab from the toolbar", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-git",
      name: "Git",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/App.tsx" },
    };
    workspaceTestHarness.workspaceMocks.workspaceListDir.mockResolvedValue([workspaceTestHarness.entry("App.tsx", "src/App.tsx")]);
    workspaceTestHarness.workspaceMocks.workspaceReadFile.mockResolvedValue(workspaceTestHarness.file("src/App.tsx", "export function App() {}"));
    workspaceTestHarness.workspaceMocks.workspaceDetectGitRoots.mockResolvedValue([
      {
        id: "app",
        name: "app",
        path: "/repo/app",
        repoRoot: "/repo/app",
        rootIds: ["app"],
      },
    ]);
    workspaceTestHarness.gitMocks.gitSnapshot.mockResolvedValue({
      repoRoot: "/repo/app",
      currentBranch: "main",
      headOid: null,
      detached: false,
      upstream: null,
      ahead: 0,
      behind: 0,
      changes: [
        {
          path: "src/App.tsx",
          oldPath: null,
          status: "modified",
          staged: false,
          unstaged: true,
          conflict: false,
        },
      ],
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

    const onOpenGitManager = vi.fn();
    workspaceTestHarness.renderWorkspace(workspace, { onOpenGitManager });

    expect(await screen.findByText("Code · Git")).toBeInTheDocument();
    await waitFor(() => {
      expect(workspaceTestHarness.workspaceMocks.workspaceDetectGitRoots).toHaveBeenCalledWith([
        { id: "app", name: "app", path: "/repo/app" },
      ]);
      expect(workspaceTestHarness.gitMocks.gitSnapshot).toHaveBeenCalledWith("/repo/app");
    });
    expect(await screen.findByTestId("code-workspace-git-status")).toHaveTextContent("M");
    expect(screen.queryByTestId("code-workspace-git-manager-open")).not.toBeInTheDocument();
    expect(screen.queryByTestId("workspace-git-container")).not.toBeInTheDocument();

    await waitFor(() => expect(screen.getByTestId("code-workspace-git-panel-toggle")).not.toBeDisabled());
    fireEvent.click(screen.getByTestId("code-workspace-git-panel-toggle"));

    expect(onOpenGitManager).toHaveBeenCalledWith({
      workspaceName: "Git",
      workspaceInstanceId: "ws-git",
      workspaceId: "ws-git",
      roots: [
        {
          id: "app",
          name: "app",
          path: "/repo/app",
          repoRoot: "/repo/app",
          rootIds: ["app"],
        },
      ],
      activeRepoRoot: "/repo/app",
    });
  });
it("selects the child repository that owns the active file inside a plain workspace root", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/workspace",
      workspaceId: "ws-child-git",
      name: "Child Repos",
      roots: [{ id: "workspace", name: "workspace", path: "/workspace", kind: "folder" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "workspace", path: "service/src/api.ts" },
    };
    workspaceTestHarness.workspaceMocks.workspaceListDir.mockResolvedValue([workspaceTestHarness.entry("api.ts", "service/src/api.ts")]);
    workspaceTestHarness.workspaceMocks.workspaceReadFile.mockResolvedValue(workspaceTestHarness.file("service/src/api.ts", "export const api = true;"));
    workspaceTestHarness.workspaceMocks.workspaceDetectGitRoots.mockResolvedValue([
      {
        id: "workspace:/workspace/app",
        name: "app",
        path: "/workspace",
        repoRoot: "/workspace/app",
        rootIds: ["workspace"],
      },
      {
        id: "workspace:/workspace/service",
        name: "service",
        path: "/workspace",
        repoRoot: "/workspace/service",
        rootIds: ["workspace"],
      },
    ]);
    workspaceTestHarness.gitMocks.gitSnapshot.mockImplementation(async (repoRoot: string) => ({
      repoRoot,
      currentBranch: "main",
      headOid: null,
      detached: false,
      upstream: null,
      ahead: 0,
      behind: 0,
      changes: repoRoot === "/workspace/service"
        ? [
          {
            path: "src/api.ts",
            oldPath: null,
            status: "modified",
            staged: false,
            unstaged: true,
            conflict: false,
          },
        ]
        : [
          {
            path: "src/App.tsx",
            oldPath: null,
            status: "modified",
            staged: false,
            unstaged: true,
            conflict: false,
          },
        ],
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
    }));

    const onOpenGitManager = vi.fn();
    workspaceTestHarness.renderWorkspace(workspace, { onOpenGitManager });

    expect(await screen.findByText("Code · Child Repos")).toBeInTheDocument();
    await waitFor(() => expect(workspaceTestHarness.gitMocks.gitSnapshot).toHaveBeenCalledWith("/workspace/service"));
    expect(await screen.findByTestId("code-workspace-git-status")).toHaveTextContent("M");

    await waitFor(() => expect(screen.getByTestId("code-workspace-git-panel-toggle")).not.toBeDisabled());
    fireEvent.click(screen.getByTestId("code-workspace-git-panel-toggle"));

    expect(onOpenGitManager).toHaveBeenCalledWith({
      workspaceName: "Child Repos",
      workspaceInstanceId: "ws-child-git",
      workspaceId: "ws-child-git",
      roots: [
        {
          id: "workspace:/workspace/app",
          name: "app",
          path: "/workspace",
          repoRoot: "/workspace/app",
          rootIds: ["workspace"],
        },
        {
          id: "workspace:/workspace/service",
          name: "service",
          path: "/workspace",
          repoRoot: "/workspace/service",
          rootIds: ["workspace"],
        },
      ],
      activeRepoRoot: "/workspace/service",
    });
  });
it("tracks navigation history and reopens recent files from Ctrl+E", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-nav",
      workspaceInstanceId: "instance-nav",
      name: "Nav",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
    };
    workspaceTestHarness.workspaceMocks.workspaceListDir.mockResolvedValue([
      workspaceTestHarness.entry("a.ts", "a.ts"),
      workspaceTestHarness.entry("b.ts", "b.ts"),
    ]);
    workspaceTestHarness.workspaceMocks.workspaceReadFile.mockImplementation(async (_root: string, path: string) =>
      workspaceTestHarness.file(path, `// ${path}`));

    workspaceTestHarness.renderWorkspace(workspace);

    const treeFiles = await screen.findAllByTestId("code-workspace-tree-file");
    fireEvent.doubleClick(treeFiles[0]);
    await screen.findByTitle("app / a.ts");
    fireEvent.doubleClick(treeFiles[1]);
    await screen.findByTitle("app / b.ts");
    await waitFor(() =>
      expect(screen.getByTitle("app / b.ts").closest("div")).toHaveAttribute("data-active"));

    fireEvent.click(workspaceTestHarness.toolbarControl("code-workspace-nav-back"));
    await waitFor(() =>
      expect(screen.getByTitle("app / a.ts").closest("div")).toHaveAttribute("data-active"));
    expect(workspaceTestHarness.toolbarControl("code-workspace-nav-back")).toBeDisabled();

    fireEvent.click(workspaceTestHarness.toolbarControl("code-workspace-nav-forward"));
    await waitFor(() =>
      expect(screen.getByTitle("app / b.ts").closest("div")).toHaveAttribute("data-active"));
    expect(workspaceTestHarness.toolbarControl("code-workspace-nav-forward")).toBeDisabled();

    // Ctrl+E preselects the previously active file; Enter flips back to it.
    fireEvent.keyDown(window, { key: "e", ctrlKey: true });
    const popup = await screen.findByTestId("code-workspace-recent-files");
    expect(within(popup).getAllByRole("button")[0]).toHaveTextContent("b.ts");
    fireEvent.keyDown(screen.getByLabelText("Recent files"), { key: "Enter" });
    await waitFor(() =>
      expect(screen.getByTitle("app / a.ts").closest("div")).toHaveAttribute("data-active"));
    expect(screen.queryByTestId("code-workspace-recent-files")).not.toBeInTheDocument();
  });
it("opens the file structure popup with Ctrl+F12 and jumps to a symbol", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-structure",
      workspaceInstanceId: "instance-structure",
      name: "Structure",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "a.ts" },
    };
    workspaceTestHarness.workspaceMocks.workspaceListDir.mockResolvedValue([workspaceTestHarness.entry("a.ts", "a.ts")]);
    workspaceTestHarness.workspaceMocks.workspaceReadFile.mockResolvedValue(workspaceTestHarness.file("a.ts", "const x = 1;"));
    workspaceTestHarness.lspMocks.lspDocumentSymbols.mockResolvedValue({
      status: workspaceTestHarness.documentStatus({ active: true, available: true }),
      symbols: [
        {
          name: "openFile",
          detail: "(path: string) => Promise<void>",
          kind: 12,
          depth: 0,
          range: { start: { line: 13, character: 0 }, end: { line: 16, character: 1 } },
          selectionRange: { start: { line: 13, character: 8 }, end: { line: 13, character: 16 } },
        },
      ],
    });

    workspaceTestHarness.renderWorkspace(workspace);
    await screen.findByTitle("app / a.ts");
    // The tab strip renders while the file is still loading; wait for the
    // loaded file header (size text) before invoking the structure popup.
    await waitFor(() => expect(screen.getByTestId("code-workspace-file-status").getAttribute("title")).toContain("12 B"));

    fireEvent.keyDown(window, { key: "F12", ctrlKey: true });
    const popup = await screen.findByTestId("code-workspace-structure-popup");
    expect(await within(popup).findByText("openFile")).toBeInTheDocument();
    expect(workspaceTestHarness.lspMocks.lspDocumentSymbols).toHaveBeenCalled();

    fireEvent.keyDown(screen.getByLabelText("File structure"), { key: "Enter" });
    expect(screen.queryByTestId("code-workspace-structure-popup")).not.toBeInTheDocument();
  });
it("cancels a multi-file code-action preview with zero edits and zero history", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-actions-cancel",
      workspaceInstanceId: "instance-actions-cancel",
      name: "Actions cancel",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/main.ts" },
    };
    workspaceTestHarness.workspaceMocks.workspaceListDir.mockImplementation(async (_root: string, path: string) => (
      path === "src"
        ? [workspaceTestHarness.entry("main.ts", "src/main.ts"), workspaceTestHarness.entry("other.ts", "src/other.ts")]
        : [workspaceTestHarness.entry("src", "src", "dir")]
    ));
    workspaceTestHarness.workspaceMocks.workspaceReadFile.mockImplementation(async (_root: string, path: string) => (
      path === "src/other.ts" ? workspaceTestHarness.file(path, "y=2") : workspaceTestHarness.file(path, "x=1")
    ));
    const status = workspaceTestHarness.documentStatus({
      path: "/repo/app/src/main.ts",
      uri: "file:///repo/app/src/main.ts",
      available: true,
      active: true,
      capabilities: workspaceTestHarness.defaultCapabilities({ codeAction: true }),
    });
    workspaceTestHarness.lspMocks.lspOpenDocument.mockResolvedValue(status);
    workspaceTestHarness.lspMocks.lspCodeActions.mockResolvedValue({
      status,
      actions: [{
        title: "Update two files",
        kind: "quickfix",
        isPreferred: true,
        edit: {
          documentEdits: [
            {
              uri: "file:///repo/app/src/main.ts",
              path: "/repo/app/src/main.ts",
              edits: [{
                range: { start: { line: 0, character: 1 }, end: { line: 0, character: 1 } },
                newText: " ",
              }],
            },
            {
              uri: "file:///repo/app/src/other.ts",
              path: "/repo/app/src/other.ts",
              edits: [{
                range: { start: { line: 0, character: 1 }, end: { line: 0, character: 1 } },
                newText: " ",
              }],
            },
          ],
        },
        command: null,
        commandArguments: null,
        raw: { title: "Update two files", kind: "quickfix" },
      }],
    });
    const registrationRef: { current: WorkspaceCommandRegistration | null } = { current: null };
    const onCommandsChange = vi.fn((_tabId: string, next: WorkspaceCommandRegistration | null) => {
      if (next) registrationRef.current = next;
    });

    workspaceTestHarness.renderWorkspace(workspace, { onCommandsChange });
    await screen.findByTitle("app / src/main.ts");
    await waitFor(() => expect(screen.queryByText("LSP idle")).not.toBeInTheDocument());
    fireEvent.keyDown(window, { key: "Enter", altKey: true });
    fireEvent.click(await screen.findByRole("button", { name: "Update two files" }));
    const preview = await screen.findByTestId("refactoring-preview-dialog");
    expect(within(preview).getByText("/repo/app/src/main.ts")).toBeInTheDocument();
    expect(within(preview).getByText("/repo/app/src/other.ts")).toBeInTheDocument();
    fireEvent.click(within(preview).getByTestId("refactoring-preview-cancel"));

    await waitFor(() => expect(useAppStore.getState().statusMessage).toContain("Code action cancelled"));
    expect(selectCodeWorkspaceUi(
      useCodeWorkspaceStore.getState(),
      "instance-actions-cancel",
    ).openFiles["root:app:src/main.ts"]?.text).toBe("x=1");
    expect(workspaceTestHarness.workspaceMocks.workspaceWriteFileEncoded).not.toHaveBeenCalled();
    expect(
      registrationRef.current?.items.find((item) => item.id === "workspace.undoWorkspaceEdit")?.enabled,
    ).toBe(false);
  });
it("never generates or suggests Java import quick fixes in TypeScript files", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-ts-no-java-import",
      workspaceInstanceId: "instance-ts-no-java-import",
      name: "TS No Java Import",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/app.ts" },
    };
    workspaceTestHarness.workspaceMocks.workspaceListDir.mockResolvedValue([workspaceTestHarness.entry("src", "src", "dir")]);
    workspaceTestHarness.workspaceMocks.workspaceReadFile.mockResolvedValue(workspaceTestHarness.file(
      "src/app.ts",
      "const items: List = [];",
    ));
    workspaceTestHarness.lspMocks.lspOpenDocument.mockResolvedValue(workspaceTestHarness.documentStatus({
      path: "/repo/app/src/app.ts",
      available: true,
      active: true,
      capabilities: workspaceTestHarness.defaultCapabilities({
        completion: true,
        codeAction: true,
      }),
    }));
    workspaceTestHarness.lspMocks.lspCodeActions.mockResolvedValue({
      status: workspaceTestHarness.documentStatus({ available: true, active: true }),
      actions: [],
    });

    workspaceTestHarness.renderWorkspace(workspace);
    await screen.findByTitle("app / src/app.ts");
    await waitFor(() => expect(screen.queryByText("LSP idle")).not.toBeInTheDocument());

    // Trigger Alt+Enter on TypeScript file where LSP has no actions
    fireEvent.keyDown(window, { key: "Enter", altKey: true });

    // AC-ALT-02: no provider action stays visible instead of silently no-op.
    await waitFor(() => expect(useAppStore.getState().statusMessage).toContain(
      "No code actions provided by the language server",
    ));

    // Assert no Java import quick fix is suggested
    expect(screen.queryByRole("button", { name: /import 'List' \(java\.util\.List\)/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /java\.util/i })).not.toBeInTheDocument();
  });
it("keeps format executable before the provider reports capabilities", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-format-unknown-capabilities",
      workspaceInstanceId: "instance-format-unknown-capabilities",
      name: "Format unknown capabilities",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/main.ts" },
    };
    workspaceTestHarness.workspaceMocks.workspaceListDir.mockResolvedValue([workspaceTestHarness.entry("src", "src", "dir")]);
    workspaceTestHarness.workspaceMocks.workspaceReadFile.mockResolvedValue(workspaceTestHarness.file("src/main.ts", "const x=1"));
    // The open request stays pending: capability state is genuinely unknown.
    workspaceTestHarness.lspMocks.lspOpenDocument.mockReturnValue(new Promise(() => {}));
    workspaceTestHarness.lspMocks.lspFormatting.mockResolvedValue({
      status: workspaceTestHarness.documentStatus({ active: true, available: true }),
      edits: [{
        range: { start: { line: 0, character: 7 }, end: { line: 0, character: 7 } },
        newText: " ",
      }],
    });

    workspaceTestHarness.renderWorkspace(workspace);
    await screen.findByTitle("app / src/main.ts");
    await waitFor(() => expect(workspaceTestHarness.lspMocks.lspOpenDocument).toHaveBeenCalled());

    fireEvent.keyDown(window, { key: "l", ctrlKey: true, altKey: true });

    // AC-FMT-03: an unreported capability does not disable the command; the
    // provider call decides and the format still applies.
    await waitFor(() => expect(workspaceTestHarness.lspMocks.lspFormatting).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(selectCodeWorkspaceUi(
      useCodeWorkspaceStore.getState(),
      "instance-format-unknown-capabilities",
    ).openFiles["root:app:src/main.ts"]?.text).toBe("const x =1"));
  });
it("refuses selection formatting when the provider only supports whole-file scope", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-format-range-unsupported",
      workspaceInstanceId: "instance-format-range-unsupported",
      name: "Format range unsupported",
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
      capabilities: workspaceTestHarness.defaultCapabilities({ formatting: true, rangeFormatting: false }),
    }));
    workspaceTestHarness.lspMocks.lspFormatting.mockResolvedValue({
      status: workspaceTestHarness.documentStatus({ active: true, available: true }),
      edits: [],
    });

    const rendered = workspaceTestHarness.renderWorkspace(workspace);
    await screen.findByTitle("app / src/main.ts");
    await waitFor(() => expect(screen.queryByText("LSP idle")).not.toBeInTheDocument());
    const content = rendered.container.querySelector<HTMLElement>(".cm-content");
    const view = EditorView.findFromDOM(content!);
    expect(view).not.toBeNull();
    act(() => {
      view!.dispatch({ selection: EditorSelection.range(0, 5) });
    });
    // Flush the debounced selection publish so editorSelectionRef sees the
    // non-empty range before the shortcut is evaluated.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });

    fireEvent.keyDown(window, { key: "l", ctrlKey: true, altKey: true });

    await waitFor(() => expect(useAppStore.getState().statusMessage).toContain("range formatting"));
    expect(workspaceTestHarness.lspMocks.lspFormatting).not.toHaveBeenCalled();
    expect(workspaceTestHarness.lspMocks.lspRangeFormatting).not.toHaveBeenCalled();
    expect(selectCodeWorkspaceUi(
      useCodeWorkspaceStore.getState(),
      "instance-format-range-unsupported",
    ).openFiles["root:app:src/main.ts"]?.text).toBe("const x=1");
  });
it("offers tree context menu actions: copy path and scoped search", async () => {
    workspaceTestHarness.clipboardMocks.writeText.mockClear();
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-menu",
      workspaceInstanceId: "instance-menu",
      name: "Menu",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
    };
    workspaceTestHarness.workspaceMocks.workspaceListDir.mockResolvedValue([
      workspaceTestHarness.entry("src", "src", "dir"),
      workspaceTestHarness.entry("README.md", "README.md"),
    ]);
    workspaceTestHarness.workspaceMocks.workspaceDetectGitRoots.mockResolvedValue([{
      id: "git-app",
      name: "app",
      path: "/repo/app",
      repoRoot: "/repo/app",
      rootIds: ["app"],
    }]);

    workspaceTestHarness.renderWorkspace(workspace);

    const fileRow = await screen.findByTestId("code-workspace-tree-file");
    fireEvent.contextMenu(fileRow);
    fireEvent.click(await screen.findByRole("button", { name: "Copy Relative Path" }));
    await waitFor(() => expect(workspaceTestHarness.clipboardMocks.writeText).toHaveBeenCalledWith("README.md"));

    fireEvent.contextMenu(fileRow);
    fireEvent.click(await screen.findByRole("button", { name: "Copy Path" }));
    await waitFor(() => expect(workspaceTestHarness.clipboardMocks.writeText).toHaveBeenCalledWith("/repo/app/README.md"));

    fireEvent.contextMenu(fileRow);
    fireEvent.click(await screen.findByRole("button", { name: "Add to .gitignore" }));
    await waitFor(() => expect(workspaceTestHarness.gitMocks.gitIgnorePath).toHaveBeenCalledWith(
      "/repo/app",
      "README.md",
      false,
    ));

    const dirRow = await screen.findByTestId("code-workspace-tree-dir");
    fireEvent.contextMenu(dirRow);
    fireEvent.click(await screen.findByRole("button", { name: "Find in Directory..." }));
    expect(screen.getByRole("tab", { name: /Search/, selected: true })).toBeInTheDocument();
    expect(screen.getByLabelText("Include globs")).toHaveValue("src/**");

    fireEvent.contextMenu(fileRow);
    fireEvent.click(await screen.findByRole("button", { name: "Open in Terminal" }));
    expect(screen.getByRole("tab", { name: /Terminal/, selected: true })).toBeInTheDocument();
    expect(await screen.findByTestId("mock-workspace-terminal")).toHaveAttribute("data-initial-cwd", "/repo/app");
  });
it("releases a workspace's store instance when the tab is rebound to another", async () => {
    // The StrictMode-safe teardown defers disposal by a macrotask so a remount
    // can cancel it. Only a remount of the SAME workspace may cancel: rebinding
    // the tab to a different workspace must still release the old instance, or
    // its entry (open files, editor groups, LSP state) leaks for the session.
    const first: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/one",
      workspaceId: "ws-rebind-1",
      workspaceInstanceId: "instance-rebind-1",
      name: "One",
      roots: [{ id: "one", name: "one", path: "/repo/one", kind: "git" }],
      looseFiles: [],
    };
    const second: CodeWorkspaceTabInfo = {
      ...first,
      repoRoot: "/repo/two",
      workspaceId: "ws-rebind-2",
      workspaceInstanceId: "instance-rebind-2",
      name: "Two",
      roots: [{ id: "two", name: "two", path: "/repo/two", kind: "git" }],
    };
    workspaceTestHarness.workspaceMocks.workspaceListDir.mockResolvedValue([]);

    const view = render(<CodeWorkspaceTab tabId="tab-code" workspace={first} visible />);
    await waitFor(() => expect(
      useCodeWorkspaceStore.getState().byInstanceId["instance-rebind-1"],
    ).toBeTruthy());

    view.rerender(<CodeWorkspaceTab tabId="tab-code" workspace={second} visible />);
    await waitFor(() => expect(
      useCodeWorkspaceStore.getState().byInstanceId["instance-rebind-1"],
    ).toBeUndefined());
    expect(useCodeWorkspaceStore.getState().byInstanceId["instance-rebind-2"]).toBeTruthy();
  });
it("closes the active editor tab with Ctrl+F4", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-close-tab",
      workspaceInstanceId: "instance-close-tab",
      name: "Close Tab",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/main.ts" },
    };
    workspaceTestHarness.workspaceMocks.workspaceReadFile.mockResolvedValue(workspaceTestHarness.file("src/main.ts", "export const value = 1;"));

    workspaceTestHarness.renderWorkspace(workspace);
    await screen.findByTitle("app / src/main.ts");
    fireEvent.keyDown(window, { key: "F4", ctrlKey: true });

    await waitFor(() => expect(
      selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "instance-close-tab")
        .editorGroups.primary.openOrder,
      ).toHaveLength(0));
  });
it("ED-TREE-001 moves selection without opening files or toggling directories", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app", workspaceId: "ws-tree-nav", workspaceInstanceId: "instance-tree-nav",
      name: "Tree navigation", roots: [{ id: "app", name: "app", path: "/repo/app", kind: "folder" }], looseFiles: [],
    };
    workspaceTestHarness.workspaceMocks.workspaceListDir.mockImplementation(async (_root: string, path: string) => path === "src"
      ? [workspaceTestHarness.entry("example.txt", "src/example.txt")]
      : [workspaceTestHarness.entry("src", "src", "dir"), workspaceTestHarness.entry("README.md", "README.md"), workspaceTestHarness.entry("notes.txt", "notes.txt")]);
    workspaceTestHarness.workspaceMocks.workspaceReadFile.mockImplementation(async (_root: string, path: string) => workspaceTestHarness.file(path, `Keep ${path}`));
    workspaceTestHarness.renderWorkspace(workspace);
    const readme = (await screen.findAllByTestId("code-workspace-tree-file")).find((row) => row.dataset.path === "README.md")!;
    fireEvent.doubleClick(readme);
    await screen.findByTitle("app / README.md");
    const before = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "instance-tree-nav");
    const pane = screen.getByTestId("code-workspace-tree-pane");
    fireEvent.keyDown(pane, { key: "ArrowDown" });
    expect(selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "instance-tree-nav").treeSelection)
      .toEqual({ kind: "file", ref: { kind: "root", rootId: "app", path: "notes.txt" } });
    expect(workspaceTestHarness.workspaceMocks.workspaceReadFile).not.toHaveBeenCalledWith("/repo/app", "notes.txt");
    fireEvent.keyDown(pane, { key: "ArrowUp" });
    fireEvent.keyDown(pane, { key: "ArrowUp" });
    expect(screen.queryByTitle("app / src/example.txt")).toBeNull();
    expect(workspaceTestHarness.workspaceMocks.workspaceListDir).not.toHaveBeenCalledWith("/repo/app", "src");
    const after = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "instance-tree-nav");
    expect(after.editorGroups.primary).toEqual(before.editorGroups.primary);
    expect(after.openFiles).toEqual(before.openFiles);
    fireEvent.keyDown(screen.getByTestId("code-workspace-tree-new"), { key: "ArrowDown" });
    fireEvent.keyDown(screen.getByTestId("code-workspace-tree-view-selector"), { key: "ArrowDown" });
    expect(selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "instance-tree-nav").treeSelection).toEqual(after.treeSelection);
  });
it("ED-TREE-001 expands, enters children, returns to parent and collapses directionally", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app", workspaceId: "ws-tree-direction", workspaceInstanceId: "instance-tree-direction",
      name: "Tree direction", roots: [{ id: "app", name: "app", path: "/repo/app", kind: "folder" }], looseFiles: [],
    };
    workspaceTestHarness.workspaceMocks.workspaceListDir.mockImplementation(async (_root: string, path: string) => path === "src"
      ? [workspaceTestHarness.entry("example.txt", "src/example.txt")]
      : [workspaceTestHarness.entry("src", "src", "dir")]);
    workspaceTestHarness.workspaceMocks.workspaceReadFile.mockResolvedValue(workspaceTestHarness.file("src/example.txt", "Keep tree navigation"));
    workspaceTestHarness.renderWorkspace(workspace);
    const dir = await screen.findByTestId("code-workspace-tree-dir");
    // Select via the existing context action so this setup does not depend on
    // directory click expansion, which may be redesigned separately.
    fireEvent.contextMenu(dir);
    fireEvent.keyDown(document, { key: "Escape" });
    const pane = screen.getByTestId("code-workspace-tree-pane");
    fireEvent.keyDown(pane, { key: "ArrowRight" });
    const child = await screen.findByTestId("code-workspace-tree-file");
    fireEvent.keyDown(pane, { key: "ArrowRight" });
    expect(child).toHaveAttribute("data-selected", "true");
    expect(workspaceTestHarness.workspaceMocks.workspaceReadFile).not.toHaveBeenCalled();
    fireEvent.keyDown(pane, { key: "ArrowLeft" });
    expect(dir).toHaveAttribute("data-selected", "true");
    expect(child).toBeInTheDocument();
    fireEvent.keyDown(pane, { key: "ArrowLeft" });
    expect(screen.queryByTestId("code-workspace-tree-file")).toBeNull();
    fireEvent.keyDown(pane, { key: "ArrowLeft" });
    expect(screen.getByTestId("code-workspace-tree-root")).toHaveAttribute("data-selected", "true");
    fireEvent.keyDown(pane, { key: "ArrowRight" });
    expect(dir).toHaveAttribute("data-selected", "true");
    fireEvent.keyDown(pane, { key: "ArrowRight" });
    await screen.findByTestId("code-workspace-tree-file");
    fireEvent.keyDown(pane, { key: "ArrowDown" });
    fireEvent.keyDown(pane, { key: "Enter" });
    await waitFor(() => expect(workspaceTestHarness.workspaceMocks.workspaceReadFile).toHaveBeenCalledWith("/repo/app", "src/example.txt"));
    expect(screen.getByRole("treeitem", { name: /example.txt/ })).toHaveAttribute("aria-selected", "true");
  });
it("ED-TREEOPEN-001: Enter on tree file formally opens and grants focus to editor without editor click", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-tree-open-focus",
      workspaceInstanceId: "instance-tree-open-focus",
      name: "Tree Open Focus",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "folder" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "README.md" },
    };
    workspaceTestHarness.workspaceMocks.workspaceListDir.mockImplementation(async (_root: string, path: string) => path === "src"
      ? [workspaceTestHarness.entry("example.txt", "src/example.txt")]
      : [workspaceTestHarness.entry("src", "src", "dir"), workspaceTestHarness.entry("README.md", "README.md")]);
    const originalText = "hello tree open focus parity\n";
    workspaceTestHarness.workspaceMocks.workspaceReadFile.mockImplementation(async (_root: string, path: string) =>
      workspaceTestHarness.file(path, path === "README.md" ? "# Readme\n" : originalText));

    workspaceTestHarness.renderWorkspace(workspace);
    await screen.findByTitle("app / README.md");

    const pane = screen.getByTestId("code-workspace-tree-pane");
    const dir = await screen.findByTestId("code-workspace-tree-dir");

    // Expand dir by double clicking
    fireEvent.doubleClick(dir);
    const exampleFile = await screen.findByRole("treeitem", { name: /example.txt/ });
    expect(exampleFile).toBeInTheDocument();

    // Select example.txt and press Enter
    fireEvent.click(exampleFile);
    fireEvent.keyDown(pane, { key: "Enter" });

    // Verify example.txt tab is opened and active
    await screen.findByTitle("app / src/example.txt");
    await waitFor(() => {
      const activeElement = document.activeElement;
      expect(activeElement?.classList.contains("cm-content")).toBe(true);
    });

    const cmContent = document.querySelector<HTMLElement>(".cm-content")!;
    expect(document.activeElement).toBe(cmContent);

    // Direct input without clicking editor
    const view = EditorView.findFromDOM(document.querySelector<HTMLElement>(".cm-editor")!)!;
    expect(view.state.doc.toString()).toBe(originalText);
    view.dispatch({ changes: { from: 0, to: 0, insert: "typed-input;" } });
    expect(view.state.doc.toString()).toBe("typed-input;" + originalText);

    // Undo reverts back to original text
    fireEvent.keyDown(cmContent, { key: "z", ctrlKey: true });
    await waitFor(() => expect(view.state.doc.toString()).toBe(originalText));

    // Return to tree and right-click -> Esc restores selection and focus without mutating text
    fireEvent.contextMenu(exampleFile);
    expect(await screen.findByRole("button", { name: "Open" })).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("button", { name: "Open" })).not.toBeInTheDocument());
    expect(document.activeElement).toBe(exampleFile);
    expect(view.state.doc.toString()).toBe(originalText);
  });
it("ED-TREEOPEN-001 / DEC-TOF-01: single click on tree item only selects without opening or stealing focus", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-single-click",
      workspaceInstanceId: "instance-single-click",
      name: "Single Click",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "folder" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "README.md" },
    };
    workspaceTestHarness.workspaceMocks.workspaceListDir.mockResolvedValue([
      workspaceTestHarness.entry("README.md", "README.md"),
      workspaceTestHarness.entry("other.txt", "other.txt"),
    ]);
    workspaceTestHarness.workspaceMocks.workspaceReadFile.mockImplementation(async (_root: string, path: string) =>
      workspaceTestHarness.file(path, path === "README.md" ? "# Readme\n" : "other content\n"));

    workspaceTestHarness.renderWorkspace(workspace);
    await screen.findByTitle("app / README.md");

    const otherRow = (await screen.findAllByTestId("code-workspace-tree-file")).find((r) => r.dataset.path === "other.txt")!;
    fireEvent.click(otherRow);

    expect(otherRow).toHaveAttribute("data-selected", "true");

    const ui = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "instance-single-click");
    expect(ui.editorGroups.primary.openOrder).toEqual(["root:app:README.md"]);
    expect(workspaceTestHarness.workspaceMocks.workspaceReadFile).not.toHaveBeenCalledWith("/repo/app", "other.txt");
  });
it("ED-TREEOPEN-001 / DEC-TOF-04: context menu Escape closes menu and restores selection/focus to tree item", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-ctx-esc",
      workspaceInstanceId: "instance-ctx-esc",
      name: "Context Escape",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "folder" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "README.md" },
    };
    workspaceTestHarness.workspaceMocks.workspaceListDir.mockResolvedValue([
      workspaceTestHarness.entry("README.md", "README.md"),
      workspaceTestHarness.entry("other.txt", "other.txt"),
    ]);
    workspaceTestHarness.workspaceMocks.workspaceReadFile.mockResolvedValue(workspaceTestHarness.file("README.md", "# Readme\n"));

    workspaceTestHarness.renderWorkspace(workspace);
    await screen.findByTitle("app / README.md");

    const otherRow = (await screen.findAllByTestId("code-workspace-tree-file")).find((r) => r.dataset.path === "other.txt")!;
    fireEvent.contextMenu(otherRow);

    expect(await screen.findByRole("button", { name: "Open" })).toBeInTheDocument();

    fireEvent.keyDown(document, { key: "Escape" });

    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Open" })).not.toBeInTheDocument();
    });

    expect(otherRow).toHaveAttribute("data-selected", "true");
    expect(document.activeElement).toBe(otherRow);
  });
it("ED-TREEOPEN-001 / DEC-TOF-04: a WebView focus reset after the menu unmounts still returns the tree row", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-ctx-esc-reset",
      workspaceInstanceId: "instance-ctx-esc-reset",
      name: "Context Escape Reset",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "folder" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "README.md" },
    };
    workspaceTestHarness.workspaceMocks.workspaceListDir.mockResolvedValue([
      workspaceTestHarness.entry("README.md", "README.md"),
      workspaceTestHarness.entry("other.txt", "other.txt"),
    ]);
    workspaceTestHarness.workspaceMocks.workspaceReadFile.mockResolvedValue(workspaceTestHarness.file("README.md", "# Readme\n"));

    workspaceTestHarness.renderWorkspace(workspace);
    await screen.findByTitle("app / README.md");

    const otherRow = (await screen.findAllByTestId("code-workspace-tree-file")).find((r) => r.dataset.path === "other.txt")!;
    fireEvent.contextMenu(otherRow);

    expect(await screen.findByRole("button", { name: "Open" })).toBeInTheDocument();

    fireEvent.keyDown(document, { key: "Escape" });

    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Open" })).not.toBeInTheDocument();
    });

    // WebView2 drops DOM focus to the body when the focused menu node leaves
    // the document, after the restore that ran before the unmount commit.
    (document.activeElement as HTMLElement | null)?.blur();

    await waitFor(() => {
      expect(document.activeElement).toBe(otherRow);
    });
  });
it("ED-TREEOPEN-001 / DEC-TOF-04: context menu Open opens file and grants focus to editor", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-ctx-open",
      workspaceInstanceId: "instance-ctx-open",
      name: "Context Open",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "folder" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "README.md" },
    };
    workspaceTestHarness.workspaceMocks.workspaceListDir.mockResolvedValue([
      workspaceTestHarness.entry("README.md", "README.md"),
      workspaceTestHarness.entry("other.txt", "other.txt"),
    ]);
    workspaceTestHarness.workspaceMocks.workspaceReadFile.mockImplementation(async (_root: string, path: string) =>
      workspaceTestHarness.file(path, path === "README.md" ? "# Readme\n" : "other content\n"));

    workspaceTestHarness.renderWorkspace(workspace);
    await screen.findByTitle("app / README.md");

    const otherRow = (await screen.findAllByTestId("code-workspace-tree-file")).find((r) => r.dataset.path === "other.txt")!;
    fireEvent.contextMenu(otherRow);

    const openButton = await screen.findByRole("button", { name: "Open" });
    fireEvent.click(openButton);

    await screen.findByTitle("app / other.txt");
    await waitFor(() => {
      expect(document.activeElement?.classList.contains("cm-content")).toBe(true);
    });
  });
it("ED-TREEOPEN-001 / DEC-TOF-05: IME composing Enter does not trigger tree open", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-ime-guard",
      workspaceInstanceId: "instance-ime-guard",
      name: "IME Guard",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "folder" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "README.md" },
    };
    workspaceTestHarness.workspaceMocks.workspaceListDir.mockResolvedValue([
      workspaceTestHarness.entry("README.md", "README.md"),
      workspaceTestHarness.entry("other.txt", "other.txt"),
    ]);
    workspaceTestHarness.workspaceMocks.workspaceReadFile.mockResolvedValue(workspaceTestHarness.file("README.md", "# Readme\n"));

    workspaceTestHarness.renderWorkspace(workspace);
    await screen.findByTitle("app / README.md");

    const pane = screen.getByTestId("code-workspace-tree-pane");
    const otherRow = (await screen.findAllByTestId("code-workspace-tree-file")).find((r) => r.dataset.path === "other.txt")!;
    fireEvent.click(otherRow);

    fireEvent.keyDown(pane, { key: "Enter", isComposing: true });

    const ui = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "instance-ime-guard");
    expect(ui.editorGroups.primary.openOrder).toEqual(["root:app:README.md"]);
    expect(workspaceTestHarness.workspaceMocks.workspaceReadFile).not.toHaveBeenCalledWith("/repo/app", "other.txt");
  });
it("scans open-file TODOs and toggles persistent bookmarks with F11", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-todos",
      workspaceInstanceId: "instance-todos",
      name: "TODOs",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/main.ts" },
    };
    workspaceTestHarness.workspaceMocks.workspaceReadFile.mockResolvedValue(workspaceTestHarness.file(
      "src/main.ts",
      "const value = 1; // TODO: replace fixture",
    ));

    workspaceTestHarness.renderWorkspace(workspace);
    await screen.findByTitle("app / src/main.ts");
    const editor = screen.getByTestId("code-workspace-editor-pane");
    fireEvent.keyDown(editor, { key: "F11", code: "F11" });

    const panel = await screen.findByTestId("code-workspace-todos-panel");
    expect(screen.getByRole("tab", { name: /TODOs/, selected: true })).toBeInTheDocument();
    expect(panel).toHaveTextContent("replace fixture");
    expect(panel).toHaveTextContent("const value = 1");
    expect(window.localStorage.getItem("taomni.codeWorkspace.bookmarks.v1.instance-todos"))
      .toContain("root:app:src/main.ts");

    fireEvent.keyDown(editor, { key: "F11", code: "F11" });
    await waitFor(() => expect(panel).toHaveTextContent("No bookmarks yet"));
  });
it("keeps a deleted bookmark as missing and restores it when the file is recreated", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-bookmark-resource-lifecycle",
      workspaceInstanceId: "instance-bookmark-resource-lifecycle",
      name: "Bookmark resource lifecycle",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "folder" }],
      looseFiles: [],
    };
    const disk = new Map([["src/bookmark.ts", "const bookmarked = true;\n"]]);
    const listDirectory = (_root: string, path = "") => {
      if (path === "") return [workspaceTestHarness.entry("src", "src", "dir")];
      if (path === "src" && disk.has("src/bookmark.ts")) return [workspaceTestHarness.entry("bookmark.ts", "src/bookmark.ts")];
      return [];
    };
    workspaceTestHarness.workspaceMocks.workspaceListDir.mockImplementation(async (root: string, path = "") => listDirectory(root, path));
    workspaceTestHarness.workspaceMocks.workspaceReadFile.mockImplementation(async (_root: string, path: string) => {
      const text = disk.get(path);
      if (text === undefined) throw new Error(`missing fixture ${path}`);
      return workspaceTestHarness.file(path, text);
    });
    workspaceTestHarness.workspaceMocks.workspaceApplyResourceOperation.mockImplementation(async (
      _root: string,
      operation: { kind: string; path?: string },
    ) => {
      if (operation.kind === "delete" && operation.path) disk.delete(operation.path);
      return { ignored: false };
    });
    workspaceTestHarness.workspaceMocks.workspaceCreateFile.mockImplementation(async (_root: string, path: string) => {
      const text = "const recreated = true;\n";
      disk.set(path, text);
      return workspaceTestHarness.file(path, text);
    });

    workspaceTestHarness.renderWorkspace(workspace);
    const directory = await screen.findByTestId("code-workspace-tree-dir");
    fireEvent.doubleClick(directory);
    const row = await screen.findByTestId("code-workspace-tree-file");
    fireEvent.doubleClick(row);
    await screen.findByTitle("app / src/bookmark.ts");
    const editor = screen.getByTestId("code-workspace-editor-pane");
    fireEvent.keyDown(editor, { key: "F11", code: "F11" });
    await screen.findByTestId("code-workspace-bookmark-item");

    // The tree pane is the keyboard owner; dispatch against its focus target
    // so the test follows the mounted tree shortcut path used by the app.
    fireEvent.keyDown(screen.getByTestId("code-workspace-tree-pane"), {
      key: "Delete",
      code: "Delete",
    });
    await waitFor(() => expect(workspaceTestHarness.workspaceMocks.workspaceApplyResourceOperation).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByTestId("code-workspace-bookmark-item"))
      .toHaveAttribute("data-state", "missing"));
    expect(screen.getByTestId("code-workspace-bookmark-missing")).toHaveTextContent("Missing target");
    expect(disk.has("src/bookmark.ts")).toBe(false);

    vi.mocked(promptAppDialog).mockResolvedValueOnce("src/bookmark.ts");
    fireEvent.click(screen.getByTestId("code-workspace-tree-new"));
    fireEvent.click(screen.getByTestId("code-workspace-tree-new-file"));
    await waitFor(() => expect(screen.getByTestId("code-workspace-bookmark-item"))
      .toHaveAttribute("data-state", "current"));
    expect(disk.has("src/bookmark.ts")).toBe(true);
    expect(screen.getByTestId("code-workspace-bookmark-open")).toBeInTheDocument();
  });
it("toggles the project tree from the panel-local collapse control and collapsed rail", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-tree-collapse",
      workspaceInstanceId: "instance-tree-collapse",
      name: "Tree Collapse",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
    };
    workspaceTestHarness.renderWorkspace(workspace);

    await screen.findByTestId("code-workspace-tree-pane");
    expect(screen.getByTestId("code-workspace-tree-collapse")).toBeInTheDocument();
    expect(screen.getByTestId("code-workspace-project-resize-handle")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("code-workspace-tree-collapse"));
    await waitFor(() => {
      expect(selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "instance-tree-collapse").languagePanelOpen)
        .toBe(false);
    });
    expect(screen.getByTestId("code-workspace-tool-rail-project")).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(screen.getByTestId("code-workspace-tool-rail-project"));
    await waitFor(() => {
      expect(selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "instance-tree-collapse").languagePanelOpen)
        .toBe(true);
    });
    expect(screen.getByTestId("code-workspace-tool-rail-project")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("code-workspace-tree-collapse")).toBeInTheDocument();
  });
it("routes Ctrl+B (Go to Declaration) directly to definition navigation for Java files", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-java-ctrl-b-definition-reuse",
      workspaceInstanceId: "instance-java-ctrl-b-definition-reuse",
      name: "Java Ctrl+B definition reuse",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/Main.java" },
    };
    const source = "class Main { void target() {} void call() { target(); } }\n";
    const status = workspaceTestHarness.documentStatus({
      path: "/repo/app/src/Main.java",
      uri: "file:///repo/app/src/Main.java",
      presetId: "java",
      languageId: "java",
      displayName: "Java",
      available: true,
      active: true,
      capabilities: workspaceTestHarness.defaultCapabilities({
        definition: true,
        declaration: false,
      }),
    });
    const target = {
      uri: "file:///repo/app/src/Main.java",
      path: "/repo/app/src/Main.java",
      range: { start: { line: 0, character: 19 }, end: { line: 0, character: 25 } },
    };
    workspaceTestHarness.workspaceMocks.workspaceReadFile.mockResolvedValue(workspaceTestHarness.file("src/Main.java", source));
    workspaceTestHarness.lspMocks.lspOpenDocument.mockResolvedValue(status);
    workspaceTestHarness.lspMocks.lspGetDiagnostics.mockResolvedValue({ status, diagnostics: [] });
    workspaceTestHarness.lspMocks.lspDefinition.mockResolvedValue({ status, locations: [target] });
    workspaceTestHarness.lspMocks.lspDeclaration.mockResolvedValue({ status, locations: [] });

    const registrationRef: { current: WorkspaceCommandRegistration | null } = { current: null };
    const onCommandsChange = vi.fn((_tabId: string, next: WorkspaceCommandRegistration | null) => {
      if (next) registrationRef.current = next;
    });

    workspaceTestHarness.renderWorkspace(workspace, { onCommandsChange });
    await screen.findByTitle("app / src/Main.java");
    const fileKey = "root:app:src/Main.java";
    await waitFor(() => expect(
      selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "instance-java-ctrl-b-definition-reuse")
        .lspFiles[fileKey]?.syncedText,
    ).toBe(source));

    // Even though declaration capability is false, definition capability is true so Go to Declaration stays enabled
    await waitFor(() => expect(registrationRef.current?.items.find(
      (item) => item.id === "workspace.gotoDeclaration",
    )?.enabled).toBe(true));

    workspaceTestHarness.lspMocks.lspDefinition.mockClear();
    workspaceTestHarness.lspMocks.lspDeclaration.mockClear();

    await act(async () => {
      await registrationRef.current?.executeAction("workspace.gotoDeclaration");
      await Promise.resolve();
    });

    // In Java, Ctrl+B reuses the definition pipeline directly
    await waitFor(() => expect(workspaceTestHarness.lspMocks.lspDefinition).toHaveBeenCalled());
    expect(workspaceTestHarness.lspMocks.lspDeclaration).not.toHaveBeenCalled();
  });
it("opens Search Everywhere with Ctrl+N and Ctrl+Shift+N when viewing a Java file", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-shortcuts-test",
      workspaceInstanceId: "instance-shortcuts-test",
      name: "Shortcuts test",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/App.java" },
    };
    workspaceTestHarness.workspaceMocks.workspaceReadFile.mockResolvedValue(
      workspaceTestHarness.file("src/App.java", "public class App { public static void main(String[] args) {} }"),
    );
    workspaceTestHarness.workspaceMocks.workspaceListDir.mockResolvedValue([
      { name: "App.java", path: "src/App.java", fileType: "file", size: 50, mtime: 1 },
    ]);
    workspaceTestHarness.workspaceMocks.workspaceListFilesRecursive.mockResolvedValue([
      { name: "App.java", path: "src/App.java", fileType: "file", size: 50, mtime: 1 },
    ]);

    workspaceTestHarness.renderWorkspace(workspace, {}, { strict: true });
    await screen.findByTitle("app / src/App.java");

    // 1. Press Ctrl+Shift+N to open Search Everywhere (Files mode)
    await act(async () => {
      fireEvent.keyDown(window, {
        key: "N",
        code: "KeyN",
        ctrlKey: true,
        shiftKey: true,
      });
    });

    const overlay1 = await screen.findByTestId("code-workspace-search-everywhere");
    expect(overlay1).toBeInTheDocument();

    // Close with Escape on the searchbox input
    await act(async () => {
      fireEvent.keyDown(within(overlay1).getByRole("searchbox"), { key: "Escape" });
    });
    await waitFor(() => {
      expect(screen.queryByTestId("code-workspace-search-everywhere")).not.toBeInTheDocument();
    });

    // 2. Press Ctrl+N to open Search Everywhere (Classes mode or fallback)
    await act(async () => {
      fireEvent.keyDown(window, {
        key: "n",
        code: "KeyN",
        ctrlKey: true,
        shiftKey: false,
      });
    });

    const overlay2 = await screen.findByTestId("code-workspace-search-everywhere");
    expect(overlay2).toBeInTheDocument();

    // Close with Escape
    await act(async () => {
      fireEvent.keyDown(within(overlay2).getByRole("searchbox"), { key: "Escape" });
    });
    await waitFor(() => {
      expect(screen.queryByTestId("code-workspace-search-everywhere")).not.toBeInTheDocument();
    });

    // macOS sends the Command chord; it must open the same Files view. Cmd
    // aliases exist only on macOS (ED-PARITY-013 DEC-013-01).
    setKeymapPlatformOverride("mac");
    await act(async () => {
      fireEvent.keyDown(window, {
        key: "N",
        code: "KeyN",
        metaKey: true,
        shiftKey: true,
      });
    });
    const overlay3 = await screen.findByTestId("code-workspace-search-everywhere");
    expect(overlay3).toBeInTheDocument();
    await act(async () => {
      fireEvent.keyDown(within(overlay3).getByRole("searchbox"), { key: "Escape" });
    });
    await waitFor(() => {
      expect(screen.queryByTestId("code-workspace-search-everywhere")).not.toBeInTheDocument();
    });
  });
describe("N2.6 Ctrl+Tab Switcher", () => {
    it("opens on Ctrl+Tab, cycles with Shift, commits on Control release", async () => {
      const workspace: CodeWorkspaceTabInfo = {
        repoRoot: "/repo/app",
        workspaceId: "ws-switcher",
        workspaceInstanceId: "instance-switcher",
        name: "Switcher",
        roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
        looseFiles: [],
        initialFile: { kind: "root", rootId: "app", path: "src/main.ts" },
      };
      workspaceTestHarness.workspaceMocks.workspaceListDir.mockResolvedValue([
        workspaceTestHarness.entry("src", "src", "dir"),
        workspaceTestHarness.entry("other.ts", "other.ts"),
      ]);
      workspaceTestHarness.workspaceMocks.workspaceReadFile.mockImplementation(async (_root: string, path: string) =>
        workspaceTestHarness.file(path, path === "src/main.ts" ? "const main = 1;\n" : "const other = 2;\n"));

      const rendered = workspaceTestHarness.renderWorkspace(workspace);
      await screen.findByTitle("app / src/main.ts");
      fireEvent.doubleClick(screen.getByTestId("code-workspace-tree-file"));
      await screen.findByTitle("app / other.ts");

      // Ctrl+Tab opens the switcher with the previous file preselected.
      fireEvent.keyDown(window, { key: "Tab", ctrlKey: true });
      const switcher = await screen.findByTestId("workspace-tab-switcher");
      expect(switcher).toBeInTheDocument();
      // The previous file (main.ts) is preselected per IDEA MRU semantics.
      const selected = switcher.querySelector('[data-switcher-selected="true"]');
      expect(selected?.textContent).toContain("main.ts");

      // Releasing Control commits the preselected entry.
      fireEvent.keyUp(window, { key: "Control" });
      await waitFor(() => {
        expect(screen.queryByTestId("workspace-tab-switcher")).not.toBeInTheDocument();
      });
      await waitFor(() => {
        const active = rendered.container.querySelector("[data-editor-tab-key][data-active=true]");
        expect(active?.getAttribute("data-editor-tab-key")).toBe("root:app:src/main.ts");
      });
    });

    it("cancels with Escape without changing the active tab", async () => {
      const workspace: CodeWorkspaceTabInfo = {
        repoRoot: "/repo/app",
        workspaceId: "ws-switcher-cancel",
        workspaceInstanceId: "instance-switcher-cancel",
        name: "Switcher Cancel",
        roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
        looseFiles: [],
        initialFile: { kind: "root", rootId: "app", path: "src/main.ts" },
      };
      workspaceTestHarness.workspaceMocks.workspaceListDir.mockResolvedValue([
        workspaceTestHarness.entry("src", "src", "dir"),
        workspaceTestHarness.entry("other.ts", "other.ts"),
      ]);
      workspaceTestHarness.workspaceMocks.workspaceReadFile.mockImplementation(async (_root: string, path: string) =>
        workspaceTestHarness.file(path, "const value = 1;\n"));

      const rendered = workspaceTestHarness.renderWorkspace(workspace);
      await screen.findByTitle("app / src/main.ts");
      fireEvent.doubleClick(screen.getByTestId("code-workspace-tree-file"));
      await screen.findByTitle("app / other.ts");

      fireEvent.keyDown(window, { key: "Tab", ctrlKey: true });
      await screen.findByTestId("workspace-tab-switcher");
      fireEvent.keyDown(window, { key: "Escape" });
      await waitFor(() => {
        expect(screen.queryByTestId("workspace-tab-switcher")).not.toBeInTheDocument();
      });
      const active = rendered.container.querySelector("[data-editor-tab-key][data-active=true]");
      expect(active?.getAttribute("data-editor-tab-key")).toBe("root:app:other.ts");
    });

    it("refuses Backspace close for pinned tabs and keeps the switcher open (§8.19.6)", async () => {
      const workspace: CodeWorkspaceTabInfo = {
        repoRoot: "/repo/app",
        workspaceId: "ws-switcher-pin",
        workspaceInstanceId: "instance-switcher-pin",
        name: "Switcher Pin",
        roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
        looseFiles: [],
        initialFile: { kind: "root", rootId: "app", path: "src/main.ts" },
      };
      workspaceTestHarness.workspaceMocks.workspaceListDir.mockResolvedValue([
        workspaceTestHarness.entry("src", "src", "dir"),
        workspaceTestHarness.entry("other.ts", "other.ts"),
      ]);
      workspaceTestHarness.workspaceMocks.workspaceReadFile.mockImplementation(async (_root: string, path: string) =>
        workspaceTestHarness.file(path, "const value = 1;\n"));

      workspaceTestHarness.renderWorkspace(workspace);
      await screen.findByTitle("app / src/main.ts");
      fireEvent.doubleClick(screen.getByTestId("code-workspace-tree-file"));
      await screen.findByTitle("app / other.ts");

      // MRU is [other, main]: index 1 preselects main.ts. Pin it directly in
      // its group so Backspace must refuse instead of closing protected work.
      // The Switcher freezes its snapshot at open time, so the pin must be
      // committed to the tree BEFORE the popup opens to be part of it.
      await act(async () => {
        useCodeWorkspaceStore.getState().updateEditorGroup("instance-switcher-pin", "primary", (group) => ({
          ...group,
          pinnedKeys: [...group.pinnedKeys, "root:app:src/main.ts"],
        }));
      });

      fireEvent.keyDown(window, { key: "Tab", ctrlKey: true });
      const switcher = await screen.findByTestId("workspace-tab-switcher");
      expect(switcher.querySelector('[data-switcher-selected="true"]')?.textContent).toContain("main.ts");
      expect(switcher.querySelector('[data-switcher-selected="true"]')?.textContent).toContain("📌");

      fireEvent.keyDown(window, { key: "Backspace" });
      await waitFor(() => expect(useAppStore.getState().statusMessage).toContain("pinned"));
      // Protected work stays open and the popup remains up for another pick.
      expect(screen.getByTestId("workspace-tab-switcher")).toBeInTheDocument();
      expect(
        selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "instance-switcher-pin")
          .editorGroups.primary?.openOrder,
      ).toContain("root:app:src/main.ts");

      fireEvent.keyDown(window, { key: "Escape" });
    });

    it("reopens a closed tab into the nearest surviving split after its leaf closes (§8.19.6)", async () => {
      const workspace: CodeWorkspaceTabInfo = {
        repoRoot: "/repo/app",
        workspaceId: "ws-switcher-reopen",
        workspaceInstanceId: "instance-switcher-reopen",
        name: "Switcher Reopen",
        roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
        looseFiles: [],
        initialFile: { kind: "root", rootId: "app", path: "src/main.ts" },
      };
      workspaceTestHarness.workspaceMocks.workspaceListDir.mockResolvedValue([
        workspaceTestHarness.entry("src", "src", "dir"),
        workspaceTestHarness.entry("other.ts", "other.ts"),
      ]);
      workspaceTestHarness.workspaceMocks.workspaceReadFile.mockImplementation(async (_root: string, path: string) =>
        workspaceTestHarness.file(path, path === "src/main.ts" ? "const main = 1;\n" : "const other = 2;\n"));

      const rendered = workspaceTestHarness.renderWorkspace(workspace);
      await screen.findByTitle("app / src/main.ts");
      // Split right: the new leaf owns main.ts and becomes active…
      fireEvent.click(workspaceTestHarness.toolbarControl("code-workspace-split-right"));
      await waitFor(() => expect(
        selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "instance-switcher-reopen").splitOrientation,
      ).toBe("vertical"));
      // …then other.ts opens in THAT leaf, recording its location evidence.
      fireEvent.doubleClick(screen.getByTestId("code-workspace-tree-file"));
      await screen.findByTitle("app / other.ts");

      // Close other.ts (clean tab → direct close, captures ReopenLocationV2).
      fireEvent.keyDown(window, { key: "f4", ctrlKey: true });
      await waitFor(() => {
        const ui = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "instance-switcher-reopen");
        expect(Object.values(ui.editorGroups).some((g) => g.openOrder.includes("root:app:other.ts"))).toBe(false);
      });

      // Collapse the split: other.ts's owning leaf disappears entirely.
      fireEvent.click(workspaceTestHarness.toolbarControl("code-workspace-split-close"));
      await waitFor(() => expect(
        selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "instance-switcher-reopen").splitOrientation,
      ).toBeNull());

      // Reopen resolves against the LIVE collapsed tree → relocated sibling.
      fireEvent.keyDown(window, { key: "t", shiftKey: true, ctrlKey: true });
      await waitFor(() => expect(useAppStore.getState().statusMessage).toContain("former tab group"));
      await waitFor(() => {
        const active = rendered.container.querySelector("[data-editor-tab-key][data-active=true]");
        expect(active?.getAttribute("data-editor-tab-key")).toBe("root:app:other.ts");
      });
    }, 20000);
  });
describe("ED-REPAIR-006: case-preserving POSIX replace path identity (mounted)", () => {
    function setupWorkspace(instanceId: string, openFile: string) {
      const disk: Record<string, string> = {};
      const workspace: CodeWorkspaceTabInfo = {
        repoRoot: "/repo/app",
        workspaceId: `ws-${instanceId}`,
        workspaceInstanceId: `instance-${instanceId}`,
        name: instanceId,
        roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
        looseFiles: [],
        initialFile: { kind: "root", rootId: "app", path: openFile },
      };
      workspaceTestHarness.workspaceMocks.workspaceListDir.mockImplementation(async (_root: string, path: string) => (
        path === "src"
          ? Object.keys(disk).map((rel) => workspaceTestHarness.entry(rel.split("/").pop()!, rel))
          : [workspaceTestHarness.entry("src", "src", "dir")]
      ));
      workspaceTestHarness.workspaceMocks.workspaceReadFile.mockImplementation(async (_root: string, path: string) => {
        if (!(path in disk)) throw new Error(`missing fixture file: ${path}`);
        return workspaceTestHarness.file(path, disk[path]!);
      });
      workspaceTestHarness.workspaceMocks.workspaceWriteFileEncoded.mockImplementation(async (
        _root: string,
        path: string,
        text: string,
      ) => {
        disk[path] = text;
        return workspaceTestHarness.writeAck(workspaceTestHarness.file(path, text, { hash: `hash-${text}` }));
      });
      const registrationRef: { current: WorkspaceCommandRegistration | null } = { current: null };
      const onCommandsChange = vi.fn((_tabId: string, next: WorkspaceCommandRegistration | null) => {
        if (next) registrationRef.current = next;
      });
      return { disk, workspace, registrationRef, onCommandsChange };
    }

    async function applyEditWithPreview(workspaceId: string | undefined, edit: unknown, label = "Replace all matches") {
      expect(workspaceId).toBeDefined();
      void emit("lsp://workspace-apply-edit", {
        requestId: `req-${Date.now()}`,
        workspaceId: workspaceId!,
        edit,
        label,
      });
      const preview = await screen.findByTestId("refactoring-preview-dialog");
      fireEvent.click(within(preview).getByTestId("refactoring-preview-apply"));
    }

    it("preserves distinct identities for /repo/app/src/A.java and /repo/app/src/a.java during replace preimages and apply (ED-REPAIR-006-A1, A3)", async () => {
      const { disk, workspace, onCommandsChange } = setupWorkspace("case-replace", "src/c.ts");
      disk["src/c.ts"] = "hello reader";
      disk["src/A.java"] = "hello UPPER_A";
      disk["src/a.java"] = "hello lower_a";

      workspaceTestHarness.renderWorkspace(workspace, { onCommandsChange });

      // Apply multi-file WorkspaceEdit that edits both case-distinct files
      await applyEditWithPreview(workspace.workspaceInstanceId, {
        documentEdits: [
          {
            uri: "file:///repo/app/src/A.java",
            path: "/repo/app/src/A.java",
            edits: [{ range: { start: { line: 0, character: 6 }, end: { line: 0, character: 13 } }, newText: "REPLACED_UPPER" }],
          },
          {
            uri: "file:///repo/app/src/a.java",
            path: "/repo/app/src/a.java",
            edits: [{ range: { start: { line: 0, character: 6 }, end: { line: 0, character: 13 } }, newText: "replaced_lower" }],
          },
        ],
      });

      // Both distinct files must be updated accurately on disk without overwriting each other
      await waitFor(() => expect(disk["src/A.java"]).toBe("hello REPLACED_UPPER"));
      expect(disk["src/a.java"]).toBe("hello replaced_lower");

      // Undo restores both distinct files accurately
      await act(async () => {
        fireEvent.keyDown(window, { key: "z", ctrlKey: true });
      });
      await workspaceTestHarness.confirmWorkspaceUndo();
      await waitFor(() => expect(disk["src/A.java"]).toBe("hello UPPER_A"));
      expect(disk["src/a.java"]).toBe("hello lower_a");
    });
  });
}
