import { StrictMode, useEffect } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useWorkspaceUiStore } from "../../../stores/workspaceUiStore";
import { EditorView } from "@codemirror/view";
import { undo } from "@codemirror/commands";
import { WorkspaceMainPanel } from "../WorkspaceMainPanel";
import { useWorkspacePlatformStore, DEFAULT_WORKSPACE_ID } from "../../../stores/workspacePlatformStore";
import { useWorkspaceEditorStore } from "../../../stores/workspaceEditorStore";
import { readWorkspaceText, writeWorkspaceText } from "../workspaceFs";

vi.mock("../workspaceFs", () => ({
  readWorkspaceText: vi.fn(async () => ({ text: "const original = 1;\n", hash: "h1" })),
  writeWorkspaceText: vi.fn(async () => ({ hash: "h2" })),
}));
vi.mock("../../editor/CodeWorkspaceTab", () => ({ CodeWorkspaceTab: () => null }));
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

beforeEach(() => {
  localStorage.clear();
  useWorkspaceUiStore.setState({ canvasLayouts: {} });
  vi.clearAllMocks();
  useWorkspacePlatformStore.getState().reloadFromStorage();
  useWorkspaceEditorStore.setState({ documents: {}, activeTabId: null });
  const store = useWorkspacePlatformStore.getState();
  store.addRootFolder(DEFAULT_WORKSPACE_ID, { path: "/preview" });
  const root = useWorkspacePlatformStore.getState().workspaces[0].rootFolders[0];
  store.openFileInWorkspace(DEFAULT_WORKSPACE_ID, { rootId: root.id, path: "index.ts" });
});
afterEach(cleanup);

it("starts only visited workspaces and retains their session owners while hidden", () => {
  const store = useWorkspacePlatformStore.getState();
  const first = store.openLocalTerminalInWorkspace(DEFAULT_WORKSPACE_ID);
  const secondWorkspace = store.createWorkspace({ name: "Second" });
  const second = store.openLocalTerminalInWorkspace(secondWorkspace.id);
  store.setActiveWorkspace(DEFAULT_WORKSPACE_ID);
  const { rerender } = render(<WorkspaceMainPanel visible={false} />);
  expect(runtime.mounted).not.toHaveBeenCalled();
  rerender(<WorkspaceMainPanel />);
  expect(runtime.mounted).toHaveBeenCalledTimes(1);
  expect(runtime.mounted).toHaveBeenCalledWith(first.id);
  act(() => store.setActiveWorkspace(secondWorkspace.id));
  expect(runtime.mounted).toHaveBeenCalledTimes(2);
  expect(runtime.mounted).toHaveBeenLastCalledWith(second.id);
  rerender(<WorkspaceMainPanel visible={false} />);
  expect(runtime.released).not.toHaveBeenCalled();
});

async function editor() {
  await waitFor(() => expect(document.querySelector(".cm-editor")).toBeTruthy());
  return EditorView.findFromDOM(document.querySelector(".cm-editor") as HTMLElement)!;
}

it("loads under StrictMode and retains the same editor, unsaved text and undo across workspace/mode switches", async () => {
  const { rerender } = render(<StrictMode><WorkspaceMainPanel /></StrictMode>);
  const view = await editor();
  expect(view.state.doc.toString()).toBe("const original = 1;\n");
  act(() => view.dispatch({ changes: { from: view.state.doc.length, insert: "// unsaved\n" } }));
  expect(screen.getByTestId("workspace-file-editor")).toHaveAttribute("data-dirty", "true");
  let secondId = "";
  act(() => { secondId = useWorkspacePlatformStore.getState().createWorkspace({ name: "Second" }).id; });
  expect(useWorkspacePlatformStore.getState().activeWorkspaceId).toBe(secondId);
  expect(screen.getByTestId("workspace-file-editor")).not.toBeVisible();
  rerender(<StrictMode><WorkspaceMainPanel visible={false} /></StrictMode>);
  act(() => useWorkspacePlatformStore.getState().setActiveWorkspace(DEFAULT_WORKSPACE_ID));
  rerender(<StrictMode><WorkspaceMainPanel /></StrictMode>);
  expect(await editor()).toBe(view);
  expect(view.state.doc.toString()).toContain("// unsaved");
  const reads = vi.mocked(readWorkspaceText).mock.calls.length;
  act(() => undo(view));
  expect(view.state.doc.toString()).toBe("const original = 1;\n");
  expect(screen.getByTestId("workspace-file-editor")).not.toHaveAttribute("data-dirty");
  expect(vi.mocked(readWorkspaceText)).toHaveBeenCalledTimes(reads);
});

