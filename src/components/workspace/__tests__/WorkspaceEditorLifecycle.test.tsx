import { StrictMode, useEffect } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useWorkspaceUiStore } from "../../../stores/workspaceUiStore";
import { EditorView } from "@codemirror/view";
import { WorkspaceMainPanel } from "../WorkspaceMainPanel";
import { useWorkspacePlatformStore, DEFAULT_WORKSPACE_ID } from "../../../stores/workspacePlatformStore";
import { useWorkspaceEditorStore } from "../../../stores/workspaceEditorStore";
import { readWorkspaceText, writeWorkspaceText } from "../workspaceFs";
import { readWorkspaceDocumentRecovery } from "../../../stores/workspaceDocumentRecovery";
import { useAppStore } from "../../../stores/appStore";
import type { WorkspaceCommandRegistration } from "../../editor/workspace/workspaceCommands";
import { useCodeWorkspaceStore } from "../../../stores/codeWorkspaceStore";
import { workspaceEditorRuntimeId } from "../../../lib/workspaceRuntimeIdentity";

vi.mock("../workspaceFs", () => ({
  readWorkspaceText: vi.fn(async () => ({ text: "const original = 1;\n", hash: "h1" })),
  writeWorkspaceText: vi.fn(async () => ({ hash: "h2" })),
}));
// Exercise the production shared editor. Mock only the filesystem boundary;
// renderer ownership, recovery, undo and host synchronization remain real.
vi.mock("../../../lib/editor/workspace", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../lib/editor/workspace")>(),
  workspaceReadFile: (...args: Parameters<typeof readWorkspaceText>) => readWorkspaceText(...args),
  workspaceWriteFile: (...args: Parameters<typeof writeWorkspaceText>) => writeWorkspaceText(...args),
  workspaceWriteFileEncoded: async (root: string, path: string, text: string, expectedHash: string | null) => {
    const result = await writeWorkspaceText(root, path, text, expectedHash);
    return { file: { ...result, path, text, size: text.length, mtime: 0, encoding: "utf-8", bom: false },
      writtenHash: result.hash, writtenByteLength: text.length, atomicReplaceUsed: true };
  },
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}), emit: vi.fn(async () => {}) }));
vi.mock("../WorkspaceGitPanel", () => ({ WorkspaceGitPanel: () => null }));
const runtime = vi.hoisted(() => ({ mounted: vi.fn(), released: vi.fn() }));
vi.mock("../WorkspaceSessionPane", () => ({ WorkspaceSessionPane: ({ tab }: { tab: { id: string } }) => {
  useEffect(() => {
    runtime.mounted(tab.id);
    return () => runtime.released(tab.id);
  }, [tab.id]);
  return null;
} }));
vi.mock("../../terminal/TerminalPanel", () => ({ TerminalPanel: () => null }));

// Match the main window's per-runtime registry: a hidden workspace may publish
// after the visible one, without taking over the visible editor's commands.
const commandPublications = new Map<string, WorkspaceCommandRegistration>();
const publishCommands = (id: string, value: WorkspaceCommandRegistration | null) => {
  if (value) commandPublications.set(id, value);
  else commandPublications.delete(id);
};
const activeCommands = () => commandPublications.get(workspaceEditorRuntimeId(useWorkspacePlatformStore.getState().getWorkspace()!))!;
function Panel({ visible = true }: { visible?: boolean }) {
  return <WorkspaceMainPanel visible={visible} onCommandsChange={publishCommands} />;
}

