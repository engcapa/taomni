import { describe, expect, it, vi } from "vitest";
import type { ModuleNetworkConfig } from "../lib/ipc/plugin";
import { createModuleNetworkStore } from "./moduleNetworkStore";

const initial: ModuleNetworkConfig = {
  mode: "app", custom: { enabled: false, mode: "manual", session_id: "", kind: "http", host: "", port: 3128, username: "", password_ref: "" },
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

describe("module network settings ownership", () => {
  it("shares a pending load and prevents it replacing a newer saved choice", async () => {
    const pending = deferred<ModuleNetworkConfig>();
    const adapter = { load: vi.fn(() => pending.promise), save: vi.fn().mockResolvedValue(undefined) };
    const store = createModuleNetworkStore(adapter);
    const loading = store.getState().load();
    expect(store.getState().load()).toBe(loading);
    await store.getState().save({ ...initial, mode: "none" });
    pending.resolve(initial);
    await loading;
    expect(store.getState()).toMatchObject({ config: { mode: "none" }, loading: false, saving: false });
    expect(adapter.load).toHaveBeenCalledTimes(1);
  });

  it("serializes edits and does not publish an old failure over newer success", async () => {
    const first = deferred<void>();
    const adapter = { load: vi.fn().mockResolvedValue(initial), save: vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue(undefined) };
    const store = createModuleNetworkStore(adapter);
    const saved = store.getState().save(initial).catch((error: Error) => error.message);
    const custom = { ...initial, mode: "custom" as const, custom: { ...initial.custom, host: "feature.proxy" } };
    const next = store.getState().save(custom);
    await Promise.resolve();
    expect(adapter.save).toHaveBeenCalledTimes(1);
    first.reject(new Error("old write failed"));
    await Promise.all([saved, next]);
    expect(adapter.save.mock.calls.map(([config]) => config)).toEqual([initial, custom]);
    expect(store.getState()).toMatchObject({ config: custom, saving: false, error: null });
  });

  it("retains an unsaved draft across view reopen and retries the exact choice", async () => {
    const adapter = { load: vi.fn().mockResolvedValue(initial), save: vi.fn().mockRejectedValueOnce(new Error("disk full")).mockResolvedValue(undefined) };
    const store = createModuleNetworkStore(adapter);
    await store.getState().load();
    const custom = { ...initial, mode: "custom" as const, custom: { ...initial.custom, host: "feature.proxy", password_ref: "vault:feature" } };
    await expect(store.getState().save(custom)).rejects.toThrow("disk full");
    await store.getState().load();
    expect(store.getState()).toMatchObject({ config: custom, error: "disk full", saving: false });
    expect(adapter.load).toHaveBeenCalledTimes(1);
    await store.getState().retry();
    expect(adapter.save).toHaveBeenLastCalledWith(custom);
    expect(store.getState().error).toBeNull();
  });

  it("can retry loading invalid native configuration without inventing defaults", async () => {
    const adapter = { load: vi.fn().mockRejectedValueOnce(new Error("invalid settings")).mockResolvedValue(initial), save: vi.fn() };
    const store = createModuleNetworkStore(adapter);
    await store.getState().load();
    expect(store.getState()).toMatchObject({ config: null, error: "invalid settings" });
    await store.getState().retry();
    expect(store.getState()).toMatchObject({ config: initial, error: null });
    expect(adapter.save).not.toHaveBeenCalled();
  });
});
