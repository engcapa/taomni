import { describe, expect, it, vi } from "vitest";
import type { ModuleDownloadInfo, ModuleDownloadListing } from "../lib/ipc/plugin";
import { createModuleDownloadStore } from "./moduleDownloadStore";

const task: ModuleDownloadInfo = {
  id: "hello-package", completedPath: "/modules/hello.pkg",
  progress: { phase: "downloading", revision: 3, downloaded: 4096, total: 8192 },
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function setup() {
  const adapter = {
    list: vi.fn().mockResolvedValue({ tasks: [task], recoveryErrors: [] }),
    cancel: vi.fn().mockResolvedValue({ ...task.progress, phase: "cancelled", revision: 4 }),
    resume: vi.fn().mockResolvedValue({ ...task.progress, phase: "connecting", revision: 0 }),
    forget: vi.fn().mockResolvedValue(undefined),
  };
  return { adapter, store: createModuleDownloadStore(adapter) };
}

describe("module download projection", () => {
  it("discovers recovered jobs without resuming and retains them after a listing failure", async () => {
    const { adapter, store } = setup();
    adapter.list.mockResolvedValueOnce({ tasks: [task], recoveryErrors: ["damaged job record"] });
    await store.getState().refresh();
    expect(store.getState()).toMatchObject({ tasks: [task], recoveryErrors: ["damaged job record"], loaded: true });
    expect(adapter.resume).not.toHaveBeenCalled();
    adapter.list.mockRejectedValueOnce(new Error("IPC unavailable"));
    await store.getState().refresh();
    expect(store.getState()).toMatchObject({ tasks: [task], error: "IPC unavailable" });
    await store.getState().refresh();
    expect(store.getState().error).toBeNull();
  });

  it("shares a pending listing without replacing a completed cancel with stale active progress", async () => {
    const { adapter, store } = setup();
    await store.getState().refresh();
    const listing = deferred<ModuleDownloadListing>();
    adapter.list.mockReturnValueOnce(listing.promise);
    const refresh = store.getState().refresh();
    expect(store.getState().refresh()).toBe(refresh);
    await store.getState().cancel(task.id);
    listing.resolve({ tasks: [task], recoveryErrors: [] });
    await refresh;
    expect(store.getState().tasks[0].progress.phase).toBe("cancelled");
  });

  it("keeps one pending operation across subscribers and reports failure without inventing cancellation", async () => {
    const { adapter, store } = setup();
    await store.getState().refresh();
    const pending = deferred<typeof task.progress>();
    adapter.cancel.mockReturnValueOnce(pending.promise);
    const first = store.getState().cancel(task.id);
    expect(store.getState().cancel(task.id)).toBe(first);
    expect(store.getState().busy[task.id]).toBe(true);
    expect(store.getState().tasks[0].progress.phase).toBe("downloading");
    pending.resolve({ ...task.progress, phase: "cancelled" });
    await first;
    expect(adapter.cancel).toHaveBeenCalledExactlyOnceWith(task.id);
    adapter.resume.mockRejectedValueOnce(new Error("unlock proxy credential"));
    await store.getState().resume(task.id);
    expect(store.getState().errors[task.id]).toBe("unlock proxy credential");
    expect(store.getState().tasks[0].progress.phase).toBe("cancelled");
    await store.getState().resume(task.id);
    expect(store.getState().tasks[0].progress.phase).toBe("connecting");
    expect(store.getState().errors[task.id]).toBe("");
  });

  it("does not resurrect a forgotten task from a listing already in flight", async () => {
    const { adapter, store } = setup();
    await store.getState().refresh();
    const pending = deferred<ModuleDownloadListing>();
    adapter.list.mockReturnValueOnce(pending.promise);
    const refresh = store.getState().refresh();
    await store.getState().forget(task.id);
    pending.resolve({ tasks: [task], recoveryErrors: [] });
    await refresh;
    expect(store.getState().tasks).toEqual([]);
    expect(adapter.forget).toHaveBeenCalledExactlyOnceWith(task.id);
  });
});