beforeEach(() => {
  commandPublications.clear();
  localStorage.clear();
  useWorkspaceUiStore.setState({ canvasLayouts: {} });
  useCodeWorkspaceStore.setState({ byInstanceId: {} });
  useAppStore.setState({ activeSideTab: "workspaces", codeWorkspaceByTab: {}, sidebarCollapsed: false });
  vi.clearAllMocks();
  vi.mocked(readWorkspaceText).mockReset().mockImplementation(async (_root, path) => ({
    path, text: "const original = 1;\n", hash: "h1", size: 20, mtime: 0, encoding: "utf-8", bom: false,
  }));
  vi.mocked(writeWorkspaceText).mockReset().mockResolvedValue({ hash: "h2" } as Awaited<ReturnType<typeof writeWorkspaceText>>);
  useWorkspacePlatformStore.getState().reloadFromStorage();
  useWorkspaceEditorStore.setState({ documents: {}, activeTabId: null });
  const store = useWorkspacePlatformStore.getState();
  store.addRootFolder(DEFAULT_WORKSPACE_ID, { path: "/preview" });
  const root = useWorkspacePlatformStore.getState().workspaces[0].rootFolders[0];
  store.openFileInWorkspace(DEFAULT_WORKSPACE_ID, { rootId: root.id, path: "index.ts" });
});
afterEach(cleanup);

it("recovers an unsaved buffer after remount and retains the original disk hash for conflict checks", async () => {
  const first = render(<Panel />);
  const view = await editor();
  act(() => view.dispatch({ userEvent: "input.type", changes: { from: 0, insert: "// recovery draft\n" } }));
  await waitFor(() => expect(screen.getByTestId("workspace-file-editor")).toHaveAttribute("data-dirty", "true"));
  first.unmount();
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  useWorkspaceEditorStore.setState({ documents: readWorkspaceDocumentRecovery(), activeTabId: null });
  vi.mocked(readWorkspaceText).mockImplementation(async (_root, path) => ({
    path, text: path === "index.ts" ? "changed externally" : "", hash: "external-hash",
    size: 18, mtime: 0, encoding: "utf-8", bom: false,
  }));
  render(<Panel />);
  expect((await editor()).state.doc.toString()).toContain("// recovery draft");
  await waitFor(() => expect(screen.getByTestId("workspace-file-editor")).toHaveAttribute("data-dirty", "true"));
  await waitFor(() => expect(screen.getByTestId("workspace-editor-save")).not.toBeDisabled());
  screen.getByTestId("workspace-editor-save").focus();
  fireEvent.click(screen.getByTestId("workspace-editor-save"));
  await waitFor(() => expect(writeWorkspaceText).toHaveBeenCalledWith("/preview", "index.ts", expect.stringContaining("// recovery draft"), "h1"));
});

it("starts only visited workspaces and retains their session owners while hidden", () => {
  const store = useWorkspacePlatformStore.getState();
  const first = store.openLocalTerminalInWorkspace(DEFAULT_WORKSPACE_ID);
  const secondWorkspace = store.createWorkspace({ name: "Second" });
  const second = store.openLocalTerminalInWorkspace(secondWorkspace.id);
  store.setActiveWorkspace(DEFAULT_WORKSPACE_ID);
  const { rerender } = render(<Panel visible={false} />);
  expect(runtime.mounted).not.toHaveBeenCalled();
  rerender(<Panel />);
  expect(runtime.mounted).toHaveBeenCalledTimes(1);
  expect(runtime.mounted).toHaveBeenCalledWith(first.id);
  act(() => store.setActiveWorkspace(secondWorkspace.id));
  expect(runtime.mounted).toHaveBeenCalledTimes(2);
  expect(runtime.mounted).toHaveBeenLastCalledWith(second.id);
  rerender(<Panel visible={false} />);
  expect(runtime.released).not.toHaveBeenCalled();
});

