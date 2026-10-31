import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { EditorView } from "@codemirror/view";
import { expect, it } from "vitest";
import { useWorkspacePlatformStore } from "../../../../stores/workspacePlatformStore";
import { useAppStore } from "../../../../stores/appStore";
import { WorkspaceCodeEditor } from "../../../workspace/WorkspaceCodeEditor";
import { WorkspaceTabStrip } from "../../../workspace/WorkspaceTabStrip";
import type { WorkspaceTestFixture } from "../../tests/codeWorkspaceTab/harness";

/** Real editor/outer-host integration; only filesystem and LSP are doubled. */
export function registerHostNavigationCases(h: Pick<WorkspaceTestFixture, "documentStatus" | "defaultCapabilities" | "workspaceMocks" | "file" | "lspMocks">) {
  it.each([
    { language: "java", source: "Main.java", target: "String.java", disk: false, uri: "jdt://contents/java.base/java.lang/String.class?=java.base" },
    { language: "csharp", source: "Main.cs", target: "String.cs", disk: false, uri: "csharp:/metadata/System/String.cs?assembly=System.Runtime" },
    { language: "typescript", source: "Main.ts", target: "String.ts", disk: true, uri: "file:///outside/String.ts" },
  ])("keeps $language navigation in distinct, named outer tabs", async ({ language, source, target, uri, disk }) => {
    const platform = useWorkspacePlatformStore.getState();
    platform.reloadFromStorage();
    useAppStore.setState({ activeSideTab: "workspaces" });
    const workspace = platform.createWorkspace({ name: "Navigation", rootPath: "/repo/app" });
    const root = workspace.rootFolders[0];
    const sourceTab = platform.openFileInWorkspace(workspace.id, { rootId: root.id, path: source });
    const status = h.documentStatus({ active: true, available: true, presetId: language, languageId: language,
      path: `/repo/app/${source}`, uri: `file:///repo/app/${source}`,
      capabilities: h.defaultCapabilities({ definition: true }) });
    h.workspaceMocks.workspaceListDir.mockResolvedValue([]);
    h.workspaceMocks.workspaceDetectGitRoots.mockResolvedValue([]);
    h.workspaceMocks.workspaceReadFile.mockResolvedValue(h.file(source, "class Main { String value; }"));
    h.lspMocks.lspOpenDocument.mockResolvedValue(status);
    h.lspMocks.lspChangeDocument.mockResolvedValue(status);
    h.lspMocks.lspGetDiagnostics.mockResolvedValue({ status, diagnostics: [] });
    h.lspMocks.lspDefinition.mockResolvedValue({ status, locations: [{ uri, path: disk ? "/outside/String.ts" : null,
      range: { start: { line: 0, character: 6 }, end: { line: 0, character: 12 } } }] });
    h.workspaceMocks.workspaceReadLooseFile.mockResolvedValue(h.file("/outside/String.ts", "class String {}"));
    h.lspMocks.lspReadUriContents.mockResolvedValue({ status, uri, path: null, title: target,
      container: "Standard library", languageId: language, text: "class String {}", readOnly: true });
    function Host() {
      const live = useWorkspacePlatformStore((s) => s.workspaces.find((w) => w.id === workspace.id)!);
      return <><WorkspaceTabStrip /><WorkspaceCodeEditor workspace={live} tabId="host-nav" visible sharedFiles /></>;
    }
    render(<Host />);
    const current = () => platform.getWorkspace(workspace.id)!;
    const contents = () => screen.getByTestId("code-workspace-editor").querySelector<HTMLElement>(".cm-content")!;
    await waitFor(() => expect(contents()?.textContent).toContain("class Main"));
    await waitFor(() => expect(h.lspMocks.lspOpenDocument).toHaveBeenCalled());
    fireEvent.keyDown(contents(), { key: "b", code: "KeyB", ctrlKey: true });
    await waitFor(() => expect(contents().textContent).toContain("class String"));
    const targetElement = () => document.querySelector<HTMLElement>(`[data-testid="workspace-tab"][data-tab-title="${target}"]`);
    await waitFor(() => expect(targetElement()).toHaveAttribute("aria-selected", "true"));
    expect(current().openTabs.map((tab) => tab.title)).toEqual([source, target]);
    await waitFor(() => expect(EditorView.findFromDOM(contents())?.state.readOnly).toBe(!disk));
    const libraryTabId = current().activeTabId;
    fireEvent.click(document.querySelector(`[data-testid="workspace-tab"][data-tab-title="${source}"]`)!);
    await waitFor(() => expect(contents().textContent).toContain("class Main"));
    fireEvent.keyDown(contents(), { key: "b", code: "KeyB", ctrlKey: true });
    await waitFor(() => expect(targetElement()).toHaveAttribute("aria-selected", "true"));
    expect(current().openTabs).toHaveLength(2);
    expect(current().activeTabId).toBe(libraryTabId);
    act(() => platform.closeWorkspaceTab(workspace.id, libraryTabId));
    await waitFor(() => expect(contents().textContent).toContain("class Main"));
    expect(current().activeTabId).toBe(sourceTab.id);
    fireEvent.keyDown(contents(), { key: "b", code: "KeyB", ctrlKey: true });
    await waitFor(() => expect(targetElement()).toHaveAttribute("aria-selected", "true"));
    expect(current().openTabs).toHaveLength(2);
    if (!disk) expect(h.workspaceMocks.workspaceReadLooseFile).not.toHaveBeenCalled();
    else expect(h.workspaceMocks.workspaceReadLooseFile).toHaveBeenCalledWith("/outside/String.ts");
    expect(h.workspaceMocks.workspaceWriteLooseFile).not.toHaveBeenCalled();
    // Virtual documents belong to the live provider; reload must never reopen
    // a jdt/metadata URI through the ordinary disk-file restore path.
    act(() => window.dispatchEvent(new Event("pagehide")));
    const stored = JSON.parse(localStorage.getItem("taomni.platformWorkspaces.v1")!);
    expect(stored.workspaces.find((w: { id: string }) => w.id === workspace.id).openTabs.map((t: { title: string }) => t.title)).toEqual(disk ? [source, target] : [source]);
    if (!disk) expect(JSON.stringify(stored.workspaces.find((w: { id: string }) => w.id === workspace.id))).not.toContain(uri);
    expect(EditorView.findFromDOM(contents())?.state.readOnly).toBe(!disk);
  });
}
