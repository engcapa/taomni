import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useCodeWorkspaceStore } from "../../../../stores/codeWorkspaceStore";
import { useWorkspaceTreeOpening, type UseWorkspaceTreeOpeningContext } from "./useWorkspaceTreeOpening";
import { useWorkspaceTreeFocusState } from "./useWorkspaceTreeFocusState";

const workspaceInstanceId = "deferred-tree-focus";
const frames = new Map<number, FrameRequestCallback>();
let nextFrame = 0;

beforeEach(() => {
  frames.clear();
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => { frames.delete(id); });
  useCodeWorkspaceStore.getState().ensureInstance(workspaceInstanceId);
});
afterEach(() => {
  cleanup();
  useCodeWorkspaceStore.getState().disposeInstance(workspaceInstanceId);
  vi.unstubAllGlobals();
});

function flushFrames() {
  act(() => {
    const pending = [...frames.values()];
    frames.clear();
    for (const frame of pending) frame(performance.now());
  });
}

function setup() {
  const focus = vi.fn(() => true);
  let mounted = true;
  const editorCommands = {
    editorCommandOwnerFor: vi.fn((_group: string, fileKey: string) => mounted ? { fileKey, port: { focus } } : null),
  } as unknown as UseWorkspaceTreeOpeningContext["editorCommands"];
  const buffers = { flushPendingEditorText: vi.fn() } as unknown as UseWorkspaceTreeOpeningContext["buffers"];
  const rendered = renderHook(() => {
    const treeFocus = useWorkspaceTreeFocusState({});
    const opening = useWorkspaceTreeOpening({
      workspaceInstanceId, treeFocus, editorCommands, buffers,
      splitLayoutLeaf: useCodeWorkspaceStore.getState().splitLayoutLeaf,
      openFile: async (ref) => {
        useCodeWorkspaceStore.getState().setActiveKey(workspaceInstanceId, ref.path);
        return { canonicalFileKey: ref.path, groupId: "primary", error: null };
      },
    });
    return { ...opening, treeFocus };
  });
  const open = async (path = "a.txt") => {
    await act(async () => { await rendered.result.current.requestTreeOpen({ kind: "root", rootId: "root", path }); });
  };
  return { ...rendered, focus, open, setMounted: (value: boolean) => { mounted = value; } };
}

it("waits for the editor measurement frame and grants a matching document focus once", async () => {
  const { result, open, focus } = setup();
  await open();
  const intent = result.current.treeFocus.pendingTreeOpenIntentRef.current!;
  act(() => { result.current.treeFocus.tryGrantTreeFocusRef.current(intent, "a.txt"); });
  expect(focus).not.toHaveBeenCalled();
  expect(frames.size).toBe(1);
  flushFrames();
  expect(focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
  expect(result.current.treeFocus.pendingTreeOpenIntentRef.current).toBeNull();
});

it.each(["input", "interaction", "file", "group"])("does not steal focus after the user changes %s", async (change) => {
  const { result, open, focus } = setup();
  await open();
  let input: HTMLInputElement | null = null;
  act(() => {
    if (change === "input") {
      input = document.createElement("input");
      document.body.appendChild(input);
      input.focus();
    } else if (change === "interaction") result.current.treeFocus.treeInteractionEpochRef.current += 1;
    else if (change === "file") useCodeWorkspaceStore.getState().setActiveKey(workspaceInstanceId, "b.txt");
    else useCodeWorkspaceStore.getState().setActiveEditorGroup(workspaceInstanceId, "secondary");
  });
  try {
    flushFrames();
    expect(focus).not.toHaveBeenCalled();
    if (input) expect(input).toHaveFocus();
  } finally {
    (input as HTMLInputElement | null)?.remove();
  }
});

it("supersedes an earlier document before its frame runs", async () => {
  const { result, open, focus } = setup();
  await open("a.txt");
  const first = result.current.treeFocus.pendingTreeOpenIntentRef.current!;
  await open("b.txt");
  act(() => { result.current.treeFocus.tryGrantTreeFocusRef.current(first, "a.txt"); });
  expect(frames.size).toBe(1);
  flushFrames();
  expect(focus).toHaveBeenCalledOnce();
  expect(result.current.treeFocus.pendingTreeOpenIntentRef.current).toBeNull();
});

it("retains the intent when the port is not mounted and retries its registration", async () => {
  const { result, open, focus, setMounted } = setup();
  setMounted(false);
  await open();
  flushFrames();
  const intent = result.current.treeFocus.pendingTreeOpenIntentRef.current!;
  expect(intent).not.toBeNull();
  expect(focus).not.toHaveBeenCalled();
  setMounted(true);
  act(() => { result.current.treeFocus.tryGrantTreeFocusRef.current(intent, "a.txt"); });
  flushFrames();
  expect(focus).toHaveBeenCalledOnce();
});

it("cancels a queued focus transfer when the workspace unmounts", async () => {
  const { open, focus, unmount } = setup();
  await open();
  unmount();
  expect(frames.size).toBe(0);
  flushFrames();
  expect(focus).not.toHaveBeenCalled();
});