it("preserves the selected file when a cold workspace also restores a terminal before it", async () => {
  const platform = useWorkspacePlatformStore.getState();
  const file = platform.getWorkspace()!.openTabs[0];
  const terminal = platform.openLocalTerminalInWorkspace(DEFAULT_WORKSPACE_ID);
  platform.moveWorkspaceTab(DEFAULT_WORKSPACE_ID, terminal.id, 0);
  platform.setActiveWorkspaceTab(DEFAULT_WORKSPACE_ID, file.id);
  const first = render(<Panel />);
  await editor();
  first.unmount();
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  useCodeWorkspaceStore.setState({ byInstanceId: {} });
  platform.reloadFromStorage();
  expect(platform.getWorkspace()!.activeTabId).toBe(file.id);
  const { rerender } = render(<Panel visible={false} />);
  rerender(<Panel />);
  await editor();
  await waitFor(() => expect(screen.getByTestId("workspace-file-editor")).toHaveAttribute("data-path", "index.ts"));
  expect(platform.getWorkspace()!.activeTabId).toBe(file.id);
  expect(platform.getWorkspace()!.openTabs.map((tab) => tab.id)).toEqual([terminal.id, file.id]);
});

it("keeps a recovered draft readable when its file cannot be reopened and prevents unsafe saving", async () => {
  const first = render(<Panel />);
  const view = await editor();
  act(() => view.dispatch({ userEvent: "input.type", changes: { from: 0, insert: "// retained recovery\n" } }));
  await waitFor(() => expect(screen.getByTestId("workspace-file-editor")).toHaveAttribute("data-dirty", "true"));
  first.unmount();
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  useWorkspaceEditorStore.setState({ documents: readWorkspaceDocumentRecovery(), activeTabId: null });
  vi.mocked(readWorkspaceText).mockImplementation(async (_root, path) => {
    if (path === "index.ts") throw new Error("file no longer exists");
    return { path, text: "", hash: "h1", size: 0, mtime: 0, encoding: "utf-8", bom: false };
  });
  render(<Panel />);
  await waitFor(() => expect(screen.getByTestId("workspace-editor-error")).toHaveTextContent("file no longer exists"));
  expect((await editor()).state.doc.toString()).toContain("// retained recovery");
  expect(screen.getByTestId("workspace-editor-save")).toBeDisabled();
  fireEvent.keyDown(screen.getByTestId("workspace-file-editor"), { ctrlKey: true, key: "s" });
  expect(writeWorkspaceText).not.toHaveBeenCalled();
});

async function editor() {
  let view: EditorView | null = null;
  await waitFor(() => {
    const element = document.querySelector(".cm-editor");
    expect(element).toBeTruthy();
    view = EditorView.findFromDOM(element as HTMLElement);
    expect(view?.state.doc.length).toBeGreaterThan(0);
  });
  return view! as EditorView;
}

it("loads under StrictMode and retains the same editor, unsaved text and undo across workspace/mode switches", async () => {
  const { rerender } = render(<StrictMode><Panel /></StrictMode>);
  const view = await editor();
  expect(view.state.doc.toString()).toBe("const original = 1;\n");
  act(() => view.dispatch({ userEvent: "input.type", changes: { from: view.state.doc.length, insert: "// unsaved\n" } }));
  await waitFor(() => expect(screen.getByTestId("workspace-file-editor")).toHaveAttribute("data-dirty", "true"));
  let secondId = "";
  act(() => { secondId = useWorkspacePlatformStore.getState().createWorkspace({ name: "Second" }).id; });
  expect(useWorkspacePlatformStore.getState().activeWorkspaceId).toBe(secondId);
  expect(screen.getByTestId("workspace-file-editor")).not.toBeVisible();
  rerender(<StrictMode><Panel visible={false} /></StrictMode>);
  act(() => useWorkspacePlatformStore.getState().setActiveWorkspace(DEFAULT_WORKSPACE_ID));
  rerender(<StrictMode><Panel /></StrictMode>);
  expect(await editor()).toBe(view);
  expect(view.state.doc.toString()).toContain("// unsaved");
  const reads = vi.mocked(readWorkspaceText).mock.calls.length;
  await act(async () => {
    const outcome = await activeCommands().executeAction("workspace.undo");
    expect(outcome.kind, JSON.stringify(outcome)).toBe("applied");
  });
  await waitFor(() => expect(view.state.doc.toString()).toBe("const original = 1;\n"));
  await waitFor(() => expect(screen.getByTestId("workspace-file-editor")).not.toHaveAttribute("data-dirty"));
  expect(vi.mocked(readWorkspaceText)).toHaveBeenCalledTimes(reads);
});

