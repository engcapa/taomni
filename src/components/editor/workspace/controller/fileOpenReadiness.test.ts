import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { selectCodeWorkspaceUi, useCodeWorkspaceStore } from "../../../../stores/codeWorkspaceStore";
import { type CodeWorkspaceFileRef } from "../../../../types";
import { fileKey, type OpenFileState } from "../codeWorkspaceModel";
import { DEFAULT_WORKSPACE_TAB_POLICY_V3 } from "../workspaceTabPolicy";
import { createOpenFile, type OpenFileContext } from "./fileActions";

const fs = vi.hoisted(() => ({ workspaceReadFile: vi.fn(), workspaceReadLooseFile: vi.fn() }));
vi.mock("../../../../lib/editor/workspace", () => fs);
const root = { id: "root", name: "repo", path: "/repo", kind: "folder" as const };
const ref = (path: string): CodeWorkspaceFileRef => ({ kind: "root", rootId: root.id, path });
const diskFile = (path: string) => ({ path, text: `Public ${path}`, size: 20, hash: path, mtime: 1 });
const ui = () => selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "readiness");

beforeEach(() => {
  vi.useFakeTimers();
  useCodeWorkspaceStore.setState({ byInstanceId: {} });
  useCodeWorkspaceStore.getState().ensureInstance("readiness");
  fs.workspaceReadFile.mockReset();
});
afterEach(() => vi.useRealTimers());

function harness() {
  const snapshots: Array<{ active: string | null; loading: boolean | undefined }> = [];
  const unsubscribe = useCodeWorkspaceStore.subscribe(() => {
    const current = ui();
    snapshots.push({ active: current.activeKey, loading: current.openFiles[current.activeKey ?? ""]?.loading });
  });
  const store = useCodeWorkspaceStore.getState();
  const context: OpenFileContext = {
    workspaceInstanceId: "readiness", flushPendingEditorText: vi.fn(),
    pendingClosedFilesRef: { current: new Map() },
    updateEditorGroup: (id, update) => store.updateEditorGroup("readiness", id, update),
    tabPolicyRef: { current: DEFAULT_WORKSPACE_TAB_POLICY_V3 },
    activateEditorGroup: (id) => store.setActiveEditorGroup("readiness", id),
    openFilesRef: { get current() { return ui().openFiles; }, set current(_value) {} },
    mruFileKeysRef: { current: [] }, closeFileRef: { current: null },
    setStatusMessage: vi.fn(), syncLspDocument: vi.fn(async () => {}), libraryBuffersRef: { current: {} },
    setOpenFiles: (update) => store.updateOpenFiles("readiness", update),
    lspDescriptorForPath: vi.fn(), rootsRef: { current: [root] }, looseFilesRef: { current: [] },
    findRoot: () => root, restoreBookmarksForFileKey: vi.fn(),
  };
  const open = createOpenFile(context);
  const finish = async () => { await vi.advanceTimersByTimeAsync(0); };
  return { open, context, snapshots, unsubscribe, finish };
}

it("publishes a fast read with ready content before activation and never exposes an empty/loading editor", async () => {
  fs.workspaceReadFile.mockResolvedValue(diskFile("page.html"));
  const h = harness();
  expect(await h.open(ref("page.html"))).toEqual({ canonicalFileKey: fileKey(ref("page.html")), groupId: "primary", error: null });
  h.unsubscribe();
  expect(h.snapshots.filter((item) => item.active)).toEqual([{ active: fileKey(ref("page.html")), loading: false }]);
  expect(ui().openFiles[fileKey(ref("page.html"))].text).toBe("Public page.html");
  expect(h.context.syncLspDocument).not.toHaveBeenCalled();
});

it("shows loading only for a slow read and replaces it with the actual file", async () => {
  let resolve!: (value: ReturnType<typeof diskFile>) => void;
  fs.workspaceReadFile.mockReturnValue(new Promise((reply) => { resolve = reply; }));
  const h = harness();
  const opened = h.open(ref("slow.txt"));
  await vi.advanceTimersByTimeAsync(79);
  expect(ui().activeKey).toBeNull();
  await vi.advanceTimersByTimeAsync(1);
  const key = fileKey(ref("slow.txt"));
  expect(ui().activeKey).toBe(key);
  expect(ui().openFiles[key].loading).toBe(true);
  resolve(diskFile("slow.txt"));
  await opened;
  h.unsubscribe();
  expect(ui().openFiles[key].loading).toBe(false);
  expect(ui().openFiles[key].text).toBe("Public slow.txt");
});

it("keeps the latest selection when an earlier fast or slow read completes last", async () => {
  for (const slow of [false, true]) {
    const h = harness();
    let resolve!: (value: ReturnType<typeof diskFile>) => void;
    fs.workspaceReadFile.mockReturnValueOnce(new Promise((reply) => { resolve = reply; }));
    const first = h.open(ref(`first-${slow}.txt`));
    if (slow) await vi.advanceTimersByTimeAsync(80);
    fs.workspaceReadFile.mockResolvedValueOnce(diskFile(`second-${slow}.txt`));
    await h.open(ref(`second-${slow}.txt`));
    resolve(diskFile(`first-${slow}.txt`));
    expect(await first).toEqual(expect.objectContaining({ activated: false }));
    h.unsubscribe();
    expect(ui().activeKey).toBe(fileKey(ref(`second-${slow}.txt`)));
    expect(ui().openFiles[fileKey(ref(`first-${slow}.txt`))].text).toBe(`Public first-${slow}.txt`);
  }
});

it("ignores a cancelled read without inserting a tab or publishing delayed loading state", async () => {
  fs.workspaceReadFile.mockReturnValue(new Promise(() => {}));
  const h = harness();
  let current = true;
  const result = h.open(ref("cancelled.txt"), { isCurrent: () => current });
  current = false;
  await vi.advanceTimersByTimeAsync(100);
  expect(await result).toBeNull();
  h.unsubscribe();
  expect(ui().openOrder).toEqual([]);
  expect(ui().openFiles).toEqual({});
});

it("surfaces a failed read as a retryable file error and cancels its loading timer", async () => {
  fs.workspaceReadFile.mockRejectedValue(new Error("read denied"));
  const h = harness();
  const result = await h.open(ref("denied.txt"));
  await vi.advanceTimersByTimeAsync(100);
  h.unsubscribe();
  expect(result?.error).toBe("read denied");
  expect(ui().openFiles[fileKey(ref("denied.txt"))]).toEqual(expect.objectContaining({ loading: false, error: "read denied" }));
});

it("activates a ready dirty buffer immediately without rereading or discarding its unsaved text", async () => {
  const h = harness();
  const key = fileKey(ref("dirty.txt"));
  const buffer = { key, dirty: true, loading: false, text: "draft", error: null } as OpenFileState;
  h.context.setOpenFiles({ [key]: buffer });
  const result = h.open(ref("dirty.txt"));
  expect(ui().activeKey).toBe(key);
  await result;
  h.unsubscribe();
  expect(ui().openFiles[key]).toBe(buffer);
  expect(fs.workspaceReadFile).not.toHaveBeenCalled();
});
