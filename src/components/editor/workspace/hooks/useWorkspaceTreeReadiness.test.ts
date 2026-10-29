import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { selectCodeWorkspaceUi, useCodeWorkspaceStore } from "../../../../stores/codeWorkspaceStore";
import { type CodeWorkspaceFileRef } from "../../../../types";
import { fileKey } from "../codeWorkspaceModel";
import { createOpenFile, type OpenFileContext } from "../controller/fileActions";
import { DEFAULT_WORKSPACE_TAB_POLICY_V3 } from "../workspaceTabPolicy";
import { useWorkspaceTreeFocusState } from "./useWorkspaceTreeFocusState";
import { useWorkspaceTreeOpening, type UseWorkspaceTreeOpeningContext } from "./useWorkspaceTreeOpening";

const fs = vi.hoisted(() => ({ workspaceReadFile: vi.fn() }));
vi.mock("../../../../lib/editor/workspace", () => fs);
const workspaceInstanceId = "tree-readiness";
const root = { id: "root", name: "repo", path: "/repo", kind: "folder" as const };
const ref: CodeWorkspaceFileRef = { kind: "root", rootId: root.id, path: "slow.txt" };
const key = fileKey(ref);
const ui = () => selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), workspaceInstanceId);
const frames = new Map<number, FrameRequestCallback>();

beforeEach(() => {
  vi.useFakeTimers();
  frames.clear();
  let frameId = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++frameId, callback);
    return frameId;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  useCodeWorkspaceStore.getState().ensureInstance(workspaceInstanceId);
  fs.workspaceReadFile.mockReset();
});

afterEach(() => {
  cleanup();
  useCodeWorkspaceStore.getState().disposeInstance(workspaceInstanceId);
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function flushFrames() {
  act(() => {
    const pending = [...frames.values()];
    frames.clear();
    pending.forEach((callback) => callback(performance.now()));
  });
}

function harness() {
  let resolve!: (value: object) => void;
  fs.workspaceReadFile.mockReturnValue(new Promise((reply) => { resolve = reply; }));
  const store = useCodeWorkspaceStore.getState();
  const context: OpenFileContext = {
    workspaceInstanceId, flushPendingEditorText: vi.fn(),
    pendingClosedFilesRef: { current: new Map() },
    updateEditorGroup: (id, update) => store.updateEditorGroup(workspaceInstanceId, id, update),
    tabPolicyRef: { current: DEFAULT_WORKSPACE_TAB_POLICY_V3 },
    activateEditorGroup: (id) => store.setActiveEditorGroup(workspaceInstanceId, id),
    openFilesRef: { get current() { return ui().openFiles; }, set current(_value) {} },
    mruFileKeysRef: { current: [] }, closeFileRef: { current: null },
    setStatusMessage: vi.fn(), syncLspDocument: vi.fn(async () => {}), libraryBuffersRef: { current: {} },
    setOpenFiles: (update) => store.updateOpenFiles(workspaceInstanceId, update),
    lspDescriptorForPath: vi.fn(), rootsRef: { current: [root] }, looseFilesRef: { current: [] },
    findRoot: () => root, restoreBookmarksForFileKey: vi.fn(), onActivateFile: vi.fn(),
  };
  const openFile = createOpenFile(context);
  const focus = vi.fn(() => true);
  const rendered = renderHook(() => {
    const treeFocus = useWorkspaceTreeFocusState({});
    const opening = useWorkspaceTreeOpening({
      workspaceInstanceId, treeFocus, openFile,
      buffers: { flushPendingEditorText: context.flushPendingEditorText } as UseWorkspaceTreeOpeningContext["buffers"],
      editorCommands: {
        editorCommandOwnerFor: () => ({ fileKey: key, port: { focus } }),
      } as unknown as UseWorkspaceTreeOpeningContext["editorCommands"],
      splitLayoutLeaf: store.splitLayoutLeaf,
    });
    return { treeFocus, ...opening };
  });
  const begin = async () => {
    let pending!: Promise<void>;
    act(() => { pending = rendered.result.current.requestTreeOpen(ref); });
    await act(async () => { await vi.advanceTimersByTimeAsync(80); });
    expect(ui().openFiles[key]?.loading).toBe(true);
    const intent = rendered.result.current.treeFocus.pendingTreeOpenIntentRef.current!;
    // A real editor port can mount while the disk read is still outstanding.
    act(() => { rendered.result.current.treeFocus.tryGrantTreeFocusRef.current(intent, key); });
    return { pending };
  };
  const finish = async (pending: Promise<void>) => {
    await act(async () => {
      resolve({ path: ref.path, text: "Public slow text", size: 16, hash: "disk", mtime: 1 });
      await pending;
    });
    flushFrames();
  };
  return { ...rendered, begin, finish, focus, context };
}

it("never focuses a loading placeholder or discards its eventual disk contents", async () => {
  const h = harness();
  const { pending } = await h.begin();
  flushFrames();
  expect(h.focus).not.toHaveBeenCalled();
  await h.finish(pending);
  expect(ui().openFiles[key]).toMatchObject({ text: "Public slow text", loading: false, error: null });
  expect(h.context.onActivateFile).toHaveBeenCalledWith(ref);
  expect(h.focus).toHaveBeenCalledOnce();
});

it.each(["input", "tree navigation"])("completes the file read after %s relinquishes editor focus", async (change) => {
  const h = harness();
  const { pending } = await h.begin();
  const input = document.createElement("input");
  document.body.appendChild(input);
  try {
    act(() => {
      if (change === "input") input.focus();
      else {
        h.result.current.treeFocus.treeInteractionEpochRef.current += 1;
        h.result.current.treeFocus.pendingTreeOpenIntentRef.current = null;
      }
    });
    flushFrames();
    await h.finish(pending);
    expect(ui().openFiles[key]).toMatchObject({ text: "Public slow text", loading: false });
    expect(h.focus).not.toHaveBeenCalled();
    if (change === "input") expect(input).toHaveFocus();
  } finally {
    input.remove();
  }
});

it("does not publish a pending read after the workspace unmounts", async () => {
  const h = harness();
  const { pending } = await h.begin();
  h.unmount();
  await h.finish(pending);
  expect(ui().openFiles[key]?.text).toBe("");
  expect(h.context.onActivateFile).not.toHaveBeenCalled();
  expect(h.focus).not.toHaveBeenCalled();
});