it("keeps edits made while a save is pending dirty and saves them on the next request", async () => {
  let finishSave: (value: Awaited<ReturnType<typeof writeWorkspaceText>>) => void = () => {};
  vi.mocked(writeWorkspaceText).mockImplementationOnce(() => new Promise((resolve) => { finishSave = resolve; }));
  render(<Panel />);
  const view = await editor();
  act(() => view.dispatch({ userEvent: "input.type", changes: { from: view.state.doc.length, insert: "// first\n" } }));
  await waitFor(() => expect(screen.getByTestId("workspace-editor-save")).not.toBeDisabled());
  fireEvent.click(screen.getByTestId("workspace-editor-save"));
  await waitFor(() => expect(writeWorkspaceText).toHaveBeenCalledTimes(1));
  act(() => view.dispatch({ userEvent: "input.type", changes: { from: view.state.doc.length, insert: "// second\n" } }));
  await act(async () => finishSave({ hash: "h2" } as Awaited<ReturnType<typeof writeWorkspaceText>>));
  await waitFor(() => expect(screen.getByTestId("workspace-file-editor")).toHaveAttribute("data-dirty", "true"));
  fireEvent.click(screen.getByTestId("workspace-editor-save"));
  await waitFor(() => expect(screen.getByTestId("workspace-file-editor")).not.toHaveAttribute("data-dirty"));
  expect(vi.mocked(writeWorkspaceText).mock.calls[1][2]).toContain("// second");
  expect(vi.mocked(writeWorkspaceText).mock.calls[1][3]).toBe("h2");
});


it("retains both editors and undo while changing split/grid/single layouts", async () => {
  render(<Panel />);
  const firstView = await editor();
  act(() => firstView.dispatch({ userEvent: "input.type", changes: { from: 0, insert: "// unsaved split\n" } }));
  const store = useWorkspacePlatformStore.getState();
  const root = store.workspaces[0].rootFolders[0];
  act(() => store.openFileInWorkspace(DEFAULT_WORKSPACE_ID, { rootId: root.id, path: "second.ts" }));
  // Single view reuses the editor; split/grid render the two retained buffers.
  await waitFor(() => expect(useWorkspaceEditorStore.getState().documents[`ws:${DEFAULT_WORKSPACE_ID}:file:${root.id}:second.ts`]?.loading).toBe(false));
  for (const layout of ["split", "grid"] as const) {
    act(() => useWorkspaceUiStore.getState().setCanvasLayout(DEFAULT_WORKSPACE_ID, layout));
    await waitFor(() => expect(document.querySelectorAll(".cm-editor")).toHaveLength(2));
    expect(document.body.textContent).toContain("// unsaved split");
  }
  act(() => useWorkspaceUiStore.getState().setCanvasLayout(DEFAULT_WORKSPACE_ID, "single"));
  await waitFor(() => expect(document.querySelectorAll(".cm-editor")).toHaveLength(1));
  const first = useWorkspacePlatformStore.getState().getWorkspace(DEFAULT_WORKSPACE_ID)!.openTabs.find((tab) => tab.filePath === "index.ts")!;
  act(() => store.setActiveWorkspaceTab(DEFAULT_WORKSPACE_ID, first.id));
  await waitFor(() => expect(document.querySelector(".cm-content")?.textContent).toContain("// unsaved split"));
  const returned = await editor();
  act(() => returned.focus());
  await act(async () => { expect((await activeCommands().executeAction("workspace.undo")).kind).toBe("applied"); });
  await waitFor(() => expect(returned.state.doc.toString()).toBe("const original = 1;\n"));
  expect(vi.mocked(readWorkspaceText).mock.calls.filter(([, path]) => path.endsWith(".ts"))).toHaveLength(2);
});

