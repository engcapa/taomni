import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useCodeWorkspaceStore } from "../../../../stores/codeWorkspaceStore";
import type { EditorCommandPort, EditorCommandState } from "../CodeMirrorHost";
import { makeLoadingFile } from "../codeWorkspaceModel";
import { useWorkspaceActionsController } from "../useWorkspaceActionsController";
import type { WorkspaceCommand } from "../workspaceCommands";
import { useWorkspaceActionContext } from "./useWorkspaceActionContext";
import { useWorkspaceEditorCommands } from "./useWorkspaceEditorCommands";

const instanceId = "live-action-context";
const root = { id: "root", path: "/project", name: "project", kind: "folder" as const };
const state = (patch: Partial<EditorCommandState> = {}): EditorCommandState => ({
  composing: false, readOnly: false, hasSelection: true, caretCount: 1,
  occurrenceSessionActive: false, completionActive: false, ...patch,
});
const port = (read: () => EditorCommandState): EditorCommandPort => ({ state: read, execute: vi.fn(() => true) });

beforeEach(() => {
  useCodeWorkspaceStore.setState({ byInstanceId: {} });
  const store = useCodeWorkspaceStore.getState();
  store.ensureInstance(instanceId);
  store.updateOpenFiles(instanceId, Object.fromEntries(["a", "b"].map((name) => {
    const file = makeLoadingFile({ kind: "root", rootId: root.id, path: `${name}.txt` }, [root], []);
    return [name, { ...file, key: name, loading: false, text: name }];
  })));
  store.updateEditorGroup(instanceId, "primary", (group) => ({ ...group, openOrder: ["a", "b"], activeKey: "a" }));
});
afterEach(cleanup);

function renderOwner() {
  const run = vi.fn();
  const commands: WorkspaceCommand[] = [{
    id: "editor.selectionProbe", title: "Selection", category: "Edit",
    when: (context) => !!context.hasActiveFile && !!context.hasSelection && !context.readOnly && !context.editorComposing,
    run,
  }];
  const { result } = renderHook(() => {
    const editorCommands = useWorkspaceEditorCommands({
      workspaceInstanceId: instanceId,
      pendingTreeOpenIntentRef: { current: null }, tryGrantTreeFocusRef: { current: () => false },
      openFilesRef: { current: useCodeWorkspaceStore.getState().getInstance(instanceId).openFiles },
      editorSelectionRef: { current: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 }, empty: true, text: "", rect: null } },
    });
    const ui = useCodeWorkspaceStore.getState().getInstance(instanceId);
    const context = useWorkspaceActionContext({
      workspaceInstanceId: instanceId, activeKey: ui.activeKey, activeEditorGroupId: ui.activeEditorGroupId,
      activeFilePath: ui.openFiles[ui.activeKey ?? ""]?.path, modalOpen: false, editorCommands,
    });
    const controller = useWorkspaceActionsController({ commands, activeFocus: "editor", ...context });
    return { editorCommands, controller };
  });
  return { result, run };
}

it("dispatches to a newly registered editor before its menu notification renders", () => {
  const { result, run } = renderOwner();
  act(() => {
    result.current.editorCommands.registerEditorCommandPort("primary", { fileKey: "a", token: {}, port: port(() => state()) });
    expect(result.current.controller.executeCommand("editor.selectionProbe")).toBe(true);
  });
  expect(run).toHaveBeenCalledWith(expect.objectContaining({ activeFileKey: "a", activeFilePath: "a.txt", editorViewId: "primary" }));
});

it("rejects the old view after activation and keeps the replacement when an older cleanup arrives", () => {
  const { result, run } = renderOwner();
  const oldToken = {};
  act(() => result.current.editorCommands.registerEditorCommandPort("primary", { fileKey: "a", token: oldToken, port: port(() => state()) }));
  act(() => {
    useCodeWorkspaceStore.getState().setActiveKey(instanceId, "b");
    expect(result.current.controller.executeCommand("editor.selectionProbe")).toBe(false);
    result.current.editorCommands.registerEditorCommandPort("primary", { fileKey: "b", token: {}, port: port(() => state()) });
    result.current.editorCommands.registerEditorCommandPort("primary", { fileKey: "a", token: oldToken, port: null });
    expect(result.current.controller.executeCommand("editor.selectionProbe")).toBe(true);
  });
  expect(run).toHaveBeenCalledTimes(1);
  expect(run).toHaveBeenCalledWith(expect.objectContaining({ activeFileKey: "b", activeFilePath: "b.txt" }));
});

it("reads selection, read-only and composition changes without waiting for a React notification", () => {
  const { result, run } = renderOwner();
  let flags = state();
  act(() => result.current.editorCommands.registerEditorCommandPort("primary", { fileKey: "a", token: {}, port: port(() => flags) }));
  flags = state({ readOnly: true });
  expect(result.current.controller.executeCommand("editor.selectionProbe")).toBe(false);
  flags = state({ composing: true });
  expect(result.current.controller.executeCommand("editor.selectionProbe")).toBe(false);
  flags = state({ hasSelection: false });
  expect(result.current.controller.executeCommand("editor.selectionProbe")).toBe(false);
  flags = state({ caretCount: 2 });
  expect(result.current.controller.executeCommand("editor.selectionProbe")).toBe(true);
  expect(run).toHaveBeenCalledWith(expect.objectContaining({ editorCaretCount: 2 }));
});
