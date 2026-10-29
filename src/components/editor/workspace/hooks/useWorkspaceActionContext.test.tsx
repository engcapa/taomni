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

function renderOwner(onRender = () => {}) {
  const run = vi.fn();
  const commands: WorkspaceCommand[] = [{
    id: "editor.selectionProbe", title: "Selection", category: "Edit",
    when: (context) => !!context.hasActiveFile && !!context.hasSelection && !context.readOnly && !context.editorComposing,
    run,
  }];
  const { result } = renderHook(() => {
    onRender();
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

it("updates live command menus after paint without recomposing the editor owner", async () => {
  vi.useFakeTimers();
  const frames = new Map<number, FrameRequestCallback>();
  let frameId = 0;
  const request = vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    frames.set(++frameId, callback);
    return frameId;
  });
  const cancel = vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => { frames.delete(id); });
  const paint = () => act(() => {
    const callbacks = [...frames.values()];
    frames.clear();
    callbacks.forEach((callback) => callback(0));
  });
  try {
    const renders = vi.fn();
    const { result, run } = renderOwner(renders);
    expect(result.current.controller.snapshot[0].state.availability).toBe("disabled");
    const changed = vi.fn();
    const unsubscribe = result.current.controller.projection.subscribe(changed);
    let flags = state();
    renders.mockClear();
    act(() => {
      result.current.editorCommands.registerEditorCommandPort("primary", { fileKey: "a", token: {}, port: port(() => flags) });
      result.current.editorCommands.setEditorCommandContextRevision((revision) => revision + 1);
      expect(result.current.controller.executeCommand("editor.selectionProbe")).toBe(true);
    });
    await act(async () => {});
    expect(run).toHaveBeenCalledOnce();
    expect(renders).not.toHaveBeenCalled();
    paint();
    expect(renders).not.toHaveBeenCalled();
    paint();
    act(() => vi.advanceTimersByTime(0));
    expect(renders).not.toHaveBeenCalled();
    expect(changed).toHaveBeenCalledOnce();
    expect(result.current.controller.snapshot[0].state.availability).toBe("available");
    flags = state({ readOnly: true });
    act(() => result.current.editorCommands.setEditorCommandContextRevision((revision) => revision + 1));
    paint();
    paint();
    act(() => vi.advanceTimersByTime(0));
    expect(renders).not.toHaveBeenCalled();
    expect(result.current.controller.snapshot[0].state.availability).toBe("disabled");
    expect(changed).toHaveBeenCalledTimes(2);
    unsubscribe();
  } finally {
    cleanup();
    request.mockRestore();
    cancel.mockRestore();
    vi.useRealTimers();
  }
});

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

it("publishes live tree menus without rendering their owner and releases instance subscriptions", async () => {
  const renders = vi.fn();
  const run = vi.fn();
  const editorListeners = new Set<() => void>();
  const editorCommands = {
    activeEditorCommandState: () => null,
    subscribeEditorCommandContext: (listener: () => void) => {
      editorListeners.add(listener);
      return () => { editorListeners.delete(listener); };
    },
  };
  const commands: WorkspaceCommand[] = [{
    id: "tree.probe", title: "Tree selection", category: "File",
    when: () => !!useCodeWorkspaceStore.getState().getInstance(instanceId).treeSelection,
    run: () => { run(useCodeWorkspaceStore.getState().getInstance(instanceId).treeSelection); },
  }];
  const { result, unmount } = renderHook(() => {
    renders();
    const context = useWorkspaceActionContext({
      workspaceInstanceId: instanceId, activeKey: "a", activeEditorGroupId: "primary",
      modalOpen: false, editorCommands,
    });
    return useWorkspaceActionsController({ commands, activeFocus: "tree", ...context });
  });
  expect(editorListeners.size).toBe(1);
  expect(result.current.snapshot[0].state.availability).toBe("disabled");
  const changed = vi.fn();
  const unsubscribe = result.current.projection.subscribe(changed);
  renders.mockClear();
  const selection = { kind: "dir" as const, rootId: "root", path: "current" };
  await act(async () => {
    useCodeWorkspaceStore.getState().patchInstance(instanceId, { treeSelection: selection });
    expect(result.current.snapshot[0].state.availability).toBe("available");
    expect((await result.current.executeAction("tree.probe")).kind).toBe("applied");
  });
  expect(run).toHaveBeenCalledWith(selection);
  expect(result.current.snapshot[0].state.availability).toBe("available");
  expect(changed).toHaveBeenCalledOnce();
  act(() => {
    useCodeWorkspaceStore.getState().patchInstance("another-instance", { treeSelection: selection });
    useCodeWorkspaceStore.getState().patchInstance(instanceId, { treeFilter: "unrelated" });
  });
  expect(changed).toHaveBeenCalledOnce();
  act(() => useCodeWorkspaceStore.getState().patchInstance(instanceId, { treeSelection: null }));
  expect(result.current.executeCommand("tree.probe")).toBe(false);
  expect(result.current.snapshot[0].state.availability).toBe("disabled");
  expect(changed).toHaveBeenCalledTimes(2);
  expect(renders).not.toHaveBeenCalled();
  unmount();
  expect(editorListeners.size).toBe(0);
  changed.mockClear();
  act(() => useCodeWorkspaceStore.getState().patchInstance(instanceId, { treeSelection: selection }));
  expect(changed).not.toHaveBeenCalled();
  unsubscribe();
});
