import { act, renderHook, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { SDK_REGISTRY_CHANGED_EVENT } from "../../../../../lib/editor/sdk";
import { useWorkspaceLspSession } from "../../useWorkspaceLspSession";
import { file, lspMocks, roots, status } from "./harness";

export function registerWorkspaceLspDemandCases() {
  it.each(["notes.txt", "events.log", "data.csv", "settings.json", "diagram.svg"])(
    "does not contact a provider while opening, saving or closing %s", async (path) => {
      const ordinary = { ...file, languagePath: path, path };
      const options = {
        workspaceInstanceId: "ordinary-lifecycle", roots,
        openFilesRef: { current: { [ordinary.key]: ordinary } },
        updateLspFiles: vi.fn(), onError: vi.fn(), autoDiscover: false,
      };
      const { result, unmount } = renderHook(() => useWorkspaceLspSession(options));
      await act(async () => {
        await result.current.syncDocument(ordinary, "open");
        await result.current.saveDocument(ordinary, ordinary.text);
        await result.current.closeDocumentAndWait(ordinary);
      });
      expect(lspMocks.lspOpenDocument).not.toHaveBeenCalled();
      expect(lspMocks.lspSaveDocument).not.toHaveBeenCalled();
      expect(lspMocks.lspCloseDocument).not.toHaveBeenCalled();
      expect(lspMocks.lspGetDiagnostics).not.toHaveBeenCalled();
      expect(lspMocks.lspDetectServers).not.toHaveBeenCalled();
      unmount();
    },
  );
  it("does not discover SDK-dependent providers for a visible explorer without source demand", async () => {
    const options = {
      workspaceInstanceId: "ordinary-explorer",
      roots,
      openFilesRef: { current: {} },
      updateLspFiles: vi.fn(),
      onError: vi.fn(),
      visible: true,
      autoDiscover: false,
    };
    const { rerender, unmount } = renderHook((next) => useWorkspaceLspSession(next), { initialProps: options });
    await act(async () => {});
    rerender({ ...options, roots: [...roots, { ...roots[0], id: "docs", path: "/documents" }] });
    await act(async () => {});
    expect(lspMocks.lspDetectServers).not.toHaveBeenCalled();
    expect(lspMocks.lspDiscoverJavaBundles).not.toHaveBeenCalled();
    expect(lspMocks.lspSetJavaHome).not.toHaveBeenCalled();
    unmount();
  });

  it("starts discovery when a source arrives and preserves explicit refresh without a source", async () => {
    const options = {
      workspaceInstanceId: "source-demand",
      roots,
      openFilesRef: { current: { [file.key]: file } },
      updateLspFiles: vi.fn(),
      onError: vi.fn(),
      autoDiscover: false,
    };
    const { result, rerender, unmount } = renderHook((autoDiscover) => (
      useWorkspaceLspSession({ ...options, autoDiscover })
    ), { initialProps: false });
    await act(async () => {});
    expect(lspMocks.lspDetectServers).not.toHaveBeenCalled();
    rerender(true);
    await waitFor(() => expect(lspMocks.lspDetectServers).toHaveBeenCalledTimes(1));
    rerender(false);
    await act(async () => { await result.current.refreshServerStatuses(true); });
    expect(lspMocks.lspDetectServers).toHaveBeenCalledTimes(2);
    unmount();
  });

  it("rejects a late automatic discovery after the last source demand disappears", async () => {
    let finish: (value: unknown) => void = () => {};
    lspMocks.lspDetectServers.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const { result, rerender, unmount } = renderHook((autoDiscover) => useWorkspaceLspSession({
      workspaceInstanceId: "late-discovery",
      roots,
      openFilesRef: { current: {} },
      updateLspFiles: vi.fn(),
      onError: vi.fn(),
      autoDiscover,
    }), { initialProps: true });
    await waitFor(() => expect(lspMocks.lspDetectServers).toHaveBeenCalledTimes(1));
    rerender(false);
    await act(async () => { finish([{ presetId: "java", active: true }]); });
    expect(result.current.serverStatuses).toEqual([]);
    unmount();
  });

  it("keeps the file watcher when SDK settings change without starting unused discovery", async () => {
    const options = {
      workspaceInstanceId: "idle-sdk-change",
      roots,
      openFilesRef: { current: {} },
      updateLspFiles: vi.fn(),
      onError: vi.fn(),
      autoDiscover: false,
    };
    const { unmount } = renderHook(() => useWorkspaceLspSession(options));
    await act(async () => { window.dispatchEvent(new Event(SDK_REGISTRY_CHANGED_EVENT)); });
    expect(lspMocks.lspStopWorkspace).toHaveBeenCalledWith("idle-sdk-change", true);
    expect(lspMocks.lspDetectServers).not.toHaveBeenCalled();
    expect(lspMocks.lspDiscoverJavaBundles).not.toHaveBeenCalled();
    unmount();
  });

  it("syncs the latest source independently of a slow all-provider discovery", async () => {
    let finish: (value: never[]) => void = () => {};
    lspMocks.lspDiscoverJavaBundles.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const source = { ...file, text: "const latest = 9;", dirty: true };
    const options = {
      workspaceInstanceId: "background-discovery",
      roots,
      openFilesRef: { current: { [source.key]: source } },
      updateLspFiles: vi.fn(),
      onError: vi.fn(),
      autoDiscover: true,
    };
    const { result, unmount } = renderHook(() => useWorkspaceLspSession(options));
    await waitFor(() => expect(lspMocks.lspDiscoverJavaBundles).toHaveBeenCalledTimes(1));
    await act(async () => { await result.current.syncDocument(source, "open"); });
    expect(lspMocks.lspOpenDocument).toHaveBeenCalledWith(expect.anything(), source.text, 1);
    expect(lspMocks.lspDetectServers).not.toHaveBeenCalled();
    await act(async () => { finish([]); });
    await waitFor(() => expect(lspMocks.lspDetectServers).toHaveBeenCalledTimes(1));
    expect(lspMocks.lspOpenDocument).toHaveResolvedWith(status);
    unmount();
  });
}
