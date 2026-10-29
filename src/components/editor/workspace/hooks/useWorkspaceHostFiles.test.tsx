import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { selectCodeWorkspaceUi, useCodeWorkspaceStore } from "../../../../stores/codeWorkspaceStore";
import type { CodeWorkspaceFileRef } from "../../../../types";
import { fileKey, makeLoadingFile } from "../codeWorkspaceModel";
import type { WorkspaceHostIntegration } from "../workspaceHostIntegration";
import { useWorkspaceHostFiles } from "./useWorkspaceHostFiles";

const instanceId = "host-reconciliation";
const root = { id: "root", path: "/project", name: "project", kind: "folder" as const };
const refs: CodeWorkspaceFileRef[] = ["a.txt", "b.html"].map((path) => ({ kind: "root", rootId: root.id, path }));
const keys = refs.map(fileKey);
const ui = () => selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), instanceId);
const noop = () => undefined;

function host(active = 0): WorkspaceHostIntegration {
  return {
    active: true, editorVisible: true, leftToolAreaVisible: true, showEditorTabs: false,
    navigationItems: [], files: refs, activeFile: refs[active], canvasLayout: "single", paneFiles: [refs[active]],
    leftToolAreaHost: null, onActivateFile: noop, onOpenGitDiff: noop, onActivateToolWindow: noop,
    onLeftToolAreaChange: noop, registerFileMenu: noop, onSnapshot: vi.fn(), recoverDraft: () => null,
  };
}

function dependencies(request: WorkspaceHostIntegration): Parameters<typeof useWorkspaceHostFiles>[0] {
  return {
    host: request,
    session: {
      workspaceInstanceId: instanceId, mountedRef: { current: true }, workspaceUi: ui(), setStatusMessage: vi.fn(),
      bufferState: { openFilesRef: { current: ui().openFiles }, lspFilesRef: { current: {} } },
    },
    project: {
      projectTree: { roots: [root] },
      buffers: {
        setOpenFiles: (update) => useCodeWorkspaceStore.getState().updateOpenFiles(instanceId, update),
        flushPendingEditorText: vi.fn(),
      },
      recoveryState: {
        workspaceRecoveryEntries: [], pendingWorkspaceRecoveryKeysRef: { current: new Set() },
        setWorkspaceRecoveryEntries: vi.fn(), diskEffectLedgerEntries: [], setWorkspaceRecoveryOpen: vi.fn(),
      },
      lsp: { syncDocument: vi.fn(async () => undefined) },
    },
    files: { restoreReady: true, openFile: vi.fn(async (ref, options) => {
      if (options?.activate !== false) useCodeWorkspaceStore.getState().setActiveKey(instanceId, fileKey(ref));
      return { canonicalFileKey: fileKey(ref), groupId: "primary", error: null };
    }) },
    editing: { fileLifecycle: { closeFile: vi.fn(async () => undefined) } },
  };
}

beforeEach(() => {
  useCodeWorkspaceStore.setState({ byInstanceId: {} });
  const store = useCodeWorkspaceStore.getState();
  store.ensureInstance(instanceId);
  store.updateOpenFiles(instanceId, Object.fromEntries(refs.map((ref) => [fileKey(ref), {
    ...makeLoadingFile(ref, [root], []), loading: false, text: `contents of ${ref.path}`, savedText: `contents of ${ref.path}`,
  }])));
  store.updateEditorGroup(instanceId, "primary", (group) => ({ ...group, openOrder: keys, activeKey: keys[0] }));
});
afterEach(cleanup);

describe("workspace host request ownership", () => {
  it("publishes an already reconciled file list without another editor render or open", async () => {
    const request = host();
    const ports = dependencies(request);
    let renders = 0;
    renderHook(() => { renders++; useWorkspaceHostFiles(ports); });
    await act(async () => undefined);
    expect(request.onSnapshot).toHaveBeenCalledWith({ files: Object.values(ui().openFiles), activeFile: refs[0] });
    expect(ports.files.openFile).not.toHaveBeenCalled();
    expect(renders).toBe(1);
  });

  it("publishes the live activated buffer without rereading existing files", async () => {
    const request = host(1);
    const ports = dependencies(request);
    renderHook(() => useWorkspaceHostFiles(ports));
    await act(async () => undefined);
    expect(ports.files.openFile).toHaveBeenCalledTimes(1);
    expect(request.onSnapshot).toHaveBeenLastCalledWith({ files: Object.values(ui().openFiles), activeFile: refs[1] });
  });

  it("drops a superseded pending open and publishes only the newer request", async () => {
    const first = host(1);
    const ports = dependencies(first);
    let finish = () => {};
    const open = vi.mocked(ports.files.openFile);
    open.mockImplementationOnce(() => new Promise((resolve) => { finish = () => resolve(null); }));
    const { rerender } = renderHook(({ request }) => useWorkspaceHostFiles({ ...ports, host: request }), { initialProps: { request: first } });
    await act(async () => undefined);
    const latest = host(0);
    rerender({ request: latest });
    await act(async () => finish());
    expect(first.onSnapshot).not.toHaveBeenCalled();
    expect(latest.onSnapshot).toHaveBeenLastCalledWith({ files: Object.values(ui().openFiles), activeFile: refs[0] });
  });
});