it("keeps edits made while a save is pending dirty and saves them on the next request", async () => {
  let finishSave: (value: Awaited<ReturnType<typeof writeWorkspaceText>>) => void = () => {};
  vi.mocked(writeWorkspaceText).mockImplementationOnce(() => new Promise((resolve) => { finishSave = resolve; }));
  render(<WorkspaceMainPanel />);
  const view = await editor();
  act(() => view.dispatch({ changes: { from: view.state.doc.length, insert: "// first\n" } }));
  fireEvent.click(screen.getByTestId("workspace-editor-save"));
  act(() => view.dispatch({ changes: { from: view.state.doc.length, insert: "// second\n" } }));
  await act(async () => finishSave({ hash: "h2" } as Awaited<ReturnType<typeof writeWorkspaceText>>));
  expect(screen.getByTestId("workspace-file-editor")).toHaveAttribute("data-dirty", "true");
  fireEvent.click(screen.getByTestId("workspace-editor-save"));
  await waitFor(() => expect(screen.getByTestId("workspace-file-editor")).not.toHaveAttribute("data-dirty"));
  expect(vi.mocked(writeWorkspaceText).mock.calls[1][2]).toContain("// second");
  expect(vi.mocked(writeWorkspaceText).mock.calls[1][3]).toBe("h2");
});


it("retains both editors and undo while changing split/grid/single layouts", async () => {
  render(<WorkspaceMainPanel />);
  const firstView = await editor();
  act(() => firstView.dispatch({ changes: { from: 0, insert: "// unsaved split\n" } }));
  const store = useWorkspacePlatformStore.getState();
  const root = store.workspaces[0].rootFolders[0];
  act(() => store.openFileInWorkspace(DEFAULT_WORKSPACE_ID, { rootId: root.id, path: "second.ts" }));
  await waitFor(() => expect(document.querySelectorAll(".cm-editor")).toHaveLength(2));
  for (const layout of ["split", "grid"] as const) {
    act(() => useWorkspaceUiStore.getState().setCanvasLayout(DEFAULT_WORKSPACE_ID, layout));
    expect(screen.getAllByTestId("workspace-canvas-pane").filter((pane) => pane.style.display !== "none")).toHaveLength(2);
    expect(EditorView.findFromDOM(document.querySelector(".cm-editor") as HTMLElement)).toBe(firstView);
    expect(firstView.state.doc.toString()).toContain("// unsaved split");
  }
  act(() => useWorkspaceUiStore.getState().setCanvasLayout(DEFAULT_WORKSPACE_ID, "single"));
  expect(screen.getAllByTestId("workspace-canvas-pane").filter((pane) => pane.style.display !== "none")).toHaveLength(1);
  act(() => store.setActiveWorkspaceTab(DEFAULT_WORKSPACE_ID, store.workspaces[0].openTabs[0].id));
  expect(screen.getAllByTestId("workspace-file-editor")[0]).toBeVisible();
  act(() => undo(firstView));
  expect(firstView.state.doc.toString()).toBe("const original = 1;\n");
  expect(vi.mocked(readWorkspaceText)).toHaveBeenCalledTimes(2);
});
