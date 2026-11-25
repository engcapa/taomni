import { describe, expect, it, vi } from "vitest";
import type { PluginRecord } from "../lib/pluginRegistry";
import { deferred, moduleRecord } from "../lib/tests/pluginFrontendHarness";
import { createPluginFrontendStore } from "./pluginFrontendStore";

describe("WebView module registry ownership", () => {
  it("rejects an older enabled snapshot after a newer disable has completed", async () => {
    const first = deferred<PluginRecord[]>();
    const second = deferred<PluginRecord[]>();
    const list = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const store = createPluginFrontendStore({ list, subscribe: async () => () => undefined });
    const old = store.getState().refresh();
    const current = store.getState().refresh("hello-plugin");
    expect(store.getState().pending.has("hello-plugin")).toBe(true);
    second.resolve([moduleRecord("disabled")]);
    await current;
    first.resolve([moduleRecord()]);
    await old;
    expect(store.getState().records["hello-plugin"].lifecycle).toBe("disabled");
    expect(store.getState().pending.size).toBe(0);
  });

  it("immediately revokes the affected view and fails closed until a retry succeeds", async () => {
    const list = vi.fn().mockResolvedValue([moduleRecord()]);
    const store = createPluginFrontendStore({ list, subscribe: async () => () => undefined });
    await store.getState().refresh();
    const held = deferred<PluginRecord[]>();
    list.mockReturnValueOnce(held.promise);
    const refresh = store.getState().refresh("hello-plugin");
    expect(store.getState().pending.has("hello-plugin")).toBe(true);
    held.reject(new Error("registry unavailable"));
    await refresh;
    expect(store.getState().status).toBe("failed");
    expect(store.getState().error).toBe("registry unavailable");
    await store.getState().refresh("hello-plugin");
    expect(store.getState().status).toBe("ready");
    expect(store.getState().pending.size).toBe(0);
    expect(store.getState().epochs["hello-plugin"]).toBe(2);
  });

  it("invalid metadata cannot authorize a frontend and duplicate owners reject the snapshot", async () => {
    const record = moduleRecord();
    record.manifest!.entry.frontend = "frontend/../host";
    const list = vi.fn().mockResolvedValueOnce([record]).mockResolvedValueOnce([moduleRecord(), moduleRecord()]);
    const store = createPluginFrontendStore({ list, subscribe: async () => () => undefined });
    await store.getState().refresh();
    expect(store.getState().records["hello-plugin"]).toMatchObject({ lifecycle: "disabled", manifest: null });
    await store.getState().refresh();
    expect(store.getState().status).toBe("failed");
    expect(store.getState().error).toContain("Duplicate module");
  });

  it("shares one native subscription and closes a late listener after StrictMode cleanup", async () => {
    const subscription = deferred<() => void>();
    const stop = vi.fn();
    const list = vi.fn().mockResolvedValue([]);
    const subscribe = vi.fn().mockReturnValue(subscription.promise);
    const store = createPluginFrontendStore({ list, subscribe });
    const detachFirst = store.getState().attach();
    const detachSecond = store.getState().attach();
    expect(subscribe).toHaveBeenCalledTimes(1);
    detachFirst();
    detachFirst();
    expect(stop).not.toHaveBeenCalled();
    detachSecond();
    subscription.resolve(stop);
    await subscription.promise;
    await Promise.resolve();
    expect(stop).toHaveBeenCalledTimes(1);
    expect(list).not.toHaveBeenCalled();
  });

  it("installs invalidation before reading and leaves unrelated module identities stable", async () => {
    let invalidate!: (slug?: string) => void;
    const list = vi.fn().mockResolvedValue([moduleRecord()]);
    const stop = vi.fn();
    const store = createPluginFrontendStore({ list, subscribe: async (callback) => { invalidate = callback; return stop; } });
    const detach = store.getState().attach();
    await Promise.resolve();
    await Promise.resolve();
    const previous = store.getState().records["hello-plugin"];
    expect(previous?.lifecycle).toBe("enabled");
    invalidate("another-module");
    await Promise.resolve();
    expect(store.getState().records["hello-plugin"]).toBe(previous);
    expect(store.getState().epochs["hello-plugin"]).toBeUndefined();
    detach();
    expect(stop).toHaveBeenCalledTimes(1);
  });
});
