import { beforeEach, expect, it, vi } from "vitest";
import { useCodeWorkspaceStore } from "../../../../stores/codeWorkspaceStore";
import { makeLoadingFile } from "../codeWorkspaceModel";
import { DEFAULT_WORKSPACE_TAB_POLICY_V3 } from "../workspaceTabPolicy";
import { WorkspaceResourceRecoveryCoordinator, type ResourceCleanupOutcome } from "../workspaceResourceRecoveryCoordinator";
import { createOpenFile, type OpenFileContext } from "./fileActions";
import type { PendingClosedFile } from "./model";

beforeEach(() => useCodeWorkspaceStore.setState({ byInstanceId: {} }));

function reopening() {
  const root = { id: "root", name: "repo", path: "/repo", kind: "folder" as const };
  const ref = { kind: "root" as const, rootId: root.id, path: "Main.java" };
  const file = { ...makeLoadingFile(ref, [root], []), loading: false, dirty: true,
    text: "class Main { int latest = 7; }", savedText: "class Main {}" };
  let finishCleanup!: (outcome: ResourceCleanupOutcome) => void;
  const pending: PendingClosedFile = {
    cleanup: new Promise((resolve) => { finishCleanup = resolve; }), didCloseCompleted: false,
  };
  let finishProvider!: () => void;
  let failProvider!: (reason: Error) => void;
  const provider = new Promise<void>((resolve, reject) => { finishProvider = resolve; failProvider = reject; });
  const syncLspDocument = vi.fn(() => provider);
  const setStatusMessage = vi.fn();
  const store = useCodeWorkspaceStore.getState();
  store.ensureInstance("reopen");
  const context: OpenFileContext = {
    workspaceInstanceId: "reopen", flushPendingEditorText: vi.fn(),
    pendingClosedFilesRef: { current: new Map([[file.key, pending]]) },
    updateEditorGroup: (id, update) => store.updateEditorGroup("reopen", id, update),
    tabPolicyRef: { current: DEFAULT_WORKSPACE_TAB_POLICY_V3 },
    activateEditorGroup: (id) => store.setActiveEditorGroup("reopen", id),
    openFilesRef: { current: { [file.key]: file } }, mruFileKeysRef: { current: [file.key] },
    closeFileRef: { current: null }, setStatusMessage, syncLspDocument,
    libraryBuffersRef: { current: {} }, setOpenFiles: vi.fn(),
    lspDescriptorForPath: vi.fn(), rootsRef: { current: [root] }, looseFilesRef: { current: [] },
    findRoot: () => root, restoreBookmarksForFileKey: vi.fn(),
  };
  return { file, ref, context, pending, syncLspDocument, setStatusMessage, finishProvider, failProvider,
    releaseCleanup: async () => {
      pending.didCloseCompleted = true;
      const outcome = await new WorkspaceResourceRecoveryCoordinator("reopen").executeResourceCleanup(file.key, {});
      finishCleanup(outcome);
    } };
}

it("waits for prior cleanup, then completes the visible reopen without awaiting SDK/LSP startup", async () => {
  const owner = reopening();
  let opened = false;
  const result = createOpenFile(owner.context)(owner.ref).then((value) => { opened = true; return value; });
  await Promise.resolve();
  expect(opened).toBe(false);
  expect(owner.syncLspDocument).not.toHaveBeenCalled();
  owner.context.openFilesRef.current[owner.file.key] = { ...owner.file, text: "class Main { int newer = 9; }" };
  await owner.releaseCleanup();
  expect(await result).toEqual({ canonicalFileKey: owner.file.key, groupId: "primary", error: null });
  expect(owner.syncLspDocument).toHaveBeenCalledWith(expect.objectContaining({ text: "class Main { int newer = 9; }" }), "open");
  expect(owner.context.openFilesRef.current[owner.file.key].dirty).toBe(true);
  owner.finishProvider();
});

it("does not resume a superseded reopen after cleanup finishes", async () => {
  const owner = reopening();
  let current = true;
  const result = createOpenFile(owner.context)(owner.ref, { isCurrent: () => current });
  current = false;
  await owner.releaseCleanup();
  expect(await result).toBeNull();
  expect(owner.syncLspDocument).not.toHaveBeenCalled();
  owner.finishProvider();
});

it("surfaces a background startup rejection without discarding the reopened dirty buffer", async () => {
  const owner = reopening();
  const result = createOpenFile(owner.context)(owner.ref);
  await owner.releaseCleanup();
  expect(await result).not.toBeNull();
  owner.failProvider(new Error("SDK launch failed"));
  await Promise.resolve();
  expect(owner.setStatusMessage).toHaveBeenCalledWith("SDK launch failed");
  expect(owner.context.openFilesRef.current[owner.file.key]).toEqual(owner.file);
});
