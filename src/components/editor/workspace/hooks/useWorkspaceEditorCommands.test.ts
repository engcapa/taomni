import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useCodeWorkspaceStore } from "../../../../stores/codeWorkspaceStore";
import type { EditorCommandPort } from "../host/types";
import { useWorkspaceEditorCommands, type UseWorkspaceEditorCommandsContext } from "./useWorkspaceEditorCommands";

const workspaceInstanceId = "command-routing-contract";
const state = {
  composing: false, readOnly: false, hasSelection: false, caretCount: 1,
  occurrenceSessionActive: false, completionActive: false
};
function port(): EditorCommandPort {
  return { execute: vi.fn(() => true), state: () => state, focus: vi.fn(() => true) };
}
function setup() {
  const dependencies: UseWorkspaceEditorCommandsContext = {
    workspaceInstanceId,
    pendingTreeOpenIntentRef: { current: null },
    tryGrantTreeFocusRef: { current: vi.fn(() => true) },
    openFilesRef: { current: {} },
    editorSelectionRef: {
      current: {
        start: { line: 1, character: 0 }, end: { line: 1, character: 2 },
        empty: false, text: "ab", rect: null
      }
    },
  };
  return { ...renderHook(() => useWorkspaceEditorCommands(dependencies)), dependencies };
}
beforeEach(() => {
  const store = useCodeWorkspaceStore.getState();
  store.ensureInstance(workspaceInstanceId);
  store.updateEditorGroup(workspaceInstanceId, "primary", group => ({ ...group, activeKey: "a" }));
  store.updateEditorGroup(workspaceInstanceId, "secondary", group => ({ ...group, activeKey: "b" }));
});
afterEach(() => { cleanup(); useCodeWorkspaceStore.getState().disposeInstance(workspaceInstanceId); });

describe("editor command ownership", () => {
  it("keeps a context-menu target pinned while keyboard commands follow the active leaf", () => {
    const { result } = setup();
    const a = port(), b = port();
    act(() => {
      result.current.registerEditorCommandPort("primary", { fileKey: "a", token: {}, port: a });
      result.current.registerEditorCommandPort("secondary", { fileKey: "b", token: {}, port: b });
      useCodeWorkspaceStore.getState().setActiveEditorGroup(workspaceInstanceId, "secondary");
    });
    const pinned = { focus: "editor" as const, payload: { groupId: "primary", fileKey: "a" } };
    expect(result.current.executeEditorCommand("cloneCaretAbove", pinned)).toBe(true);
    expect(a.execute).toHaveBeenCalledOnce();
    expect(b.execute).not.toHaveBeenCalled();
    expect(result.current.executeActiveEditorCommand("cloneCaretBelow")).toBe(true);
    expect(b.execute).toHaveBeenCalledOnce();
    expect(result.current.editorCommandStateFor(pinned)).toBe(state);
    result.current.handleReturnToEditor();
    expect(b.focus).toHaveBeenCalledWith({ preventScroll: true });
  });

  it("ignores stale unmount tokens and rejects a target after its file changes", () => {
    const { result } = setup();
    const first = {}, second = {}, current = port();
    act(() => {
      result.current.registerEditorCommandPort("primary", { fileKey: "a", token: first, port: port() });
      result.current.registerEditorCommandPort("primary", { fileKey: "a", token: second, port: current });
      result.current.registerEditorCommandPort("primary", { fileKey: "a", token: first, port: null });
    });
    expect(result.current.executeActiveEditorCommand("cloneCaretAbove")).toBe(true);
    act(() => result.current.registerEditorCommandPort("primary", { fileKey: "new", token: {}, port: port() }));
    expect(result.current.executeEditorCommandFor({ groupId: "primary", fileKey: "a" }, "cloneCaretAbove")).toBe(false);
    expect(result.current.activeEditorCommandState()).toBeNull();
    expect(current.execute).toHaveBeenCalledOnce();
  });

  it("grants pending tree focus only to the matching group and canonical file", () => {
    const { result, dependencies } = setup();
    dependencies.pendingTreeOpenIntentRef.current = {
      workspaceInstanceId, groupId: "primary", requestedFileKey: "alias",
      canonicalFileKey: "a", interactionEpoch: 1, requestId: 2
    };
    act(() => {
      result.current.registerEditorCommandPort("secondary", { fileKey: "a", token: {}, port: port() });
      result.current.registerEditorCommandPort("primary", { fileKey: "alias", token: {}, port: port() });
    });
    expect(dependencies.tryGrantTreeFocusRef.current).not.toHaveBeenCalled();
    act(() => result.current.registerEditorCommandPort("primary", { fileKey: "a", token: {}, port: port() }));
    expect(dependencies.tryGrantTreeFocusRef.current).toHaveBeenCalledWith(dependencies.pendingTreeOpenIntentRef.current, "a");
    // Reads the live selection for keyboard invocation, even without a context payload.
    expect(result.current.resolveEditorTarget().position).toEqual({ line: 1, character: 2 });
  });
});