it("retains the source editor and all open files when the IDE splits the active buffer", async () => {
  render(<Panel />);
  const initial = await editor();
  act(() => useWorkspacePlatformStore.getState().openCodeWorkspaceTab(DEFAULT_WORKSPACE_ID));
  act(() => initial.focus());
  await act(async () => { await activeCommands().executeAction("workspace.splitRight"); });
  await waitFor(() => expect(document.querySelectorAll(".cm-content")).toHaveLength(2));
  const ui = useCodeWorkspaceStore.getState().getInstance("platform:default-workspace");
  expect(Object.values(ui.editorGroups).filter((group) => group.openOrder.length)).toHaveLength(2);
  expect(Object.values(ui.editorGroups).filter((group) => group.openOrder.length).every((group) => !!group.activeKey)).toBe(true);
  const views = Array.from(document.querySelectorAll(".cm-editor")).map((element) => EditorView.findFromDOM(element as HTMLElement)!);
  act(() => views[1].dispatch({ userEvent: "input.type", changes: { from: 0, insert: "// shared edit\n" } }));
  await waitFor(() => expect(views[0].state.doc.toString()).toContain("// shared edit"));
  const platform = useWorkspacePlatformStore.getState();
  const workspace = platform.getWorkspace()!;
  act(() => platform.openFileInWorkspace(workspace.id, { rootId: workspace.rootFolders[0].id, path: "second.ts" }));
  await waitFor(() => expect(platform.getWorkspace()!.openTabs.filter((tab) => tab.kind === "file")).toHaveLength(2));
  const sourceTab = platform.getWorkspace()!.openTabs.find((tab) => tab.filePath === "index.ts")!;
  act(() => platform.setActiveWorkspaceTab(workspace.id, sourceTab.id));
  await waitFor(() => expect(document.querySelectorAll(".cm-content")).toHaveLength(2));
  expect(platform.getWorkspace()!.openTabs.filter((tab) => tab.kind === "file")).toHaveLength(2);
});

it("does not reopen a closed editor from active-file metadata published during a transaction", async () => {
  render(<Panel />);
  await editor();
  const platform = useWorkspacePlatformStore.getState();
  act(() => platform.openCodeWorkspaceTab(DEFAULT_WORKSPACE_ID));
  await act(async () => { await activeCommands().executeAction("workspace.closeActiveEditorTab"); });
  await waitFor(() => expect(platform.getWorkspace()!.openTabs.filter((tab) => tab.kind === "file")).toHaveLength(0));
  const current = platform.getWorkspace()!;
  act(() => platform.updateCodeWorkspace(current.id, {
    repoRoot: current.rootFolders[0].path,
    roots: current.rootFolders.map((root) => ({ ...root, kind: "folder" as const })),
    initialFile: { kind: "root", rootId: current.rootFolders[0].id, path: "index.ts" },
  }));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  expect(platform.getWorkspace()!.openTabs.filter((tab) => tab.kind === "file")).toHaveLength(0);
  expect(document.querySelector(".cm-content")).toBeNull();
});

it("keeps a newly mounted owner when an old component's deferred teardown runs", async () => {
  const first = render(<Panel />);
  const initial = await editor();
  act(() => initial.dispatch({ userEvent: "input.type", changes: { from: 0, insert: "// adopted\n" } }));
  await waitFor(() => expect(screen.getByTestId("workspace-file-editor")).toHaveAttribute("data-dirty", "true"));
  first.unmount();
  render(<Panel />);
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  expect((await editor()).state.doc.toString()).toContain("// adopted");
  expect(useCodeWorkspaceStore.getState().getInstance("platform:default-workspace").openOrder).toHaveLength(1);
  expect(screen.getByTestId("workspace-file-editor")).toHaveAttribute("data-dirty", "true");
});
